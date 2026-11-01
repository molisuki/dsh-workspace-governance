import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRegistry,effectivePolicy,effectiveDirectoryPolicy,scanWorkspace,inspectLengthMetrics} from '../lib/core.js';

test('concrete directory and file limits shown without an unresolved inheritance placeholder',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'wg-explicit-'));
 try{
  const root=path.join(home,'project');await fs.mkdir(path.join(root,'docs','deep'),{recursive:true});
  await fs.writeFile(path.join(root,'docs','deep','one.md'),'hello');
  const registry=await createRegistry(path.join(home,'policies')),ws=await registry.add(root);
  const id=ws.id;
  await registry.updateRule(id,'directories','docs',{fileLimit:900,aggregateLimit:1200},1);
  const scan=await scanWorkspace(registry.find(id));
  const docs=scan.tree.children.find(x=>x.name==='docs');
  const deep=docs.children.find(x=>x.name==='deep');
  const file=deep.children.find(x=>x.name==='one.md');
  assert.equal(scan.tree.fileLimit,2400);
  assert.equal(docs.fileLimit,900);
  assert.equal(docs.aggregateLimit,1200);
  assert.equal(deep.fileLimit,900);
  assert.equal(file.fileLimit,900);
  assert.equal(effectiveDirectoryPolicy(registry.find(id).policy,'docs/deep').fileLimit,900);
  assert.equal(effectivePolicy(registry.find(id).policy,'docs/deep/one.md').fileLimit,900);
  await registry.updateRule(id,'files','docs/deep/one.md',{fileLimit:333},2);
  const fresh=await scanWorkspace(registry.find(id));
  assert.equal(fresh.tree.children[0].children[0].children[0].fileLimit,333);
  await assert.rejects(registry.updateRule(id,'files','docs/deep/one.md',{fileLimit:999},2),/Stale version/);
  assert.equal(registry.find(id).policy.files['docs/deep/one.md'].fileLimit,333);
  await registry.updateRule(id,'directories','docs',{fileLimit:700,aggregateLimit:null},3);
  assert.equal(effectiveDirectoryPolicy(registry.find(id).policy,'docs').aggregateLimit,null);
  const restore=await createRegistry(path.join(home,'policies'));
  assert.equal(restore.find(id).policy.directories.docs.fileLimit,700);
  assert.equal(restore.find(id).policy.files['docs/deep/one.md'].fileLimit,333);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('editing workspace defaults is isolated and validates percentage and version',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'wg-defaults-'));
 try{
  for(const d of ['one','two'])await fs.mkdir(path.join(home,d));
  const registry=await createRegistry(path.join(home,'policies'));
  const one=await registry.add(path.join(home,'one')),two=await registry.add(path.join(home,'two'));
  const result=await registry.updateDefaults(one.id,{defaultFileLimit:5100,warningRatio:0.65},1);
  assert.equal(result.version,2);
  assert.equal(result.defaultFileLimit,5100);
  assert.equal(registry.find(two.id).policy.defaultFileLimit,2400);
  await assert.rejects(registry.updateDefaults(one.id,{defaultFileLimit:-1,warningRatio:0.2},2),/Invalid/);
  await assert.rejects(registry.updateDefaults(one.id,{defaultFileLimit:5000,warningRatio:0.7},1),/Stale version/);
  assert.equal(registry.find(one.id).policy.defaultFileLimit,5100);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('README and PLAN inherit the same workspace-directory-file hierarchy',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'wg-unified-'));
 try{
  await fs.mkdir(path.join(home,'repo'));
  const registry=await createRegistry(path.join(home,'policies')),ws=await registry.add(path.join(home,'repo'));
   await registry.updateRule(ws.id,'directories','docs',{fileLimit:1800},1);
   await registry.updateRule(ws.id,'directories','docs/research',{fileLimit:1400},2);
   await registry.updateRule(ws.id,'files','PLAN.md',{fileLimit:5000},3);  const actual=registry.find(ws.id).policy;
  assert.deepEqual(effectivePolicy(actual,'README.md').fileLimit,2400);
  assert.deepEqual(effectivePolicy(actual,'docs/README.md').fileLimit,1800);
  assert.deepEqual(effectivePolicy(actual,'docs/research/README.md').fileLimit,1400);
  assert.deepEqual(effectivePolicy(actual,'PLAN.md').fileLimit,5000);
  assert.deepEqual(effectivePolicy(actual,'docs/PLAN.md').fileLimit,1800);
  assert.equal(inspectLengthMetrics(actual,'docs/references/literature-index.md','x'.repeat(1801))[0].limit,1800);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});