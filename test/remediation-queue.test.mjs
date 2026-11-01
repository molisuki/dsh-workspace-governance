import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {collectRemediationTasks,createRemediationQueue} from '../lib/remediation-queue.js';
import {createRegistry,scanWorkspace} from '../lib/core.js';
import {apply} from '../lib/index.js';

async function fixture(){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-remediation-'));
 const root=path.join(tmp,'repo');await fs.mkdir(root);
 const registry=await createRegistry(path.join(tmp,'policies'));
 const ws=await registry.add(root);
 await registry.updateDefaults(ws.id,{defaultFileLimit:100,warningRatio:.8,optimizationPercent:10,aggregateLimit:null},1);
 await registry.updateCapacityMode(ws.id,'warning',2);
 return {tmp,root,registry,id:ws.id,
  workspace:()=>registry.find(ws.id),
  cleanup:()=>fs.rm(tmp,{recursive:true,force:true})};
}

test('scan projection finds warnings, over-limit values, and exact threshold-minus-margin targets',async()=>{
 const f=await fixture();
 try{
  await fs.mkdir(path.join(f.root,'docs'));
  await fs.writeFile(path.join(f.root,'docs','warn.md'),'x'.repeat(90));
  await fs.writeFile(path.join(f.root,'docs','over.md'),'x'.repeat(105));
  await fs.writeFile(path.join(f.root,'docs','safe.md'),'x'.repeat(60));
  const q=collectRemediationTasks(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(q.verified,true);
  assert.equal(q.total,2);
  assert.deepEqual(q.tasks.map(t=>t.path),['docs/over.md','docs/warn.md']);
  assert.deepEqual(q.tasks.map(t=>[t.targetPercent,t.targetChars,t.requiredReduction]),[[70,70,35],[70,70,20]]);
  const ids=q.tasks.map(t=>t.id);
  const again=collectRemediationTasks(f.workspace(),await scanWorkspace(f.workspace()));
  assert.deepEqual(again.tasks.map(t=>t.id),ids,'stable ids depend on workspace, kind and path, not scan time');
  await f.registry.updateCapacityMode(f.id,'overflow',3);
  const onlyOver=collectRemediationTasks(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(onlyOver.total,1);
  assert.deepEqual(onlyOver.tasks.map(t=>[t.path,t.targetPercent,t.requiredReduction]),[['docs/over.md',90,15]]);
  await f.registry.updateCapacityMode(f.id,'off',4);
  const off=collectRemediationTasks(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(off.total,0);
 }finally{await f.cleanup();}
});

test('directory aggregate constraints appear independently from file warnings and remain covered',async()=>{
 const f=await fixture();
 try{
  await fs.mkdir(path.join(f.root,'docs'));
  await fs.writeFile(path.join(f.root,'docs','one.md'),'x'.repeat(40));
  await fs.writeFile(path.join(f.root,'docs','two.md'),'x'.repeat(40));
  await f.registry.updateRule(f.id,'directories','docs',{aggregateLimit:90},3);
  const q=collectRemediationTasks(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(q.total,1);
  assert.equal(q.tasks[0].kind,'directory');
  assert.equal(q.tasks[0].path,'docs');
  assert.equal(q.tasks[0].targetChars,63);
  assert.equal(q.tasks[0].requiredReduction,17);
 }finally{await f.cleanup();}
});

test('persisted task episode survives restart and is invalidated only after verified resolution',async()=>{
 const f=await fixture();
 const storage=path.join(f.tmp,'remediation');
 try{
  const document=path.join(f.root,'note.md');await fs.writeFile(document,'x'.repeat(90));
  const q=createRemediationQueue({directory:storage});
  const first=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(first.total,1);
  assert.equal(first.verified,true);
   const task=first.tasks[0];
   assert.ok(task.episodeId);
   assert.equal((await q.list(f.id)).total,1);  const restarted=createRemediationQueue({directory:storage});
  const stale=await restarted.list(f.id);
  assert.equal(stale.verified,false);
  assert.equal(stale.status,'stale');
  assert.equal(stale.total,1);
  const confirmed=await restarted.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(confirmed.verified,true);
   assert.equal(confirmed.tasks[0].episodeId,task.episodeId);
   await fs.writeFile(document,'y'.repeat(90));
   const sameLengthChanged=await restarted.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
   assert.equal(sameLengthChanged.tasks[0].episodeId,task.episodeId);  await fs.writeFile(document,'x'.repeat(91));
  const changed=await restarted.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
   assert.equal(changed.tasks[0].episodeId,task.episodeId);  const partial={...await scanWorkspace(f.workspace()),truncated:true};
  const unverified=await restarted.reconcile(f.workspace(),partial);
  assert.equal(unverified.verified,false);
  assert.equal(unverified.total,1,'partial scan must not falsely clear a pending task');
  await fs.writeFile(document,'x'.repeat(60));
  const cleared=await restarted.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(cleared.total,0);
  assert.equal(cleared.verified,true);
  assert.equal((await restarted.list(f.id)).tasks.length,0);
 }finally{await f.cleanup();}
});

test('HTTP scan reconciles file written through arbitrary filesystem API without needing write/edit hook',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-remediation-api-'));
 const root=path.join(temp,'repo'),state=path.join(temp,'policies');
 await fs.mkdir(root);let route,dispose;
 const ctx={logger:{warn(){},error(){}},
  webServer:{register(opt){route=opt.handler;return ()=>{};}},
  workingDirectory:{get:()=>root},on(){},effect(fn){dispose=fn();}};
 apply(ctx,{stateDirectory:state});
 const req=async(method,where,body)=>{
  const stream=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
  stream.method=method;stream.url='/api/dsh-workspace-governance'+where;
  stream.headers={host:'localhost:19000',...(method==='GET'?{}:{'x-wg-request':'1'})};
  let status,payload;await route(stream,{writeHead(v){status=v;},end(json){payload=JSON.parse(json);}});
  return {status,...payload};
 };
 try{
  const ws=(await req('POST','/workspaces',{root})).workspace;
  assert.equal((await req('PUT','/defaults',{id:ws.id,defaultFileLimit:100,warningRatio:.8,optimizationPercent:10,
   aggregateLimit:null,expectedVersion:1})).status,200);
  assert.equal((await req('PUT','/mode',{id:ws.id,mode:'warning',expectedVersion:2})).status,200);
  await fs.writeFile(path.join(root,'external.md'),'x'.repeat(93));
  let automaticallyDetected=false;
  for(let attempt=0;attempt<100;attempt++){
   const snapshot=await req('GET','/remediation?id='+ws.id);
   if(snapshot.remediation.verified&&snapshot.remediation.total===1){automaticallyDetected=true;break;}
   await new Promise(resolve=>setTimeout(resolve,35));
  }
  assert.equal(automaticallyDetected,true,'watcher scan detects external writes without native write/edit interception');
  assert.equal((await req('POST','/scan',{id:ws.id})).status,200);
  const one=await req('GET','/remediation?id='+ws.id);
  assert.equal(one.remediation.verified,true);
  assert.equal(one.remediation.total,1);
  assert.equal(one.remediation.tasks[0].path,'external.md');
  assert.equal(one.remediation.tasks[0].targetPercent,70);
   await fs.writeFile(path.join(root,'external.md'),'x'.repeat(45));
  await req('POST','/scan',{id:ws.id});
  assert.equal((await req('GET','/remediation?id='+ws.id)).remediation.total,0);
  assert.equal((await req('GET','/remediation?id=notfound')).status,404);
 }finally{dispose?.();await fs.rm(temp,{recursive:true,force:true});}
});
