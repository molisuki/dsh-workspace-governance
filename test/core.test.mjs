import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {countCharacters,effectivePolicy,createRegistry,scanWorkspace,patchScanDocument,safeDocument,DEFAULT_POLICY,isProtectedDocument,validatePolicy,effectiveCapacityMode} from '../lib/core.js';
import {collectRemediationTasks} from '../lib/remediation-queue.js';
test('default Markdown count includes Unicode whitespace and Markdown syntax',()=>{
 const source=' A 你好 \n B ';
 assert.equal(countCharacters(source),Array.from(source).length);
 assert.equal(countCharacters(source),10);
 assert.equal(countCharacters(source,'text'),4);
 assert.equal(countCharacters('A👨‍👩‍👧‍👦'),8);
 const fence=String.fromCharCode(96).repeat(3);
 const fenced='intro\n'+fence+'\nhello\n'+fence+'\nend';
 assert.equal(countCharacters(fenced),Array.from(fenced).length);
 assert.equal(countCharacters(fenced,'text'),8);
});
test('nearest directory and file override',()=>{
 const policy={defaultFileLimit:2400,warningRatio:0.8,directories:{docs:{fileLimit:900},'docs/deep':{fileLimit:400}},files:{'docs/deep/one.md':{fileLimit:100}}};
 assert.equal(effectivePolicy(policy,'docs/deep/one.md').fileLimit,100);
 assert.equal(effectivePolicy(policy,'docs/deep/two.md').fileLimit,400);
 assert.equal(effectivePolicy(policy,'else.md').fileLimit,2400);
 assert.equal(effectivePolicy(policy,'else.md').mode,'strict');
 policy.directories.docs.mode='text';
 assert.equal(effectivePolicy(policy,'docs/deep/two.md').mode,'text');
 policy.files['docs/deep/one.md'].mode='strict';
 assert.equal(effectivePolicy(policy,'docs/deep/one.md').mode,'strict');
});
test('canonical policy rejects retired fields and preserves explicit protection rules',()=>{
 const policy=structuredClone(DEFAULT_POLICY);
 policy.files['docs/references/literature-index.md']={fileLimit:100000,protected:true};
 policy.files['PLAN.md']={fileLimit:6000,mode:'strict'};
 policy.directories['docs/lead-reports']={fileLimit:300,mode:'strict'};
 policy.capacityMode='warning';
 assert.equal(effectiveCapacityMode(validatePolicy(policy)),'warning');
 assert.equal(effectivePolicy(policy,'PLAN.md').mode,'strict');
 assert.equal(effectivePolicy(policy,'docs/lead-reports/nested.md').mode,'strict');
 assert.equal(isProtectedDocument(policy,'docs/references/literature-index.md'),true);
 assert.equal(isProtectedDocument(policy,'docs/references/README.md'),false);
 assert.throws(()=>validatePolicy({...policy,obsoleteSetting:true}),/Unknown workspace policy field/);
});

test('full and incremental Markdown scans use exact source length unless prose mode is explicit',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-count-source-'));
 try{
  await fs.mkdir(path.join(root,'docs'));
  const relative='docs/sample.md',target=path.join(root,'docs','sample.md');
  const original='  # 标题 \n\n'+String.fromCharCode(96).repeat(3)+'\n a b \n'+String.fromCharCode(96).repeat(3)+'\n';
  await fs.writeFile(target,original);
  const workspace={id:'exact-source',name:'repo',root,policy:{
   ...structuredClone(DEFAULT_POLICY),capacityMode:'warning',aggregateLimit:200}};
  const first=await scanWorkspace(workspace);
  assert.equal(first.tree.chars,Array.from(original).length);
  assert.equal(first.tree.children[0].children[0].chars,Array.from(original).length);
  const revised=original+'  another line  \n';
  await fs.writeFile(target,revised);
  const patched=await patchScanDocument(workspace,first,relative);
  assert.equal(patched.tree.chars,Array.from(revised).length);
  assert.equal(patched.tree.children[0].children[0].chars,Array.from(revised).length);
  workspace.policy.files[relative]={mode:'text'};
  const prose=await scanWorkspace(workspace);
  assert.equal(prose.tree.children[0].children[0].chars,countCharacters(revised,'text'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('protected-document classification stays aligned between scans and queued tasks',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-protection-'));
 try{
  await fs.mkdir(path.join(root,'notes'));
  for(const name of ['AGENTS.md','notes/private.md','notes/index.md','notes/regular.md'])
   await fs.writeFile(path.join(root,name),'x'.repeat(90));
  const ws={id:'protection-case',root,name:'repo',policy:{
   ...structuredClone(DEFAULT_POLICY),defaultFileLimit:100,capacityMode:'warning',
    files:{'notes/private.md':{exempt:true},'notes/index.md':{protected:true}}}};
   const scan=await scanWorkspace(ws),tasks=collectRemediationTasks(ws,scan);
  const nodes=new Map();
  const walk=node=>{if(node.type==='file')nodes.set(node.path,node);for(const child of node.children??[])walk(child);};
  walk(scan.tree);
  const expected={'AGENTS.md':true,'notes/private.md':true,'notes/index.md':true,'notes/regular.md':false};
  for(const [name,protectedFlag] of Object.entries(expected)){
   assert.equal(isProtectedDocument(ws.policy,name),protectedFlag,name);
   assert.equal(nodes.get(name)?.protected,protectedFlag,'scan '+name);
   assert.equal(tasks.tasks.find(x=>x.path===name)?.protected,protectedFlag,'task '+name);
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('concurrent workspace registration is serialized and idempotent',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-register-race-'));
 try{
  const root=path.join(base,'repo');await fs.mkdir(root);
  const registry=await createRegistry(path.join(base,'state'));
  const entries=await Promise.all(Array.from({length:20},()=>registry.add(root)));
  assert.equal(new Set(entries.map(item=>item.id)).size,1);
  assert.equal(registry.snapshot().workspaces.length,1);
  const reopened=await createRegistry(path.join(base,'state'));
  assert.equal(reopened.snapshot().workspaces.length,1);
  await assert.rejects(registry.add(path.join(base,'missing')));
  const other=path.join(base,'other');await fs.mkdir(other);
  assert.equal((await registry.add(other)).root,other,'rejection must release the registration lock');
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('register scan threshold, persist and deny escape',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-test-'));
 try{
  const repo=path.join(root,'project');await fs.mkdir(path.join(repo,'docs'),{recursive:true});
  await fs.writeFile(path.join(repo,'docs','test.md'),'abcdefghijklmnopqrstuv');
  const registry=await createRegistry(path.join(root,'policies'));const workspace=await registry.add(repo);
  await registry.updateRule(workspace.id,'directories','docs',{fileLimit:10,aggregateLimit:15});
  const report=await scanWorkspace(registry.find(workspace.id));
  assert.equal(report.scanned,1);
  assert.ok(report.issues.some(x=>x.type==='overflow'));
  assert.ok(report.issues.some(x=>x.type==='aggregate-overflow'));
  await assert.rejects(safeDocument(workspace,'../settings.json'));
  const restored=await createRegistry(path.join(root,'policies'));
  assert.equal(restored.find(workspace.id).policy.directories.docs.fileLimit,10);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
