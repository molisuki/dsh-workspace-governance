import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {effectiveCapacityMode,optimizationTarget,isProtectedDocument,effectivePolicy,effectiveDirectoryPolicy,INTEGRITY_ISSUES} from './core.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const validWorkspaceId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(id);
const clone=value=>structuredClone(value);

export function collectRemediationTasks(workspace,scan,{maxTasks=1000}={}){
 if(scan.workspaceId!==workspace.id||scan.policyVersion!==workspace.policy.version)
   throw Error('Stale remediation scan');
 if(scan.truncated||scan.issues.some(item=>INTEGRITY_ISSUES.has(item.type)))
   return {verified:false,reason:'扫描不完整或存在无法验证的文档；既有任务不得自动清除。',tasks:[],total:0,overflow:0};
 const mode=effectiveCapacityMode(workspace.policy);
 if(mode==='off')return {verified:true,mode,tasks:[],total:0,overflow:0};
 const issues=new Map();
 for(const issue of scan.issues){
   if(issue.type!=='overflow'&&issue.type!=='aggregate-overflow')continue;
   const key=(issue.type==='overflow'?'file:':'directory:')+issue.path;
   if(!issues.has(key))issues.set(key,[]);
   issues.get(key).push(issue);
 }
 const tasks=[];
 const visit=node=>{
   if(node.type==='file'||node.type==='folder'&&node.limit!==null&&node.limit!==undefined){
     const kind=node.type==='file'?'file':'directory',key=kind+':'+node.path,limit=node.limit;
     const affected=issues.get(key)||[],current=node.chars;
     const active=mode==='warning'?current>=limit*workspace.policy.warningRatio||affected.length>0:
       current>limit||affected.length>0;
     if(active&&Number.isSafeInteger(current)&&Number.isSafeInteger(limit)&&limit>0){
       const requiredReduction=Math.max(0,...affected.map(item=>Number.isFinite(item.current)&&Number.isFinite(item.limit)?
         Math.ceil(item.current-item.limit):0));
       const target=optimizationTarget(workspace.policy,{limit,projected:current,requiredReduction},mode);
       const id=sha(workspace.id+'\0'+key);
       const fingerprint=sha([mode,key,current,limit,target.targetCount,
         affected.map(item=>[item.type,item.scope,item.line,item.current,item.limit].join(':')).join('|')].join('\0'));
       tasks.push({id,fingerprint,contentDigest:node.digest??null,kind,path:node.path,current,limit,
         usagePercent:Math.round(current/limit*1000)/10,
         trigger:mode,triggerPercent:target.triggerPercent,
         reductionPoints:target.percent,targetPercent:target.targetUsagePercent,
         targetChars:target.targetCount,requiredReduction:target.requiredReduction,
          protected:kind==='file'&&isProtectedDocument(workspace.policy,node.path),
         independentViolations:affected.length});
     }
   }
   for(const child of node.children||[])visit(child);
 };
 visit(scan.tree);
 tasks.sort((a,b)=>Number(b.usagePercent>100)-Number(a.usagePercent>100)||
   b.usagePercent-a.usagePercent||a.path.localeCompare(b.path));
 return {verified:true,mode,total:tasks.length,overflow:Math.max(0,tasks.length-maxTasks),
   tasks:tasks.slice(0,maxTasks)};
}

/** Persistent advisory worklist; not a write barrier and not an agent session injector. */
export function createRemediationQueue({directory,logger,maxTasks=1000}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Absolute remediation state directory required');
 const state=new Map(),serial=new Map();
 const file=id=>{
   if(!validWorkspaceId(id))throw Error('Invalid workspace id');
   return path.join(directory,id+'.json');
 };
 const lock=(id,operation)=>{
   const next=(serial.get(id)||Promise.resolve()).catch(()=>{}).then(operation);
   serial.set(id,next);
   return next.finally(()=>{if(serial.get(id)===next)serial.delete(id);});
 };
 async function load(id){
   if(state.has(id))return state.get(id);
   let value={workspaceId:id,status:'pending-scan',verified:false,mode:null,updatedAt:null,
     reason:'尚未完成独立扫描',total:0,overflow:0,tasks:[],cancellations:[]};
   try{
     const found=JSON.parse(await fs.readFile(file(id),'utf8'));
     if(found.workspaceId===id&&Array.isArray(found.tasks)&&found.tasks.length<=maxTasks&&
        found.tasks.every(t=>typeof t.id==='string'&&typeof t.fingerprint==='string'&&typeof t.path==='string'))
       value={...found,status:'stale',verified:false,reason:'等待本次会话重新扫描确认'};
   }catch(error){if(error.code!=='ENOENT')logger?.warn?.('remediation queue load: '+String(error));}
   state.set(id,value);return value;
 }
 async function persist(id,value){
   await fs.mkdir(directory,{recursive:true});
   const temp=file(id)+'.'+randomUUID()+'.tmp';
   try{
     await fs.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});
     await fs.rename(temp,file(id));
   }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
 }
 const list=id=>lock(id,async()=>clone(await load(id)));
 const reconcile=(workspace,scan)=>lock(workspace.id,async()=>{
   const previous=await load(workspace.id);
   const collected=collectRemediationTasks(workspace,scan,{maxTasks});
   const now=new Date().toISOString();
   const old=new Map(previous.tasks.map(task=>[task.id,task]));
   if(!collected.verified){
     const value={...previous,status:'unverified',verified:false,reason:collected.reason,updatedAt:now};
     state.set(workspace.id,value);await persist(workspace.id,value);
     return clone(value);
   }
    const materialChange=(before,after)=>previous.policyVersion!==workspace.policy.version&&
      ['trigger','limit','triggerPercent','reductionPoints','targetPercent','targetChars']
        .some(key=>before[key]!==after[key]);
    const replaced=new Set();
    const tasks=collected.tasks.map(task=>{
      const earlier=old.get(task.id),changed=earlier&&materialChange(earlier,task);
      if(changed)replaced.add(task.id);
      const episodeId=!changed&&earlier?.episodeId||randomUUID();
      const deliveredTo=changed?{}:Object.fromEntries(Object.keys(earlier?.deliveredTo??{})
        .map(recipient=>[recipient,episodeId]));
      return {...task,episodeId,detectedAt:changed?now:earlier?.detectedAt??now,deliveredTo};
    });
    // A verified policy change can make a previously delivered instruction obsolete.
    // Retain one cancellation per recipient until its native inbox accepts it.
    const active=new Map(tasks.map(task=>[task.id,task]));
    const nodes=new Map();
    const indexNode=node=>{
      nodes.set(node.type+'\0'+node.path,node);
      for(const child of node.children??[])indexNode(child);
    };
    indexNode(scan.tree);
    const currentValues=item=>{
      const node=nodes.get((item.kind==='file'?'file':'folder')+'\0'+item.path);
      const limit=node?.limit??(item.kind==='file'?effectivePolicy(workspace.policy,item.path).fileLimit:
        effectiveDirectoryPolicy(workspace.policy,item.path).aggregateLimit);
      return {current:node?.chars??null,limit:limit??null};
    };
    const cancellations=(previous.cancellations??[]).filter(item=>
      !active.has(item.taskId)||item.episodeId&&active.get(item.taskId).episodeId!==item.episodeId)
      .map(item=>({...item,...currentValues(item)}));
    const known=new Set(cancellations.map(item=>item.id));
    for(const previousTask of previous.tasks){
      const present=nodes.has((previousTask.kind==='file'?'file':'folder')+'\0'+previousTask.path);
      if((previous.policyVersion===workspace.policy.version&&present)||
         active.has(previousTask.id)&&!replaced.has(previousTask.id))continue;
      for(const [recipient,episode] of Object.entries(previousTask.deliveredTo??{})){
        if(episode!==previousTask.episodeId)continue;
        const id=sha(previousTask.id+'\0'+episode+'\0'+recipient);
        if(known.has(id))continue;
        cancellations.push({id,taskId:previousTask.id,episodeId:previousTask.episodeId,
          recipient,kind:previousTask.kind,path:previousTask.path,
          previousTarget:previousTask.targetChars,...currentValues(previousTask)});
        known.add(id);
      }
    }
    const value={workspaceId:workspace.id,status:'verified',verified:true,mode:collected.mode,reason:null,policyVersion:workspace.policy.version,scanFingerprint:scan.fingerprint,
     updatedAt:now,total:collected.total,overflow:collected.overflow,tasks,cancellations};
   state.set(workspace.id,value);await persist(workspace.id,value);
   return clone(value);
 });
  // Persist verified delivery receipts through one serialized state transition.
  const updateVerified=(id,mutate)=>lock(id,async()=>{
    const previous=await load(id);
    if(!previous.verified)return 0;
    const changed=mutate(previous);
    if(changed){state.set(id,previous);await persist(id,previous);}
    return changed;
  });
  const recordDelivery=async(id,agentId,items,{delivered=true,workspace}={})=>{
    if(typeof agentId!=='string'||!agentId||!Array.isArray(items)||items.length>1000)
      throw Error('Invalid advisory delivery receipt');
    return updateVerified(id,previous=>{
      let changed=0;
      const byId=new Map(previous.tasks.map(task=>[task.id,task]));
      for(const item of items){
        const task=byId.get(item.id);
        if(!task||(item.episodeId?task.episodeId!==item.episodeId:task.fingerprint!==item.fingerprint)){
          // A native acceptance may finish after a policy revision replaced its task.
          if(!delivered||!workspace||workspace.policy.version!==previous.policyVersion||
             item.policyVersion===undefined||item.policyVersion===previous.policyVersion||
             !['file','directory'].includes(item.kind)||typeof item.path!=='string'||
             typeof item.episodeId!=='string'||!Number.isSafeInteger(item.targetChars))continue;
          const cancellationId=sha(item.id+'\0'+item.episodeId+'\0'+agentId);
          if((previous.cancellations??[]).some(c=>c.id===cancellationId))continue;
          const currentLimit=task?.limit??(item.kind==='file'?effectivePolicy(workspace.policy,item.path).fileLimit:
            effectiveDirectoryPolicy(workspace.policy,item.path).aggregateLimit);
          (previous.cancellations??=[]).push({id:cancellationId,taskId:item.id,episodeId:item.episodeId,
            recipient:agentId,kind:item.kind,path:item.path,previousTarget:item.targetChars,
            current:task?.current??null,limit:currentLimit??null});
          changed++;
          continue;
        }
        const receipts=task.deliveredTo??{};
        if(delivered&&receipts[agentId]!==task.episodeId){
          task.deliveredTo={...receipts,[agentId]:task.episodeId};changed++;
        }else if(!delivered&&receipts[agentId]===task.episodeId){
          const updated={...receipts};delete updated[agentId];task.deliveredTo=updated;changed++;
        }
      }
      return changed;
    });
  };
  const recordCancellationDelivery=(id,recipient,items)=>updateVerified(id,previous=>{
    if(!Array.isArray(items))return 0;
    const accepted=new Set(items.map(item=>item.id));
    const remaining=(previous.cancellations??[]).filter(item=>item.recipient!==recipient||!accepted.has(item.id));
    const removed=(previous.cancellations??[]).length-remaining.length;
    if(removed)previous.cancellations=remaining;
    return removed;
  });
  const requeueCancellation=(id,items)=>lock(id,async()=>{
    if(!Array.isArray(items)||!items.length)return 0;
    const previous=await load(id);
    const active=new Map(previous.tasks.map(task=>[task.id,task]));
    const known=new Set((previous.cancellations??[]).map(item=>item.id));
    let added=0;
    for(const item of items){
      if(typeof item.id!=='string'||typeof item.recipient!=='string'||
         typeof item.taskId!=='string'||known.has(item.id)||
         active.has(item.taskId)&&(!item.episodeId||active.get(item.taskId).episodeId===item.episodeId))continue;
      (previous.cancellations??=[]).push(item);known.add(item.id);added++;
    }
    if(added){state.set(id,previous);await persist(id,previous);}
    return added;
  });
  const forget=id=>{state.delete(id);};
  return {list,reconcile,recordDelivery,recordCancellationDelivery,requeueCancellation,forget};
}
