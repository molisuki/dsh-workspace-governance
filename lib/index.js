import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import { createRegistry, IGNORED, safeDocument, policyDirectory, effectiveCapacityMode, effectiveOptimizationPercent, effectivePolicy, countCharacters, isProtectedDocument, INTEGRITY_ISSUES } from './core.js';
import {createAgentGuidance} from './agent-guidance.js';
import {createGovernanceSkillProvider,prepareGovernanceSkills} from './embedded-skills.js';
import {createCapacityIndex} from './capacity-index.js';
import {createRemediationQueue} from './remediation-queue.js';
import {effectiveSkillSettings,DEFAULT_CUSTOM_PROMPT,DEFAULT_EMBEDDED_PROMPT,DEFAULT_CUSTOM_CANCEL_PROMPT,DEFAULT_EMBEDDED_CANCEL_PROMPT} from './skill-strategy.js';
export const name='dsh-workspace-governance';
export const inject=['webServer','agents','skills'];
const PREFIX='/api/dsh-workspace-governance';
function respond(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
function sameOrigin(req){
  const host=String(req.headers?.host??'');
  let hostname;
  try{
    const url=new URL('http://'+host);
    if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||
       url.host.toLowerCase()!==host.toLowerCase())return false;
    hostname=url.hostname.toLowerCase();
  }catch{return false;}
  if(!['localhost','127.0.0.1','[::1]'].includes(hostname))return false;
  const remote=req.socket?.remoteAddress??req.connection?.remoteAddress;
  if(remote&&!(remote==='::1'||/^127(?:\.\d{1,3}){3}$/.test(remote)||
    /^::ffff:127(?:\.\d{1,3}){3}$/i.test(remote)))return false;
  const origin=req.headers?.origin;
  if(!origin||origin==='dsh-app://app')return true;
  try{
    const url=new URL(origin);
    return url.protocol==='http:'&&url.host.toLowerCase()===host.toLowerCase();
  }catch{return false;}
}
async function jsonBody(req){
  const chunks=[];let size=0;
  for await(const part of req){size+=part.length;if(size>65536)throw Error('Payload too large');chunks.push(part);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
function statusCode(error){const s=String(error.message);return /Unknown workspace|Not found|ENOENT/.test(s)?404:/Changed since recorded version|Stale version|tracking paused/i.test(s)?409:/Protected|Unauthorized/.test(s)?403:/Invalid|Unsafe|Absolute|outside|Unsupported|required|large/i.test(s)?400:500;}
export function apply(ctx,config={}){
  const policyRoot=config.stateDirectory??policyDirectory();
  const registryReady=createRegistry(policyRoot);
  const invalidateSkillCatalog=new Set();
  if(typeof ctx.skills?.registerProvider==='function')ctx.effect(()=>ctx.skills.registerProvider(control=>{
    invalidateSkillCatalog.add(control.invalidate);
    return createGovernanceSkillProvider({registryReady});
  }),'workspace governance native Skill catalog');
  const backupPath=(id,digest)=>path.join(path.dirname(policyRoot),'workspace-governance-backups',id,digest+'.snapshot');
  const watchers=new Map(),watchFailures=new Map(),lastStatus=new Map(),reconcileTimers=new Map();
  const deliveryTimers=new Map(),deliveryRunning=new Set(),deliveryAgain=new Set(),watchRetryTimers=new Map();
  const externalDeliveries=new Map();
  const guidance=createAgentGuidance({agents:ctx.agents,logger:ctx.logger,
    cooldownMs:config.deliveryCooldownMs??90000,retryMs:config.deliveryRetryMs??10000});
  const locks=new Map();
  const withWorkspaceLock=async(id,action)=>{
    const before=locks.get(id)||Promise.resolve();
    let release;
    const next=new Promise(resolve=>{release=resolve;});
    locks.set(id,next);
    await before.catch(()=>{});
    try{return await action();}
    finally{release();if(locks.get(id)===next)locks.delete(id);}
  };
  const agentDisposers=[];
  async function injectSkills({agent,signal},next){
    const decision=await next();
    if(disposed||signal?.aborted||agent?.status!=='running'||!ctx.skills?.get)
      return decision;
    const cwd=agent.session?.header?.cwd;
    if(typeof cwd!=='string')return decision;
    const registry=await registryReady;
    const workspace=registry.snapshot().workspaces.find(ws=>
      path.resolve(ws.root).toLowerCase()===path.resolve(cwd).toLowerCase());
    if(!workspace)return decision;
    try{
      return await prepareGovernanceSkills({agent,decision,skills:ctx.skills,policy:workspace.policy,signal});
    }catch(error){
      if(signal?.aborted)throw error;
      ctx.logger?.warn?.('workspace governance Skill load: '+String(error));
      return decision;
    }
  }
  // Associate manual remediation instructions with existing delivery receipts.
  function recognizeManualDelivery({agent,message}={}){
    if(typeof agent?.id!=='string'||typeof agent?.session?.header?.cwd!=='string'||
       message?.role!=='user'||message?.source?.kind==='workspace-governance')return;
    const text=Array.isArray(message.content)?
      message.content.filter(item=>item?.type==='text').map(item=>item.text).join('\n'):'';
    if(!text.trimStart().startsWith('WORKSPACE_GOVERNANCE: REMEDIATION_REQUEST'))return;
    const key=path.resolve(agent.session.header.cwd).toLowerCase();
    const previous=externalDeliveries.get(key)??Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{
      const registry=await registryReady;
      const ws=registry.snapshot().workspaces.find(ws=>
        path.resolve(ws.root).toLowerCase()===key);
      if(!ws||disposed)return;
      await getScan(registry,ws.id);
      const queue=await remediation.list(ws.id);
      const items=queue.tasks.filter(task=>task.path&&text.includes(
        (task.kind==='directory'?'目录 ':'Markdown 文档 ')+task.path))
        .map(task=>({id:task.id,fingerprint:task.fingerprint,episodeId:task.episodeId}));
       if(items.length)await remediation.recordDelivery(ws.id,
         String(agent.session.id??agent.session.header.id??agent.id),items);    }).catch(error=>ctx.logger?.warn?.('governance manual advisory receipt: '+String(error)));
    externalDeliveries.set(key,next);
    next.finally(()=>{if(externalDeliveries.get(key)===next)externalDeliveries.delete(key);}).catch(()=>{});
  }
  function scheduleForAgent(agent){
    const cwd=agent?.session?.header?.cwd;
    if(typeof cwd!=='string'||disposed)return;
    registryReady.then(registry=>{
      if(disposed)return;
      for(const ws of registry.snapshot().workspaces){
        if(path.resolve(cwd).toLowerCase()===path.resolve(ws.root).toLowerCase())
          scheduleDelivery(ws.id);
      }
    }).catch(error=>ctx.logger?.warn?.('governance Agent routing: '+String(error)));
  }
  if(ctx.agents&&typeof ctx.on==='function'){
    for(const [event,listener] of [
      ['agent/pre-step',injectSkills],
      ['agent/created',({agent})=>{guidance.track(agent);scheduleForAgent(agent);}],
      ['agent/status',({agent,status})=>{guidance.track(agent,status);scheduleForAgent(agent);}],
      ['agent/disposed',({agent})=>guidance.remove(agent)],
      ...['inserted','claimed','discarded'].map(state=>[
        'agent/inbox/'+state,payload=>{
          const observed=guidance.observeInbox(state,payload);
          if(state==='inserted'&&!observed&&!disposed)recognizeManualDelivery(payload);
          if(!observed||disposed)return;
          lastStatus.set(observed.workspaceId,{...lastStatus.get(observed.workspaceId),
            lastInbox:observed});
          if(observed.state==='discarded'){
            const restore=observed.cancellations?
              remediation.requeueCancellation(observed.workspaceId,observed.cancellations):
              observed.tasks?remediation.recordDelivery(observed.workspaceId,observed.sessionId,
                observed.tasks,{delivered:false}):null;
            restore?.catch(error=>ctx.logger?.warn?.('governance delivery receipt: '+String(error)))
              .finally(()=>{if(!disposed)scheduleDelivery(observed.workspaceId,observed.retryAfterMs);});
          }
        }
      ])
    ]){
      const stop=ctx.on(event,listener);
      if(typeof stop==='function')agentDisposers.push(stop);
    }
  }
  const remediation=createRemediationQueue({directory:path.join(path.dirname(policyRoot),'workspace-governance-remediation'),logger:ctx.logger});
  const maintenanceEvents=new Map(),eventWrites=new Map();
  const eventDirectory=path.join(path.dirname(policyRoot),'workspace-governance-events');
  const eventFile=id=>path.join(eventDirectory,id+'.json');
  const guidanceAvailable=typeof ctx.agents?.get==='function'&&
    (typeof ctx.agents?.roots==='function'||typeof ctx.agents?.list==='function'||typeof ctx.agents?.values==='function');
  const record=(id,type,relative,detail,meta={})=>{
    const event={id:randomUUID(),type,path:relative,detail,at:new Date().toISOString(),...meta};
    const previous=eventWrites.get(id)||Promise.resolve();
    const pending=previous.catch(()=>{}).then(async()=>{
      const events=await history(id);
      const latest=[event,...events].slice(0,60);
      await fsPromises.mkdir(eventDirectory,{recursive:true});
      const temp=eventFile(id)+'.'+randomUUID()+'.tmp';
      try{
        await fsPromises.writeFile(temp,JSON.stringify(latest),{flag:'wx',mode:0o600});
        await fsPromises.rename(temp,eventFile(id));
        maintenanceEvents.set(id,latest);
      }finally{await fsPromises.rm(temp,{force:true}).catch(()=>{});}
    }).catch(error=>ctx.logger?.warn?.('governance maintenance history: '+String(error)));
    eventWrites.set(id,pending);
  };
  const history=async id=>{
    if(maintenanceEvents.has(id))return maintenanceEvents.get(id);
    try{
      const events=JSON.parse(await fsPromises.readFile(eventFile(id),'utf8'));
      if(Array.isArray(events)){maintenanceEvents.set(id,events.slice(0,60));return maintenanceEvents.get(id);}
    }catch(error){if(error.code!=='ENOENT')ctx.logger?.warn?.('governance history load: '+String(error));}
    return [];
  };
  // Changes are evidence of a file edit, not proof that an Agent performed it.
  const internalChanges=new Map();
  const capacityIndex=createCapacityIndex({onUpdated:(ws,previous,next)=>{
    if(!previous||previous.truncated||next.truncated||
       [previous,next].some(scan=>scan.issues.some(issue=>INTEGRITY_ISSUES.has(issue.type))))return;
    const files=tree=>{
      const result=new Map();
      const visit=node=>{
        if(node.type==='file')result.set(node.path,node);
        else for(const child of node.children??[])visit(child);
      };
      visit(tree);
      return result;
    };
    const before=files(previous.tree),after=files(next.tree);
    for(const relative of new Set([...before.keys(),...after.keys()])){
      const old=before.get(relative),now=after.get(relative);
      const key=ws.id+'\0'+relative,internalDigest=internalChanges.get(key);
      internalChanges.delete(key);
      if(old?.digest===now?.digest||(internalDigest!==undefined&&internalDigest===now?.digest))continue;
      const detail=!old?'新增 Markdown 文件':!now?'删除 Markdown 文件':'Markdown 内容已修改';
      record(ws.id,'changed',relative,detail,{
        ...(old?{beforeChars:old.chars}:{}),...(now?{afterChars:now.chars}:{})});
    }
  }});
  // Advisory-only plugin: native tools retain original outcomes.
  let disposed=false;
  // All consumers share the same scan projection. No independent UI cache or inferred count delta.
  function invalidate(id){
    capacityIndex.invalidate(id);
    scheduleReconcile(id);
  }
  // Event and cooldown driven. Never periodically scan the repository.
  function scheduleDelivery(id,delay=0){
    if(disposed)return;
    if(deliveryRunning.has(id)){deliveryAgain.add(id);return;}
    if(deliveryTimers.has(id))clearTimeout(deliveryTimers.get(id));
    deliveryTimers.set(id,setTimeout(async()=>{
      deliveryTimers.delete(id);
      deliveryRunning.add(id);
      let retryAfterMs=null;
      try{
        const registry=await registryReady,ws=registry.find(id);
        if(!ws)return;
        await externalDeliveries.get(path.resolve(ws.root).toLowerCase());
        if(disposed)return;
        const queue=await remediation.list(id);
        if(!queue.verified||queue.policyVersion!==ws.policy.version){scheduleReconcile(id,0);return;}
        const cancelled=await guidance.cancel(ws,queue);
        for(const recipient of cancelled.results??[]){
          if(recipient.status==='queued'&&recipient.inboxStatus!=='discarded')
            await remediation.recordCancellationDelivery(id,recipient.sessionId,recipient.items);
          else if(recipient.retryAfterMs!==undefined||recipient.inboxStatus==='discarded')
            retryAfterMs=Math.min(retryAfterMs??Infinity,recipient.retryAfterMs??100);
        }
        const latestWs=registry.find(id),latestQueue=await remediation.list(id);
        if(!latestWs||!latestQueue.verified||latestQueue.policyVersion!==latestWs.policy.version){
          scheduleReconcile(id,0);return;
        }
        const result=await guidance.send(latestWs,latestQueue);
        for(const recipient of result.results??[]){
          if(recipient.status==='queued'&&recipient.inboxStatus!=='discarded'&&recipient.tasks?.length){
            await remediation.recordDelivery(id,recipient.sessionId,recipient.tasks,{workspace:registry.find(id)});
            if(registry.find(id)?.policy.version!==latestQueue.policyVersion)scheduleDelivery(id,50);
          }
        }
        if(!disposed){
          lastStatus.set(id,{...lastStatus.get(id),lastDelivery:result});
          if(result.retryAfterMs!==undefined)
            retryAfterMs=retryAfterMs===null?result.retryAfterMs:Math.min(retryAfterMs,result.retryAfterMs);
        }
      }catch(error){
        ctx.logger?.warn?.('governance Agent delivery: '+String(error));
        if(!disposed)retryAfterMs=10000;
      }finally{
        deliveryRunning.delete(id);
        if(!disposed){
          if(deliveryAgain.delete(id))scheduleDelivery(id,50);
          else if(retryAfterMs!==null)scheduleDelivery(id,retryAfterMs);
        }
      }
    },delay));
  }
  function scheduleReconcile(id,delay=450){
    if(disposed)return;
    if(reconcileTimers.has(id))clearTimeout(reconcileTimers.get(id));
    reconcileTimers.set(id,setTimeout(async()=>{
      reconcileTimers.delete(id);
      try{
        const registry=await registryReady,ws=registry.find(id);
        if(!ws)return;
        await getScan(registry,id);
        scheduleDelivery(id);
      }catch(error){ctx.logger?.warn?.('remediation background scan: '+String(error));}
    },delay));
  }
  function unwatch(id){
    try{watchers.get(id)?.close();}catch{}watchers.delete(id);
    if(reconcileTimers.has(id))clearTimeout(reconcileTimers.get(id));reconcileTimers.delete(id);
  }
  function unwatchDelivery(id){
    if(deliveryTimers.has(id))clearTimeout(deliveryTimers.get(id));
    deliveryTimers.delete(id);deliveryAgain.delete(id);
  }
  // Retry attaching a failed watcher; only rescan when watching resumes.
  function scheduleWatchRetry(ws){
    if(disposed||watchRetryTimers.has(ws.id))return;
    const wait=Math.max(100,30050-(Date.now()-(watchFailures.get(ws.id)??0)));
    watchRetryTimers.set(ws.id,setTimeout(()=>{
      watchRetryTimers.delete(ws.id);
      if(disposed)return;
      registryReady.then(registry=>{
        if(disposed)return;
        const current=registry.find(ws.id);
        if(!current)return;
        watchWorkspace(current);
        if(watchers.has(ws.id)){
          capacityIndex.invalidate(ws.id);
          scheduleReconcile(ws.id,50);
        }else scheduleWatchRetry(current);
      }).catch(error=>ctx.logger?.warn?.('governance watcher retry: '+String(error)));
    },wait));
  }
  function watchWorkspace(ws){
    if(disposed||watchers.has(ws.id)||Date.now()-(watchFailures.get(ws.id)??0)<30000)return;
    try {
      const watcher=fs.watch(ws.root,{recursive:process.platform==='win32'},(event,filename)=>{
        const relative=filename==null?'':String(filename).replace(/\\/g,'/');
        if(relative.split('/').some(segment=>IGNORED.has(segment))||
           relative.includes('.wg-restore-'))return;
        if(relative&&path.posix.extname(relative).toLowerCase()==='.md'){
          capacityIndex.markDirty(ws.id,relative);
        }
        else if(!relative||event==='rename')capacityIndex.invalidate(ws.id);
        else return; // Non-Markdown content does not affect the capacity tree.
        scheduleReconcile(ws.id);
      });
      watcher.on('error',error=>{
        ctx.logger?.warn?.('governance watcher: '+String(error));
        unwatch(ws.id);watchFailures.set(ws.id,Date.now());invalidate(ws.id);scheduleWatchRetry(ws);
      });
      watchers.set(ws.id,watcher);watchFailures.delete(ws.id);
      if(watchRetryTimers.has(ws.id))clearTimeout(watchRetryTimers.get(ws.id));
      watchRetryTimers.delete(ws.id);
    }catch(error){
      watchFailures.set(ws.id,Date.now());
      ctx.logger?.warn?.('governance watcher unavailable: '+String(error));
      scheduleWatchRetry(ws);
    }
  }
  async function getScan(registry,id,force=false){
    const ws=registry.find(id);
    if(!ws)throw Error('Unknown workspace');
    watchWorkspace(ws);
    try{
      const last=lastStatus.get(id);
      const fallback=!watchers.has(id)&&(!last?.at||Date.now()-Date.parse(last.at)>=30000);
      let value=await capacityIndex.get(ws,{force:force||fallback});
      let latest=registry.find(id);
      for(let retry=0;retry<3&&latest&&latest.policy.version!==value.policyVersion;retry++){
        capacityIndex.invalidate(id);
        value=await capacityIndex.get(latest);
        latest=registry.find(id);
      }
      if(!latest||latest.policy.version!==value.policyVersion)
        throw Error('Workspace policy changed during scan');
      const status=lastStatus.get(id);
      if(!disposed&&(!status?.ok||status.fingerprint!==value.fingerprint)){
        await remediation.reconcile(latest,value);
        if(registry.find(id)?.policy.version===value.policyVersion)scheduleDelivery(id);
        else scheduleReconcile(id,0);
        if(capacityIndex.isCurrent(id,value)||value.truncated||value.issues.some(issue=>INTEGRITY_ISSUES.has(issue.type)))
          lastStatus.set(id,{...lastStatus.get(id),ok:true,at:value.updatedAt,fingerprint:value.fingerprint});
        else scheduleReconcile(id);
      }
      return value;
    }catch(error){
      lastStatus.set(id,{ok:false,error:String(error.message)});
      throw error;
    }
  }
  registryReady.then(registry=>{
    for(const ws of registry.snapshot().workspaces){watchWorkspace(ws);scheduleReconcile(ws.id,50);}
  }).catch(error=>ctx.logger?.error?.('governance state load: '+String(error)));
  ctx.effect(()=>{
    const unregister=ctx.webServer.register({kind:'prefix',path:PREFIX,handler:async(req,res)=>{
      const url=new URL(req.url,'http://localhost'), route=url.pathname.slice(PREFIX.length)||'/';
      if(!sameOrigin(req))return respond(res,403,{ok:false,error:'Untrusted origin'});
      if(!['GET','POST','PUT','DELETE'].includes(req.method))return respond(res,405,{ok:false,error:'Method not allowed'});
      if(req.method!=='GET'&&req.headers?.['x-wg-request']!=='1')return respond(res,403,{ok:false,error:'Missing action header'});
      try {
        const registry=await registryReady;
        if(req.method==='GET'&&route==='/workspaces')return respond(res,200,{ok:true,...registry.snapshot()});
        if(req.method==='GET'&&route==='/tree'){
          const id=url.searchParams.get('id');
          return respond(res,200,{ok:true,scan:await getScan(registry,id)});
        }
        if(req.method==='GET'&&route==='/maintenance'){
          const id=url.searchParams.get('id');
          const ws=registry.find(id);
          if(!ws)throw Error('Unknown workspace');
          const pendingTasks=await remediation.list(id);
          await eventWrites.get(id);
          return respond(res,200,{ok:true,available:true,
            mode:effectiveCapacityMode(ws.policy),
            workspaceId:id,policyVersion:ws.policy.version,
            warningPercent:Math.round(ws.policy.warningRatio*100),
            optimizationPercent:effectiveOptimizationPercent(ws.policy),
            skillSettings:effectiveSkillSettings(ws.policy),
            skillPromptDefaults:{customPrompt:DEFAULT_CUSTOM_PROMPT,embeddedPrompt:DEFAULT_EMBEDDED_PROMPT,
              customCancelPrompt:DEFAULT_CUSTOM_CANCEL_PROMPT,embeddedCancelPrompt:DEFAULT_EMBEDDED_CANCEL_PROMPT},
            indexCacheEntries:capacityIndex.size(),
            advisoryMode:'running-agent-steer',deliveryAvailable:guidanceAvailable,
            lastDelivery:lastStatus.get(id)?.lastDelivery??null,
            lastInbox:lastStatus.get(id)?.lastInbox??null,
            remediation:{...pendingTasks,tasks:pendingTasks.tasks.slice(0,12)},events:await history(id)});
        }
        if(req.method==='GET'&&route==='/remediation'){
          const id=url.searchParams.get('id');
          if(!registry.find(id))throw Error('Unknown workspace');
          return respond(res,200,{ok:true,remediation:await remediation.list(id)});
        }
        if(req.method==='DELETE'&&route==='/logs'){
          const input=await jsonBody(req);
          if(typeof input.id!=='string'||typeof input.eventId!=='string'||!input.eventId)throw Error('Invalid log deletion request');
          if(!registry.find(input.id))throw Error('Unknown workspace');
          return await withWorkspaceLock(input.id,async()=>{
            await (eventWrites.get(input.id)??Promise.resolve());
            const current=await history(input.id);
            if(!current.some(event=>event.id===input.eventId))throw Error('Not found');
            const remaining=current.filter(event=>event.id!==input.eventId);
            const temp=eventFile(input.id)+'.'+randomUUID()+'.tmp';
            await fsPromises.mkdir(eventDirectory,{recursive:true});
            try{
              await fsPromises.writeFile(temp,JSON.stringify(remaining),{flag:'wx',mode:0o600});
              await fsPromises.rename(temp,eventFile(input.id));
            }finally{await fsPromises.rm(temp,{force:true}).catch(()=>{});}
            maintenanceEvents.set(input.id,remaining);
            return respond(res,200,{ok:true,deletedId:input.eventId});
          });
        }
        if(req.method==='PUT'&&route==='/mode'){
          const input=await jsonBody(req);
          const policy=await withWorkspaceLock(input.id,()=>registry.updateCapacityMode(input.id,input.mode,input.expectedVersion));
          invalidate(input.id);
          return respond(res,200,{ok:true,policy});
        }
        if(req.method==='PUT'&&route==='/skill-settings'){
          const input=await jsonBody(req);
          const policy=await withWorkspaceLock(input.id,()=>registry.updateSkillSettings(input.id,input.settings,input.expectedVersion));
          invalidate(input.id);
          for(const invalidate of invalidateSkillCatalog)invalidate();
          return respond(res,200,{ok:true,policy});
        }
        if(req.method==='GET'&&route==='/status')return respond(res,200,{ok:true,watching:[...watchers.keys()],lastStatus:Object.fromEntries(lastStatus)});
        if(req.method==='POST'&&route==='/workspaces'){
          const input=await jsonBody(req),ws=await registry.add(input.root,{manual:input.manual===true});
          watchWorkspace(ws);scheduleReconcile(ws.id,50);
          for(const invalidate of invalidateSkillCatalog)invalidate();
          return respond(res,200,{ok:true,workspace:ws});
        }
        if(req.method==='DELETE'&&route==='/workspaces'){
          const input=await jsonBody(req);
          const root=await withWorkspaceLock(input.id,()=>registry.suspend(input.id));
          unwatch(input.id);unwatchDelivery(input.id);
          if(watchRetryTimers.has(input.id))clearTimeout(watchRetryTimers.get(input.id));
          watchRetryTimers.delete(input.id);watchFailures.delete(input.id);guidance.forget(input.id);
          capacityIndex.forget(input.id);lastStatus.delete(input.id);remediation.forget(input.id);
          for(const invalidate of invalidateSkillCatalog)invalidate();
          return respond(res,200,{ok:true,root,suspended:true});
        }
        if(req.method==='PUT'&&route==='/rules'){
          const input=await jsonBody(req);
          if(!['directories','files'].includes(input.scope)||typeof input.relative!=='string')throw Error('Invalid rule scope');
          const result=await withWorkspaceLock(input.id,()=>registry.updateRule(input.id,input.scope,input.relative,input.rule,input.expectedVersion));
          invalidate(input.id);
          return respond(res,200,{ok:true,policy:result});
        }
        if(req.method==='PUT'&&route==='/defaults'){
          const input=await jsonBody(req);
          const policy=await withWorkspaceLock(input.id,()=>registry.updateDefaults(input.id,{
            defaultFileLimit:input.defaultFileLimit,warningRatio:input.warningRatio,aggregateLimit:input.aggregateLimit,
            optimizationPercent:input.optimizationPercent,
          },input.expectedVersion));
          invalidate(input.id);
          return respond(res,200,{ok:true,policy});
        }
        if(req.method==='POST'&&route==='/scan'){
          const input=await jsonBody(req);
          const scan=await getScan(registry,input.id,true);
          scheduleDelivery(input.id);
          return respond(res,200,{ok:true,scan});
        }
        if(req.method==='POST'&&route==='/restore'){
          const input=await jsonBody(req),ws=registry.find(input.id);
          if(!ws)throw Error('Unknown workspace');
          return await withWorkspaceLock(ws.id,async()=>{
          const file=await safeDocument(ws,input.path);
          if(isProtectedDocument(ws.policy,file.relative))throw Error('Protected document');
          if(input.confirmed!==true||!/^[0-9a-f]{64}$/.test(input.backupHash||'')||!/^[0-9a-f]{64}$/.test(input.expectedHash||''))throw Error('Invalid restore request');
          const backup=await fsPromises.readFile(backupPath(ws.id,input.backupHash),'utf8');
          if(createHash('sha256').update(backup).digest('hex')!==input.backupHash)throw Error('Invalid backup digest');
          const now=await fsPromises.readFile(file.target,'utf8');
          if(createHash('sha256').update(now).digest('hex')!==input.expectedHash)throw Error('Changed since recorded version');
          const temp=file.target+'.wg-restore-'+randomUUID();
          try{
            await fsPromises.writeFile(temp,backup,{flag:'wx',mode:file.stat.mode});
            if(createHash('sha256').update(await fsPromises.readFile(file.target)).digest('hex')!==input.expectedHash)throw Error('Stale version');
            await fsPromises.rename(temp,file.target);
          }finally{await fsPromises.rm(temp,{force:true}).catch(()=>{});}
          internalChanges.set(ws.id+'\0'+file.relative,input.backupHash);
          capacityIndex.markDirty(ws.id,file.relative);scheduleReconcile(ws.id);
          const mode=effectivePolicy(ws.policy,file.relative).mode;
          record(ws.id,'restored',file.relative,'经人工批准且通过版本校验，已恢复先前快照',{
            expectedHash:input.expectedHash,beforeChars:countCharacters(now,mode),afterChars:countCharacters(backup,mode)});
          await eventWrites.get(ws.id);
          return respond(res,200,{ok:true,path:file.relative,restoredHash:input.backupHash});
          });
        }
        return respond(res,404,{ok:false,error:'Not found'});
      }catch(error){ctx.logger?.warn?.('governance API: '+String(error));return respond(res,statusCode(error),{ok:false,error:String(error.message||error)});}
    }});
    return ()=>{
      disposed=true;
      for(const id of [...reconcileTimers.keys()]){clearTimeout(reconcileTimers.get(id));reconcileTimers.delete(id);}
      for(const id of [...watchers.keys()])unwatch(id);
      for(const id of [...deliveryTimers.keys()])unwatchDelivery(id);
      for(const timer of watchRetryTimers.values())clearTimeout(timer);
      watchRetryTimers.clear();
      for(const stop of agentDisposers){try{stop();}catch(error){ctx.logger?.warn?.('governance agent listener cleanup: '+String(error));}}
      unregister?.();
    };
  },'workspace-governance: API and watchers');
}
export default {name,inject,apply};
