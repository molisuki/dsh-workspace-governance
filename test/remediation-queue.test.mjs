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

test('serialized receipt updates are idempotent, session-scoped and scan-verified',async()=>{
 const f=await fixture();
 try{
  await fs.writeFile(path.join(f.root,'one.md'),'x'.repeat(90));
  await fs.writeFile(path.join(f.root,'two.md'),'y'.repeat(95));
  const queue=createRemediationQueue({directory:path.join(f.tmp,'receipts')});
  const initial=await queue.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  const [one,two]=initial.tasks;
  const valid=task=>({id:task.id,episodeId:task.episodeId});
  assert.equal(await queue.recordDelivery(f.id,'lead',[valid(one),{id:two.id,episodeId:'incorrect'}]),1);
  assert.equal(await queue.recordDelivery(f.id,'lead',[valid(one)]),0);
  assert.equal(await queue.recordDelivery(f.id,'second',[valid(two)]),1);
  assert.equal(await queue.recordDelivery(f.id,'second',[valid(two)],{delivered:false}),1);
  assert.equal(await queue.recordDelivery(f.id,'second',[valid(two)],{delivered:false}),0);
  let current=await queue.list(f.id);
  assert.equal(current.tasks.find(task=>task.id===one.id).deliveredTo.lead,one.episodeId);
  assert.equal(current.tasks.find(task=>task.id===two.id).deliveredTo.second,undefined);
  await queue.reconcile(f.workspace(),{...await scanWorkspace(f.workspace()),truncated:true});
  assert.equal(await queue.recordDelivery(f.id,'lead',[valid(two)]),0);
  current=await queue.list(f.id);
  assert.equal(current.verified,false);
  assert.equal(current.tasks.find(task=>task.id===two.id).deliveredTo.lead,undefined);
 }finally{await f.cleanup();}
});

test('cancellation backlog is never silently truncated at task capacity',async()=>{
 const f=await fixture();
 try{
  await fs.writeFile(path.join(f.root,'note.md'),'x'.repeat(90));
  const q=createRemediationQueue({directory:path.join(f.tmp,'bounded'),maxTasks:1});
  const first=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  const task=first.tasks[0];
  for(const recipient of ['lead','reviewer']){
   assert.equal(await q.recordDelivery(f.id,recipient,[{id:task.id,episodeId:task.episodeId}]),1);
  }
  await f.registry.updateDefaults(f.id,{defaultFileLimit:200,warningRatio:.8,optimizationPercent:10},3);
  const updated=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(updated.tasks.length,0);
  assert.deepEqual(new Set(updated.cancellations.map(c=>c.recipient)),new Set(['lead','reviewer']));
  assert.equal(updated.cancellations.length,2,'two accepted recipients must survive task count cap');
 }finally{await f.cleanup();}
});

test('active task policy changes invalidate only changed targets and retain cancellation across further edits',async()=>{
 const f=await fixture();
 try{
  await fs.writeFile(path.join(f.root,'note.md'),'x'.repeat(90));
  const q=createRemediationQueue({directory:path.join(f.tmp,'revisions')});
  const first=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  const old=first.tasks[0];
  await q.recordDelivery(f.id,'lead',[{id:old.id,episodeId:old.episodeId}]);
  await f.registry.updateDefaults(f.id,{defaultFileLimit:100,warningRatio:.8,optimizationPercent:20},3);
  const changed=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(changed.total,1);
  assert.equal(changed.tasks[0].targetChars,60);
  assert.notEqual(changed.tasks[0].episodeId,old.episodeId);
  assert.equal(changed.tasks[0].deliveredTo.lead,undefined);
  assert.equal(changed.cancellations.length,1);
  assert.equal(changed.cancellations[0].previousTarget,70);
  await f.registry.updateDefaults(f.id,{defaultFileLimit:100,warningRatio:.8,optimizationPercent:15},4);
  const latest=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(latest.tasks[0].targetChars,65);
  assert.equal(latest.cancellations.length,1,'old accepted episode cancellation remains pending after another target update');
  const same=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.deepEqual(same.cancellations,latest.cancellations);
  await q.recordDelivery(f.id,'lead',[{id:latest.tasks[0].id,episodeId:latest.tasks[0].episodeId}]);
  await f.registry.updateDefaults(f.id,{defaultFileLimit:110,warningRatio:.8,optimizationPercent:15},5);
  const raised=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(raised.total,1,'still above warning threshold despite higher file limit');
  assert.equal(raised.tasks[0].limit,110);
  assert.equal(raised.tasks[0].targetChars,71);
  assert.notEqual(raised.tasks[0].episodeId,latest.tasks[0].episodeId);
  assert.deepEqual(new Set(raised.cancellations.map(item=>item.previousTarget)),new Set([70,65]));
  const sameGoal=await f.registry.updateSkillSettings(f.id,
    {mode:'embedded',customSkill:'spec',customPrompt:'abc',embeddedPrompt:'def'},6);
  assert.ok(sameGoal);
  const unchanged=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(unchanged.tasks[0].episodeId,raised.tasks[0].episodeId);
  assert.equal(unchanged.cancellations.length,2);
 }finally{await f.cleanup();}
});

test('removed directory tasks clear while saved directory rules remain independent',async()=>{
 const f=await fixture();
 try{
  await fs.mkdir(path.join(f.root,'docs'),{recursive:true});
  await fs.writeFile(path.join(f.root,'docs','note.md'),'x'.repeat(90));
  await f.registry.updateRule(f.id,'directories','docs',{fileLimit:80},3);
  const q=createRemediationQueue({directory:path.join(f.tmp,'directory')});
  const initial=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(initial.tasks.some(t=>t.path==='docs/note.md'),true);
  const original=initial.tasks.find(t=>t.path==='docs/note.md');
  await q.recordDelivery(f.id,'lead',[{id:original.id,episodeId:original.episodeId}]);
  await fs.rename(path.join(f.root,'docs'),path.join(f.root,'archive'));
  const moved=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(moved.tasks.some(t=>t.path==='docs/note.md'),false);
  assert.equal(moved.tasks.some(t=>t.path==='archive/note.md'),true);
  assert.equal(moved.cancellations.length,1,'delivered old-directory instruction must be cancelled');
  assert.equal(moved.cancellations[0].path,'docs/note.md');
  assert.equal(moved.cancellations[0].recipient,'lead');
  assert.equal(f.workspace().policy.directories.docs.fileLimit,80,'directory rule remains an explicit user policy');
  await fs.rm(path.join(f.root,'archive'),{recursive:true,force:true});
  const removed=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(removed.total,0);
  assert.equal(removed.cancellations.length,1,'pending old-path cancellation survives further topology changes');
  assert.equal(f.workspace().policy.directories.docs.fileLimit,80);
  await fs.mkdir(path.join(f.root,'docs'));
  await fs.writeFile(path.join(f.root,'docs','other.md'),'z'.repeat(90));
  const recreated=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(recreated.tasks[0].limit,80);
 }finally{await f.cleanup();}
});

test('policy increase cancels only previously delivered tasks, once per session',async()=>{
 const f=await fixture();
 const storage=path.join(f.tmp,'cancellation-queue');
 try{
  await fs.writeFile(path.join(f.root,'note.md'),'A'.repeat(90));
  const queue=createRemediationQueue({directory:storage});
  let current=await queue.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(current.total,1);
  const task=current.tasks[0];
  await queue.recordDelivery(f.id,'lead',[{id:task.id,episodeId:task.episodeId}]);
  await queue.recordDelivery(f.id,'second',[{id:task.id,episodeId:task.episodeId}]);
  await f.registry.updateDefaults(f.id,{defaultFileLimit:200,warningRatio:.8,optimizationPercent:10},3);
  current=await queue.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(current.total,0);
  assert.equal(current.cancellations.length,2);
  assert.deepEqual(new Set(current.cancellations.map(item=>item.recipient)),new Set(['lead','second']));
  assert.ok(current.cancellations.every(item=>item.current===90&&item.limit===200&&item.previousTarget===70));
  const repeat=await queue.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.deepEqual(repeat.cancellations,current.cancellations,'repeated scans must not create more cancellation notices');
  await f.registry.updateDefaults(f.id,{defaultFileLimit:250,warningRatio:.8,optimizationPercent:10},4);
  const latest=await queue.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.deepEqual(latest.cancellations.map(item=>item.id),repeat.cancellations.map(item=>item.id));
  assert.ok(latest.cancellations.every(item=>item.limit===250),'pending notice uses latest limit, not stale policy');
  const lead=latest.cancellations.filter(item=>item.recipient==='lead');
  assert.equal(await queue.recordCancellationDelivery(f.id,'lead',lead),1);
  assert.equal(await queue.recordCancellationDelivery(f.id,'lead',lead),0);
  const remaining=await queue.list(f.id);
  assert.deepEqual(remaining.cancellations.map(item=>item.recipient),['second']);
  const restarted=createRemediationQueue({directory:storage});
  const persisted=await restarted.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(persisted.cancellations.length,1);
  assert.equal(persisted.cancellations[0].recipient,'second');
  assert.equal(await restarted.recordCancellationDelivery(f.id,'second',persisted.cancellations),1);
  assert.equal((await restarted.reconcile(f.workspace(),await scanWorkspace(f.workspace()))).cancellations.length,0);
 }finally{await f.cleanup();}
});

test('no cancellation is created for an undelivered or merely edited task',async()=>{
 const f=await fixture();
 try{
  const file=path.join(f.root,'note.md');
  const q=createRemediationQueue({directory:path.join(f.tmp,'q')});
  await fs.writeFile(file,'x'.repeat(90));
  await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  await fs.writeFile(file,'y'.repeat(20));
  let cleared=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(cleared.cancellations.length,0);
  await fs.writeFile(file,'z'.repeat(90));
  const active=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  await q.recordDelivery(f.id,'lead',[{id:active.tasks[0].id,episodeId:active.tasks[0].episodeId}]);
  await fs.writeFile(file,'y'.repeat(20));
  cleared=await q.reconcile(f.workspace(),await scanWorkspace(f.workspace()));
  assert.equal(cleared.cancellations.length,0,'content resolution does not send a spurious policy cancellation');
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
