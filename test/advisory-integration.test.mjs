import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {apply} from '../lib/index.js';

async function waitUntil(predicate,timeout=4500){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  if(await predicate())return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('Timed out waiting for asynchronous event-driven advice');
}
async function fixture(base,{cooldownMs=90000,retryMs=10000,initialAgents=[]}={}){
 const root=path.join(base,'repo'),stateDirectory=path.join(base,'state');
 await fs.mkdir(root,{recursive:true});
 const registry=new Map(initialAgents.map(agent=>[agent.id,agent]));
 const agents={get:id=>registry.get(id),list:()=>[...registry.values()],
  roots:()=>[...registry.values()].filter(agent=>!agent.runtimeChild)};
 assert.equal(agents.values,undefined);
  const events=new Map(),warnings=[],disposers=[],providers=[];
  let handler;
  const skills={
   registerProvider(factory){
    const provider=factory({invalidate(){}});providers.push(provider);
    return()=>{const index=providers.indexOf(provider);if(index>=0)providers.splice(index,1);};
   },
   async get(name,options){
    for(const provider of providers){
     const found=(await provider.list(options)).find(summary=>summary.name===name);
     if(found)return provider.get(found,options);
    }
    return undefined;
   }
  };
  const ctx={agents,skills,logger:{warn(m){warnings.push(m);},error(m){warnings.push(m);}},
   on(name,callback){events.set(name,callback);return()=>events.delete(name);},
   webServer:{register({handler:apiHandler}){handler=apiHandler;return()=>{};}},
   effect(callback){const dispose=callback();if(typeof dispose==='function')disposers.push(dispose);}}; apply(ctx,{stateDirectory,deliveryCooldownMs:cooldownMs,deliveryRetryMs:retryMs});
 const api=async(method,endpoint,body)=>{
  const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
  req.method=method;req.url='/api/dsh-workspace-governance'+endpoint;
  req.headers={host:'localhost:19000',...(method==='GET'?{}:{'x-wg-request':'1'})};
  let result;
  await handler(req,{writeHead(){},end(data){result=JSON.parse(data);}});
  return result;
 };
 const emit=(event,payload)=>events.get(event)?.(payload);
 const createAgent=({id='lead',status='running',steer}={})=>{
  const received=[];
  const agent={id,status,session:{header:{cwd:root}},
   steer(message){received.push(message);emit('agent/inbox/inserted',{agent,message});
    return steer?.(message);},received};
  return agent;
 };
 const configure=async()=>{
  const ws=(await api('POST','/workspaces',{root})).workspace;
  await api('PUT','/defaults',{id:ws.id,defaultFileLimit:100,warningRatio:.8,
   optimizationPercent:10,expectedVersion:1});
  await api('PUT','/mode',{id:ws.id,mode:'warning',expectedVersion:2});
  return ws;
 };
  return {root,registry,events,skills,api,emit,createAgent,configure,warnings,
   dispose(){for(const dispose of disposers.reverse())dispose();assert.equal(events.size,0,'all host subscriptions removed');}};}
test('native pre-step loads real Skill bodies once, separate from light advisory messages',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-skill-use-'));
 const h=await fixture(base);
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  await h.configure();
  await fs.writeFile(path.join(h.root,'strategy.md'),'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  assert.equal(lead.received[0].content[0].text.includes('<skill_content'),false,
   'ordinary advisory must not carry Skill body');
  const step=h.events.get('agent/pre-step');
  assert.equal(typeof step,'function');
  const proposal=messages=>step({agent:lead,signal:{throwIfAborted(){}}},async()=>({
   kind:'accept',messages
  }));
  const initial=await proposal([lead.received[0]]);
  assert.deepEqual(initial.messages.slice(1).map(m=>m.source),[
   {kind:'skill-invocation',name:'semantic-refactor-forge',form:'instructions'},
   {kind:'skill-invocation',name:'forensic-prune',form:'instructions'}
  ]);
  for(const message of initial.messages.slice(1)){
   const original=await fs.readFile(new URL('../embedded-skills/'+message.source.name+'/SKILL.md',import.meta.url),'utf8');
   assert.ok(message.content[0].text.includes(original),'model sees the full active Skill body');
   assert.match(message.content[0].text,/<skill_content name="/);
  }
  lead.session.deriveMessages=()=>initial.messages.slice(1);
  const repeated=await proposal([lead.received[0]]);  assert.equal(repeated.messages.length,1,'same session must reuse injected skills');
  const resumed=h.createAgent({id:'continued'});
  resumed.session.deriveMessages=()=>initial.messages.slice(1);
  const inherited=await step({agent:resumed,signal:{throwIfAborted(){}}},async()=>({
   kind:'accept',messages:[lead.received[0]]
  }));
  assert.equal(inherited.messages.length,1,'native Skill already in session context must not reload');
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('native pre-step injects workspace custom Skill instead of bundled Skills',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-custom-use-'));
 const h=await fixture(base);
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const ws=await h.configure();
  const current=(await h.api('GET','/maintenance?id='+ws.id));
  const settings={...current.skillSettings,mode:'custom',customSkill:'Custom workspace verification instructions'};
  const update=await h.api('PUT','/skill-settings',{id:ws.id,
   settings,expectedVersion:current.policyVersion});
  assert.equal(update.ok,true);
  await fs.writeFile(path.join(h.root,'custom.md'),'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  const result=await h.events.get('agent/pre-step')({
   agent:lead,signal:{throwIfAborted(){}}
  },async()=>({kind:'accept',messages:[lead.received[0]]}));
  assert.equal(result.messages.length,2);
  assert.equal(result.messages[1].source.name,'workspace-governance-custom');
  assert.match(result.messages[1].content[0].text,/Custom workspace verification instructions/);
  assert.equal(result.messages[1].content[0].text.includes('semantic-refactor-forge'),false);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('real-shaped registry: external Markdown edit sends non-blocking steer and reports inbox insertion',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-steer-'));
 const h=await fixture(base);
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const ws=await h.configure();
  const file=path.join(h.root,'changed.md');
  await fs.writeFile(file,'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  assert.match(lead.received[0].content[0].text,/目标使用率：70%/);
  assert.equal((await h.api('GET','/remediation?id='+ws.id)).remediation.total,1);
  await waitUntil(async()=>(await h.api('GET','/maintenance?id='+ws.id)).lastInbox?.state==='inserted');
  const maintenance=await h.api('GET','/maintenance?id='+ws.id);
  assert.equal(maintenance.lastInbox.messageId,lead.received[0].id);
  h.emit('agent/inbox/claimed',{agent:lead,message:lead.received[0]});
  assert.equal((await h.api('GET','/maintenance?id='+ws.id)).lastInbox.state,'claimed');
  assert.equal((await fs.readFile(file,'utf8')).length,92);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('verified backlog is delivered to an already-running Agent on plugin restart with no new edit',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-restart-'));
 let h=await fixture(base);
 try{
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'existing.md'),'x'.repeat(92));
  await waitUntil(async()=>{
   const queue=(await h.api('GET','/remediation?id='+ws.id)).remediation;
   return queue.verified&&queue.total===1;
  });
  await waitUntil(async()=>(await h.api('GET','/maintenance?id='+ws.id)).lastDelivery?.status==='no-running-agent');
  h.dispose();
  h=await fixture(base);
  const agent=h.createAgent();h.registry.set(agent.id,agent);
  await waitUntil(()=>agent.received.length===1);
  assert.equal((await h.api('GET','/maintenance?id='+ws.id)).remediation.total,1);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('accepted task is recorded durably and not submitted again on plugin restart',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-dedup-restart-'));
 let h=await fixture(base,{cooldownMs:120});
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'stable.md'),'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  await waitUntil(async()=>{
   const tasks=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks;
   return tasks.length===1&&tasks[0].deliveredTo?.lead===tasks[0].episodeId;
  });
  h.dispose();
  h=await fixture(base,{cooldownMs:120});
  const resumed=h.createAgent();h.registry.set(resumed.id,resumed);
  await waitUntil(async()=>(await h.api('GET','/maintenance?id='+ws.id)).lastDelivery?.status==='unchanged');
  assert.equal(resumed.received.length,0,'restarting must not resubmit an accepted task to the same session');
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('same count content edits and unrelated policy revisions do not create a duplicate instruction',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-fingerprint-stable-'));
 const h=await fixture(base,{cooldownMs:120});
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const ws=await h.configure();
  const file=path.join(h.root,'capacity.md');
  await fs.writeFile(file,'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0]?.deliveredTo?.lead);
  const before=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0].fingerprint;
  await fs.writeFile(file,'y'.repeat(92));
  await h.api('POST','/scan',{id:ws.id});
  assert.equal((await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0].fingerprint,before);
  const version=(await h.api('GET','/workspaces')).workspaces.find(w=>w.id===ws.id).policy.version;
  await h.api('PUT','/defaults',{id:ws.id,defaultFileLimit:100,warningRatio:.8,
   optimizationPercent:10,expectedVersion:version});
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.policyVersion===version+1);
  const unchanged=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0];
  assert.equal(unchanged.fingerprint,before);
  assert.equal(unchanged.deliveredTo?.lead,unchanged.episodeId);
  await new Promise(resolve=>setTimeout(resolve,550));
  assert.equal(lead.received.length,1);
   await fs.writeFile(file,'z'.repeat(94));
   await waitUntil(async()=>{
    const updated=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0];
    return updated.fingerprint!==before&&updated.deliveredTo?.lead===updated.episodeId;
   });
   assert.equal(lead.received.length,1,'an in-progress warning episode cannot re-inject on each edit'); }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('native inbox discard invalidates only the matching accepted receipt and retries once',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-discard-'));
 const h=await fixture(base,{cooldownMs:120,retryMs:100});
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'discard.md'),'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  await waitUntil(async()=>{
   const task=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0];
   return task?.deliveredTo?.lead===task?.episodeId;
  });
  h.emit('agent/inbox/discarded',{agent:lead,message:lead.received[0]});
  await waitUntil(()=>lead.received.length===2);
  await waitUntil(async()=>{
   const task=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0];
   return task?.deliveredTo?.lead===task?.episodeId;
  });
  assert.equal(lead.received.length,2);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('a user-pasted legacy remediation instruction suppresses redundant automatic steering',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-manual-'));
 const h=await fixture(base,{cooldownMs:120});
 try{
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'manual.md'),'x'.repeat(92));
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.total===1);
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const humanMessage={id:'human-input-1',role:'user',source:{kind:'desktop'},
   content:[{type:'text',text:'WORKSPACE_GOVERNANCE: REMEDIATION_REQUEST（人工提交）\n仅处理已授权范围：Markdown 文档 manual.md\n目标使用率：70%'}]};
  h.emit('agent/inbox/inserted',{agent:lead,message:humanMessage});
  h.emit('agent/status',{agent:lead,status:'running'});
  await waitUntil(async()=>{
   const task=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0];
   return task?.deliveredTo?.lead===task?.episodeId;
  });
  await waitUntil(async()=>(await h.api('GET','/maintenance?id='+ws.id)).lastDelivery?.status==='unchanged');
  assert.equal(lead.received.length,0,'already submitted manual message must not be duplicated');
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('ordinary user messages mentioning a file cannot silently suppress advisories',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-manual-safety-'));
 const h=await fixture(base,{cooldownMs:120});
 try{
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'review.md'),'x'.repeat(92));
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.total===1);
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  h.emit('agent/inbox/inserted',{agent:lead,message:{id:'ordinary-msg',role:'user',
   source:{kind:'desktop'},content:[{type:'text',text:'请先分析 review.md 的容量问题，不要修改该文件。'}]}});
  h.emit('agent/status',{agent:lead,status:'running'});
  await waitUntil(()=>lead.received.length===1);
  const task=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0];
  assert.equal(task.deliveredTo?.lead,task.episodeId);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('pending verified task is sent when a previously absent Agent is created and starts running',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-late-'));
 const h=await fixture(base);
 try{
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'pending.md'),'y'.repeat(92));
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.total===1);
  const agent=h.createAgent({status:'idle'});
  h.registry.set(agent.id,agent);
  h.emit('agent/created',{agent});
  await waitUntil(async()=>(await h.api('GET','/maintenance?id='+ws.id)).lastDelivery?.status==='no-running-agent');
  assert.equal(agent.received.length,0,'idle sessions must not be woken');
  agent.status='running';
  h.emit('agent/status',{agent,status:'running'});
  await waitUntil(()=>agent.received.length===1);
  assert.equal((await h.api('GET','/maintenance?id='+ws.id)).lastDelivery?.status,'queued');
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('multiple running leads receive one batch per turn and backlog drains only after the next turn begins',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-batch-'));
 const h=await fixture(base,{cooldownMs:150});
 try{
  const a=h.createAgent({id:'a'}),b=h.createAgent({id:'b'});
  h.registry.set(a.id,a);h.registry.set(b.id,b);
  for(let i=0;i<5;i++)await fs.writeFile(path.join(h.root,'file-'+i+'.md'),'x'.repeat(92));
  const ws=await h.configure();
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.total===5);
   await waitUntil(()=>a.received.length===1&&b.received.length===1,5500);
   await waitUntil(async()=>{
    const tasks=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks;
    return tasks.slice(0,3).every(task=>task.deliveredTo?.a===task.episodeId&&task.deliveredTo?.b===task.episodeId);
   });
   await new Promise(resolve=>setTimeout(resolve,350));
   assert.equal(a.received.length,1,'no second injection during a running turn');
   assert.equal(b.received.length,1,'other running turn also stays quiet');
   for(const lead of [a,b]){lead.status='idle';h.emit('agent/status',{agent:lead,status:'idle'});}
   for(const lead of [a,b]){lead.status='running';h.emit('agent/status',{agent:lead,status:'running'});}
   await waitUntil(()=>a.received.length===2&&b.received.length===2,5500);
   assert.equal(a.received.length,2);
   assert.equal(b.received.length,2);  assert.equal((await h.api('GET','/maintenance?id='+ws.id)).remediation.total,5);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('threshold change while native steer is awaiting acknowledgement still cancels accepted old instruction',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-steer-policy-race-'));
 const h=await fixture(base,{cooldownMs:120,retryMs:120});
 let release;
 try{
  const lead=h.createAgent({steer(message){if(message.source.kind==='workspace-governance')return new Promise(resolve=>{release=resolve;});}});
  h.registry.set(lead.id,lead);
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'race.md'),'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1&&typeof release==='function');
  const first=lead.received[0];
  assert.equal(first.source.kind,'workspace-governance');
  const version=(await h.api('GET','/workspaces')).workspaces.find(w=>w.id===ws.id).policy.version;
  const changed=await h.api('PUT','/defaults',{id:ws.id,defaultFileLimit:200,
   warningRatio:.8,optimizationPercent:10,expectedVersion:version});
  assert.equal(changed.ok,true);
  await waitUntil(async()=>{
   const data=(await h.api('GET','/remediation?id='+ws.id)).remediation;
   return data.verified&&data.total===0&&data.policyVersion===version+1;
  });
  release();
  await waitUntil(()=>lead.received.some(msg=>msg.source.kind==='workspace-governance-cancel'),6500);
  const cancellation=lead.received.find(msg=>msg.source.kind==='workspace-governance-cancel');
  assert.match(cancellation.content[0].text,/旧目标 70 字符作废/);
  assert.match(cancellation.content[0].text,/当前 未知\/200 字符/,
   'late receipts must report the verified limit without guessing a now-inactive file count');
  await waitUntil(async()=>{
   const current=(await h.api('GET','/remediation?id='+ws.id)).remediation;
   return current.verified&&current.cancellations.length===0;
  });
 }finally{release?.();h.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('running Agent receives cancellation and revised target when a still-active rule changes',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-live-target-'));
 const h=await fixture(base,{cooldownMs:120,retryMs:120});
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'target.md'),'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0]?.deliveredTo?.lead);
  assert.match(lead.received[0].content[0].text,/目标字符数：70/);
  const original=(await h.api('GET','/workspaces')).workspaces.find(w=>w.id===ws.id).policy.version;
  const updated=await h.api('PUT','/defaults',{id:ws.id,defaultFileLimit:100,
   warningRatio:.8,optimizationPercent:20,expectedVersion:original});
  assert.equal(updated.ok,true);
  await waitUntil(()=>lead.received.length===3,6500);
  assert.deepEqual(lead.received.map(message=>message.source.kind),[
   'workspace-governance','workspace-governance-cancel','workspace-governance']);
  assert.match(lead.received[1].content[0].text,/旧目标 70 字符作废/);
  assert.match(lead.received[2].content[0].text,/目标字符数：60/);
  await waitUntil(async()=>{
   const q=(await h.api('GET','/remediation?id='+ws.id)).remediation;
   return q.cancellations.length===0&&q.tasks[0]?.deliveredTo?.lead===q.tasks[0]?.episodeId;
  });
  await h.api('POST','/scan',{id:ws.id});
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(lead.received.length,3,'reconcile cannot resend an already accepted revision');
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('directory create move delete and recreation refresh paths and keep explicit rule',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-live-directory-'));
 const h=await fixture(base);
 try{
  const ws=await h.configure();
  const original=(await h.api('GET','/workspaces')).workspaces.find(w=>w.id===ws.id).policy.version;
  const rule=await h.api('PUT','/rules',{id:ws.id,scope:'directories',relative:'docs',
    rule:{fileLimit:70},expectedVersion:original});
  assert.equal(rule.ok,true);
  await fs.mkdir(path.join(h.root,'docs'));
  await fs.writeFile(path.join(h.root,'docs','new.md'),'x'.repeat(92));
  await waitUntil(async()=>((await h.api('GET','/remediation?id='+ws.id)).remediation.tasks??[])
    .some(task=>task.path==='docs/new.md'),6500);
  await fs.rename(path.join(h.root,'docs'),path.join(h.root,'archive'));
  await waitUntil(async()=>{
   const tasks=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks??[];
   return tasks.some(task=>task.path==='archive/new.md')&&!tasks.some(task=>task.path==='docs/new.md');
  },6500);
  await fs.rm(path.join(h.root,'archive'),{recursive:true,force:true});
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.total===0,6500);
  await fs.mkdir(path.join(h.root,'docs'));
  await fs.writeFile(path.join(h.root,'docs','again.md'),'z'.repeat(82));
  await waitUntil(async()=>{
   const tasks=(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks??[];
   return tasks.some(task=>task.path==='docs/again.md'&&task.limit===70);
  },6500);
  const policy=(await h.api('GET','/workspaces')).workspaces.find(w=>w.id===ws.id).policy;
  assert.equal(policy.directories.docs.fileLimit,70);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('new file limit supersedes the one accepted advisory exactly once for its original running session',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-cancel-'));
 const h=await fixture(base,{cooldownMs:120});
 try{
  const lead=h.createAgent(),other=h.createAgent({id:'other',status:'idle'});
  h.registry.set(lead.id,lead);h.registry.set(other.id,other);
  const ws=await h.configure();
  const file=path.join(h.root,'criterion-gaps.md');
  await fs.writeFile(file,'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0]?.deliveredTo?.lead);
  const before=lead.received[0].content[0].text;
  assert.match(before,/目标字符数：70/);
  const version=(await h.api('GET','/workspaces')).workspaces.find(w=>w.id===ws.id).policy.version;
  await h.api('PUT','/defaults',{id:ws.id,defaultFileLimit:200,warningRatio:.8,optimizationPercent:10,expectedVersion:version});
  await waitUntil(()=>lead.received.length===2);
  const cancellation=lead.received[1];
  assert.equal(cancellation.source.kind,'workspace-governance-cancel');
  assert.match(cancellation.content[0].text,/WORKSPACE_GOVERNANCE: CANCEL/);
  assert.match(cancellation.content[0].text,/criterion-gaps.md/);
  assert.match(cancellation.content[0].text,/当前 92\/200 字符/);
  assert.match(cancellation.content[0].text,/旧目标 70 字符作废/);
  await waitUntil(async()=>!(await h.api('GET','/remediation?id='+ws.id)).remediation.cancellations?.length);
  await h.api('POST','/scan',{id:ws.id});
  await h.api('POST','/scan',{id:ws.id});
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(lead.received.length,2,'one cancellation per accepted task and session');
  assert.equal(other.received.length,0,'idle and unrelated recipients receive nothing');
  assert.equal((await h.api('GET','/remediation?id='+ws.id)).remediation.total,0);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('saved custom cancellation template controls verified cancellation without changing advisory wording',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-cancel-template-'));
 const h=await fixture(base,{cooldownMs:120});
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const ws=await h.configure();
  const original=await h.api('GET','/maintenance?id='+ws.id);
  const configured=await h.api('PUT','/skill-settings',{id:ws.id,expectedVersion:original.policyVersion,
   settings:{...original.skillSettings,mode:'custom',
    customCancelPrompt:'CUSTOM CANCEL\n{{items}}\nOnly cancel this task'}});
  assert.equal(configured.ok,true);
  await fs.writeFile(path.join(h.root,'override.md'),'x'.repeat(92));
  await waitUntil(()=>lead.received.length===1);
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0]?.deliveredTo?.lead);
  const advisory=lead.received[0].content[0].text;
  assert.match(advisory,/WORKSPACE_GOVERNANCE: ADVISORY/);
  assert.match(advisory,/目标字符数：70/);
  const version=(await h.api('GET','/workspaces')).workspaces.find(w=>w.id===ws.id).policy.version;
  await h.api('PUT','/defaults',{id:ws.id,defaultFileLimit:200,warningRatio:.8,
   optimizationPercent:10,expectedVersion:version});
  await waitUntil(()=>lead.received.length===2);
  const cancellation=lead.received[1];
  assert.equal(cancellation.source.kind,'workspace-governance-cancel');
  assert.match(cancellation.content[0].text,/^CUSTOM CANCEL/);
  assert.match(cancellation.content[0].text,/override.md/);
  assert.match(cancellation.content[0].text,/当前 92\/200 字符/);
  assert.match(cancellation.content[0].text,/Only cancel this task/);
  await waitUntil(async()=>!(await h.api('GET','/remediation?id='+ws.id)).remediation.cancellations?.length);
  assert.equal(lead.received.length,2);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});

test('discarded cancellation is requeued once and does not reinstate the obsolete advisory',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-cancel-discard-'));
 const h=await fixture(base,{cooldownMs:120,retryMs:120});
 try{
  const lead=h.createAgent();h.registry.set(lead.id,lead);
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'obsolete.md'),'x'.repeat(90));
  await waitUntil(()=>lead.received.length===1);
  await waitUntil(async()=>(await h.api('GET','/remediation?id='+ws.id)).remediation.tasks[0]?.deliveredTo?.lead);
  const version=(await h.api('GET','/workspaces')).workspaces.find(w=>w.id===ws.id).policy.version;
  await h.api('PUT','/defaults',{id:ws.id,defaultFileLimit:200,warningRatio:.8,optimizationPercent:10,expectedVersion:version});
  await waitUntil(()=>lead.received.length===2);
  await waitUntil(async()=>!(await h.api('GET','/remediation?id='+ws.id)).remediation.cancellations?.length);
  const cancelled=lead.received[1];
  h.emit('agent/inbox/discarded',{agent:lead,message:cancelled});
  await waitUntil(()=>lead.received.length===3,5500);
  assert.equal(lead.received[2].source.kind,'workspace-governance-cancel');
  await waitUntil(async()=>!(await h.api('GET','/remediation?id='+ws.id)).remediation.cancellations?.length);
  await h.api('POST','/scan',{id:ws.id});
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(lead.received.length,3,'rejected cancellation retries once, not repeatedly');
  assert.equal((await h.api('GET','/remediation?id='+ws.id)).remediation.total,0);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
test('rejected native steer retries from persistent queue without another filesystem edit',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'wg-retry-'));
 const h=await fixture(base,{retryMs:120});
 try{
  let attempts=0;
  const agent=h.createAgent({steer(){if(++attempts===1)throw Error('simulated rejected steer');}});
  h.registry.set(agent.id,agent);
  const ws=await h.configure();
  await fs.writeFile(path.join(h.root,'retry.md'),'x'.repeat(92));
  await waitUntil(()=>attempts===2);
  assert.equal(agent.received.length,2);
  assert.ok(h.warnings.some(w=>String(w).includes('simulated rejected steer')));
  assert.equal((await h.api('GET','/maintenance?id='+ws.id)).remediation.total,1);
 }finally{h.dispose();await fs.rm(base,{recursive:true,force:true});}
});
