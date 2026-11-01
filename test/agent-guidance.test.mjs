import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAgentGuidance} from '../lib/agent-guidance.js';
import {DEFAULT_POLICY} from '../lib/core.js';

const workspace={id:'workspace-one',root:'D:/project/Aevum',name:'Aevum',
 policy:{...structuredClone(DEFAULT_POLICY),version:4,capacityMode:'warning',optimizationPercent:10,
  skillSettings:{mode:'off',customSkill:'x',customPrompt:'x',embeddedPrompt:'x'}}};
const mkTask=(current=92,id='a')=>({id:id.repeat(64),fingerprint:current+'-sha-'+id,kind:'file',
 path:'docs/research'+id+'.md',current,limit:100,usagePercent:current,trigger:'warning',
 triggerPercent:80,reductionPoints:10,targetPercent:70,targetChars:70,requiredReduction:current-70,protected:false});
const q=tasks=>({verified:true,tasks});
const paths=tasks=>tasks.map(t=>t.path);
function testAgent({id='lead',cwd='D:/project/Aevum',status='running',parentSession}={}){
 const received=[];
 return {id,status,session:{header:{cwd,parentSession}},received,
  steer(message){received.push(message);}};
}
function host(roots=[]){
 const store=new Map(roots.map(agent=>[agent.id,agent]));
 return {get:id=>store.get(id),list:()=>[...store.values()],
  roots:()=>[...store.values()].filter(a=>!a.runtimeChild),store};
}
test('native AgentRegistry roots/list/get routes a pre-existing running Agent without lifecycle events',async()=>{
 const lead=testAgent(),registry=host([lead]);
 assert.equal(registry.values,undefined,'host shape must not be Map');
 const sender=createAgentGuidance({agents:registry,now:()=>100000});
 const task=mkTask();
 const delivery=await sender.send(workspace,q([task]),{changedPaths:paths([task])});
 assert.equal(delivery.status,'queued');
 assert.equal(lead.received.length,1);
 assert.equal(lead.received[0].role,'user');
 assert.equal(lead.received[0].source.kind,'workspace-governance');
 assert.match(lead.received[0].content[0].text,/目标使用率：70%/);
 assert.equal((await sender.send(workspace,q([task]),{changedPaths:paths([task])})).status,'unchanged');
});
test('only running roots receive advice; idle, unrelated roots and runtime children excluded',async()=>{
 const lead=testAgent(),other=testAgent({id:'other',cwd:'D:/elsewhere'});
 const idle=testAgent({id:'idle',status:'idle'});
 const child=testAgent({id:'child',parentSession:'lead'});child.runtimeChild=true;
 const registry=host([lead,other,idle,child]),sender=createAgentGuidance({agents:registry});
 const task=mkTask();
 assert.equal((await sender.send(workspace,q([task]))).status,'queued');
 assert.equal(lead.received.length,1);
 assert.equal(idle.received.length,0);
 assert.equal(other.received.length,0);
 assert.equal(child.received.length,0);
 // Runtime ownership, not persisted parentSession, is authoritative.
 registry.store.delete(lead.id);
 registry.store.delete(idle.id);
 registry.store.delete(other.id);
 child.runtimeChild=false;
 assert.equal((await createAgentGuidance({agents:registry}).send(workspace,q([task]))).status,'queued');
 assert.equal(child.received.length,1);
});
test('multiple running roots in one workspace each receive advice without ambiguous-session loss',async()=>{
 const a=testAgent({id:'a'}),b=testAgent({id:'b'}),sender=createAgentGuidance({agents:host([a,b])});
 const result=await sender.send(workspace,q([mkTask()]));
 assert.equal(result.status,'queued');
 assert.equal(result.recipients,2);
 assert.equal(result.delivered,2);
 assert.equal(a.received.length,1);
 assert.equal(b.received.length,1);
});
test('idle Agent receives nothing; verified queue is delivered after real running transition',async()=>{
 let clock=100000;
 const lead=testAgent({status:'idle'}),sender=createAgentGuidance({agents:host([lead]),now:()=>clock});
 const task=mkTask();
 assert.equal((await sender.send(workspace,q([task]))).status,'no-running-agent');
 sender.track(lead,'running');
 assert.equal((await sender.send(workspace,q([task]))).status,'no-running-agent',
  'event cache must not override the authoritative idle runtime state');
 assert.equal(lead.received.length,0);
 lead.status='running';
  assert.equal((await sender.send(workspace,q([task]))).status,'queued');
  const updated=mkTask(94);
  assert.equal((await sender.send(workspace,q([updated]))).status,'in-progress',
   'a running turn is never interrupted by another advisory');
  lead.status='idle';sender.track(lead,'idle');
  clock+=90001;
  assert.equal((await sender.send(workspace,q([updated]))).status,'no-running-agent');
  assert.equal(lead.received.length,1);
  lead.status='running';sender.track(lead,'running');
  assert.equal((await sender.send(workspace,q([updated]))).status,'queued');
  assert.equal(lead.received.length,2);});
test('invalid queues, off mode and unmatched explicit file changes never inject',async()=>{
 const lead=testAgent(),sender=createAgentGuidance({agents:host([lead])}),task=mkTask();
 assert.equal((await sender.send(workspace,{verified:false,tasks:[task]})).status,'skipped');
 assert.equal((await sender.send(workspace,q([task]),{changedPaths:['docs/unrelated.md']})).status,'skipped');
 assert.equal((await sender.send({...workspace,policy:{...workspace.policy,capacityMode:'off'}},q([task]))).status,'skipped');
 assert.equal(lead.received.length,0);
});
test('cooldown preserves new fingerprints and drains paged work after its expiry',async()=>{
 let time=10000;
 const lead=testAgent(),sender=createAgentGuidance({agents:host([lead]),now:()=>time});
 const tasks=['a','b','c','d','e'].map(k=>mkTask(92,k));
 let result=await sender.send(workspace,q(tasks));
 assert.equal(result.status,'queued');
 assert.equal(result.results[0].taskCount,3);
 assert.equal(result.retryAfterMs,90000);
  assert.equal((await sender.send(workspace,q(tasks))).status,'in-progress');
  lead.status='idle';sender.track(lead,'idle');
  time+=90000;
  lead.status='running';sender.track(lead,'running');
  result=await sender.send(workspace,q(tasks));
  assert.equal(result.status,'queued');
  assert.equal(result.results[0].taskCount,2);
  assert.equal((await sender.send(workspace,q(tasks))).status,'unchanged');
  assert.equal(lead.received.length,2);
  const changed=tasks.map((task,i)=>i===0?{...task,fingerprint:'new-fingerprint'}:task);
  assert.equal((await sender.send(workspace,q(changed))).status,'in-progress');
  lead.status='idle';sender.track(lead,'idle');
  time+=90000;
  lead.status='running';sender.track(lead,'running');
  assert.equal((await sender.send(workspace,q(changed))).status,'queued');
  assert.equal(lead.received.length,3);});
test('native inbox lifecycle correlates accepted, claimed and discarded messages',async()=>{
 let time=200000;
 const lead=testAgent(),sender=createAgentGuidance({agents:host([lead]),now:()=>time});
 const first=await sender.send(workspace,q([mkTask()]));
 const message=lead.received[0];
 assert.equal(sender.observeInbox('inserted',{agent:lead,message}).state,'inserted');
 assert.equal(sender.observeInbox('claimed',{agent:lead,message}).state,'claimed');
 assert.equal(sender.observeInbox('discarded',{agent:lead,message}),null);
  const again=mkTask(94);
  lead.status='idle';sender.track(lead,'idle');
  time+=90000;
  lead.status='running';sender.track(lead,'running');
  await sender.send(workspace,q([again]));
  const pending=lead.received[1];
  assert.equal(sender.observeInbox('discarded',{agent:lead,message:pending}).state,'discarded');
  time+=90000;
  assert.equal((await sender.send(workspace,q([again]))).status,'queued');
  assert.equal(sender.observeInbox('claimed',{agent:lead,message:pending}),null);
  assert.equal(first.delivered,1);});
test('host rejection does not suppress retry; asynchronous in-flight dispatch is deduplicated',async()=>{
 const lead=testAgent(),sender=createAgentGuidance({agents:host([lead])});
 let rejectDelivery; const messages=[];
 lead.steer=msg=>{messages.push(msg);return new Promise((_resolve,reject)=>{rejectDelivery=reject;});};
 const first=sender.send(workspace,q([mkTask()]));
 assert.equal((await sender.send(workspace,q([mkTask()]))).status,'pending');
 assert.equal(messages.length,1);
 rejectDelivery(Error('closed inbox'));
 assert.equal((await first).status,'delivery-error');
 lead.steer=msg=>messages.push(msg);
 assert.equal((await sender.send(workspace,q([mkTask()]))).status,'queued');
 assert.equal(messages.length,2);
});
test('registry disposal leaves no target and stale event references cannot outlive registry membership',async()=>{
 const a=testAgent(),registry=host([a]),sender=createAgentGuidance({agents:registry});
 sender.track(a);
 registry.store.delete(a.id);
 sender.remove(a);
 assert.equal((await sender.send(workspace,q([mkTask()]))).status,'no-running-agent');
});
