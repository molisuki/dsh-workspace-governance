import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCapacityIndex} from '../lib/capacity-index.js';
import {scanWorkspace,patchScanDocument,createRegistry} from '../lib/core.js';

test('one scan projection serves cached readers; file events patch, policy changes and uncertain structure fully rescan',async()=>{
 let full=0,patched=0;
 const ws={id:'a',policy:{version:1}};
 const reader=async()=>({truncated:false,issues:[],workspaceId:'a',policyVersion:ws.policy.version,
  tree:{path:'',name:'repo',type:'folder',chars:10,children:[]} ,fingerprint:'full-'+(++full)});
 const patch=async(w,previous,relative)=>{patched++;return {...previous,
  tree:{...previous.tree,chars:7},fingerprint:'patch-'+relative};};
 const index=createCapacityIndex({scan:reader,patch});
 const first=await index.get(ws);
 for(let i=0;i<5;i++)assert.strictEqual(await index.get(ws),first);
 assert.equal(full,1,'UI polling must not rescan disk');
 index.markDirty(ws.id,'docs/file.md');
 const changed=await index.get(ws);
 assert.equal(changed.tree.chars,7);
 assert.equal(full,1);
 assert.equal(patched,1);
 assert.strictEqual(await index.get(ws),changed);
 ws.policy.version=2;
 await index.get(ws);
 assert.equal(full,2);
 index.invalidate(ws.id);
 await index.get(ws);
 assert.equal(full,3);
 await index.get(ws,{force:true});
 assert.equal(full,4);
 index.forget(ws.id);
 await index.get(ws);
 assert.equal(full,5);
});

test('mid-scan events invalidate the generation; no outdated result is considered current',async()=>{
 let runs=0,release;
 const ws={id:'a',policy:{version:1}};
 const index=createCapacityIndex({scan:async()=>{
  runs++;
  if(runs===1)await new Promise(resolve=>{release=resolve;});
  return {workspaceId:'a',policyVersion:1,truncated:false,issues:[],fingerprint:String(runs),tree:{path:'',type:'folder'}};
 }});
 const pending=index.get(ws);
 index.markDirty(ws.id,'note.md');
 release();
 const final=await pending;
 assert.equal(runs,2);
 assert.equal(final.fingerprint,'2');
 assert.equal(index.isCurrent(ws.id,final),true);
});

test('unverified snapshots are cheap to display but never trusted; forced scans repair the state',async()=>{
 let n=0;
 const index=createCapacityIndex({scan:async()=>{
  n++;
  return {truncated:n===1,issues:n===2?[{type:'oversized-document',path:'a.md'}]:[],
    tree:{path:'',name:'repo',type:'folder',chars:0,children:[]}};
 }});
 const ws={id:'one',policy:{version:1}};
 const partial=await index.get(ws);
 assert.equal(index.isCurrent(ws.id,partial),false);
 assert.strictEqual(await index.get(ws),partial,'ordinary refresh must not repeatedly scan incomplete content');
 assert.equal(n,1);
 const unreadable=await index.get(ws,{force:true});
 assert.equal(index.isCurrent(ws.id,unreadable),false);
 assert.equal(n,2);
 const trusted=await index.get(ws,{force:true});
 assert.equal(index.isCurrent(ws.id,trusted),true);
 assert.strictEqual(await index.get(ws),trusted);
 assert.equal(n,3);
 assert.equal(index.size(),1);
});

test('incremental Markdown edit/add/delete matches complete scan for content, counters, duplicate issues and ancestor budgets',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-incremental-'));
 try{
  const root=path.join(tmp,'repo');
  await fs.mkdir(path.join(root,'docs'),{recursive:true});
  const registry=await createRegistry(path.join(tmp,'policies'));
  const ws=await registry.add(root);
  await registry.updateDefaults(ws.id,{defaultFileLimit:100,warningRatio:.8,aggregateLimit:140},1);
  await registry.updateRule(ws.id,'directories','docs',{aggregateLimit:110},2);
  const actual=registry.find(ws.id);
  const a=path.join(root,'docs','a.md'),b=path.join(root,'docs','b.md');
  await fs.writeFile(a,'a'.repeat(90));
  await fs.writeFile(b,'b'.repeat(40));
  let snapshot=await scanWorkspace(actual);
  const cases=[
   async()=>{await fs.writeFile(a,'a'.repeat(55));return 'docs/a.md';},
   async()=>{await fs.writeFile(b,'b'.repeat(120));return 'docs/b.md';},
   async()=>{await fs.writeFile(path.join(root,'docs','new.md'),'z'.repeat(18));return 'docs/new.md';},
   async()=>{await fs.unlink(b);return 'docs/b.md';},
  ];
  const normalize=scan=>({tree:scan.tree,issues:[...scan.issues].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
   scanned:scan.scanned,truncated:scan.truncated});
  for(const change of cases){
   const relative=await change();
   snapshot=await patchScanDocument(actual,snapshot,relative);
   assert.ok(snapshot,'known Markdown paths should be incrementally supported');
   const baseline=await scanWorkspace(actual);
   assert.deepEqual(normalize(snapshot),normalize(baseline),relative);
  }
  assert.equal(await patchScanDocument(actual,snapshot,'docs/unknown/new.md'),null,
   'new directory requires full scan');
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
