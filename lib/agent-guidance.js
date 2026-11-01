import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {effectiveCapacityMode} from './core.js';
import {skillStrategyFeedback} from './skill-strategy.js';

const canonical=root=>path.resolve(root).replace(/[\\/]+$/,'').toLowerCase();
const equalWorkspace=(agent,ws)=>typeof agent?.session?.header?.cwd==='string'&&
  canonical(agent.session.header.cwd)===canonical(ws.root);
const maximumTasks=3;
const defaultCooldownMs=90000;
const defaultRetryMs=10000;

/**
 * Dispatch verified advisory tasks through the native AgentRegistry and inbox.
 * Submission is not evidence of model consumption. Native writes remain untouched.
 */
export function createAgentGuidance({agents,logger,now=()=>Date.now(),cooldownMs=defaultCooldownMs,retryMs=defaultRetryMs}={}){
  const live=new Map(),lastSent=new Map(),inFlight=new Set(),messages=new Map(),activeTurnNotified=new Set();
  const sessionId=agent=>String(agent.session?.id??agent.session?.header?.id??agent.id);
  const track=(agent,status)=>{
    if(typeof agent?.id!=='string')return;
    live.set(agent.id,{agent,status:status??agent.status});
    if(status==='idle'||agent.status==='idle')activeTurnNotified.delete(sessionId(agent));
  };
  const remove=agent=>{
    if(!agent?.id)return;
    if(live.get(agent.id)?.agent===agent)live.delete(agent.id);
    activeTurnNotified.delete(sessionId(agent));
  };
  function candidates(ws){
    // AgentRegistry.roots() is the authoritative runtime ownership boundary.
    const roots=typeof agents?.roots==='function';
    const pool=roots?agents.roots():typeof agents?.list==='function'?agents.list():
      typeof agents?.values==='function'?[...agents.values()]:[...live.values()].map(x=>x.agent);
    const seen=new Set();
    const eligible=pool.filter(agent=>{
      if(!agent||typeof agent.id!=='string'||seen.has(agent.id))return false;
      seen.add(agent.id);
      if(typeof agents?.get==='function'&&agents.get(agent.id)!==agent)return false;
      return agent.status==='running'&&
        (roots||!agent.session?.header?.parentSession)&&
        equalWorkspace(agent,ws)&&typeof agent.steer==='function';
    });
    return eligible;
  }
  function format(ws,tasks){
    const text=[
      'WORKSPACE_GOVERNANCE: ADVISORY',
      ...tasks.map(task=>[
        '范围：'+(task.kind==='directory'?'目录 ':'文件 ')+JSON.stringify(task.path),
        '容量：'+task.current+'/'+task.limit+'；触发阈值：'+task.triggerPercent+'%；目标精简：'+task.reductionPoints+' 个百分点；目标使用率：'+task.targetPercent+'%；目标字符数：'+task.targetChars+'；建议至少削减：'+task.requiredReduction+' 字符。',
        ...(task.protected?['受保护文档：修改须取得独立授权。']:[])
      ].join('\n'))
    ].join('\n');
    const first=tasks.find(t=>t.kind==='file');
    if(!first)return text;
    const target={percent:first.reductionPoints,triggerPercent:first.triggerPercent,
      targetUsagePercent:first.targetPercent,targetCount:first.targetChars,
      requiredReduction:first.requiredReduction};
    const strategy=skillStrategyFeedback(ws.policy,first.path,
      {limit:first.limit,projected:first.current},target,first.trigger);
    return text+(strategy?'\n\n'+strategy:'\n操作须符合当前任务授权，并保全有效事实、约束及结构。');
  }
  function matchTasks(tasks,changedPaths){
    if(changedPaths===undefined)return tasks;
    if(!changedPaths?.length)return [];
    const changed=new Set(changedPaths);
    return tasks.filter(task=>task.kind==='directory'?
      [...changed].some(file=>task.path===''||file.startsWith(task.path+'/')):
      changed.has(task.path));
  }
  async function send(ws,queue,{changedPaths}={}){
    if(effectiveCapacityMode(ws.policy)==='off'||!queue?.verified||!queue.tasks?.length)
      return {status:'skipped'};
    const matching=matchTasks(queue.tasks,changedPaths);
    if(!matching.length)return {status:'skipped'};
    const targets=candidates(ws);
    if(!targets.length)return {status:'no-running-agent'};
    const results=await Promise.all(targets.map(async agent=>{
      const recipient=sessionId(agent),key=ws.id+'|'+recipient,previous=lastSent.get(key);
      if(agent.status!=='running')return {status:'no-running-agent',agentId:agent.id};
      if(inFlight.has(key))return {status:'pending',agentId:agent.id,retryAfterMs:100};
      // The queue is the source of truth. Record fingerprints per recipient, not per batch.
      const currentIds=new Set(matching.map(task=>task.id));
      if(previous)for(const id of previous.fingerprints.keys())
        if(!currentIds.has(id))previous.fingerprints.delete(id);
      const unsent=matching.filter(task=>{
        const episode=task.episodeId??task.fingerprint;
        return previous?.fingerprints.get(task.id)!==episode&&task.deliveredTo?.[recipient]!==episode;
      });
      if(!unsent.length)return {status:'unchanged',agentId:agent.id};
      if(activeTurnNotified.has(recipient))return {status:'in-progress',agentId:agent.id};
      const remaining=previous?cooldownMs-(now()-previous.at):0;
      if(remaining>0)return {status:'cooldown',agentId:agent.id,retryAfterMs:remaining};
      const batch=unsent.slice(0,maximumTasks);
      const message=Object.freeze({id:randomUUID(),role:'user',
        content:Object.freeze([{type:'text',text:format(ws,batch)}]),
        source:Object.freeze({kind:'workspace-governance'})});
      const entry={workspaceId:ws.id,agentId:agent.id,sessionId:recipient,taskIds:batch.map(t=>t.id),
        episodes:batch.map(t=>t.episodeId??t.fingerprint),state:'submitted'};
      messages.set(message.id,entry);
      if(messages.size>1000)messages.delete(messages.keys().next().value);
      inFlight.add(key);
      try{
        // Recheck immediately before native injection; never wake an idle Agent.
        if(agent.status!=='running'){
          messages.delete(message.id);
          return {status:'no-running-agent',agentId:agent.id};
        }
        await agent.steer(message);
        activeTurnNotified.add(recipient);
        const fingerprints=new Map(previous?.fingerprints??[]);
        for(const task of batch)fingerprints.set(task.id,task.episodeId??task.fingerprint);
        lastSent.set(key,{at:now(),fingerprints});
        if(entry.state==='discarded')for(const task of batch)fingerprints.delete(task.id);
        return {status:'queued',agentId:agent.id,sessionId:recipient,messageId:message.id,
          inboxStatus:entry.state,taskCount:batch.length,
          tasks:batch.map(t=>({id:t.id,fingerprint:t.fingerprint,episodeId:t.episodeId})),
          ...(unsent.length>maximumTasks?{retryAfterMs:cooldownMs}:{})};
      }catch(error){
        messages.delete(message.id);
        logger?.warn?.('workspace-governance session advisory rejected: '+String(error));
        return {status:'delivery-error',agentId:agent.id,retryAfterMs:retryMs};
      }finally{inFlight.delete(key);}
    }));
    const delivered=results.filter(result=>result.status==='queued').length;
    const retriable=results.map(result=>result.retryAfterMs).filter(Number.isFinite);
    return {status:delivered?'queued':results.some(r=>r.status==='delivery-error')?'delivery-error':
      results.some(r=>r.status==='cooldown')?'cooldown':
      results.some(r=>r.status==='pending')?'pending':
      results.some(r=>r.status==='in-progress')?'in-progress':'unchanged',
      delivered,recipients:targets.length,results,
      ...(retriable.length?{retryAfterMs:Math.max(50,Math.min(...retriable))}:{})};
  }
  function observeInbox(state,{agent,message}={}){
    const entry=messages.get(message?.id);
    if(!entry||agent?.id!==entry.agentId)return null;
    entry.state=state;
    if(state==='discarded'){
      activeTurnNotified.delete(entry.sessionId);
      const previous=lastSent.get(entry.workspaceId+'|'+entry.sessionId);
      if(previous)entry.taskIds.forEach((id,i)=>{
        if(previous.fingerprints.get(id)===entry.episodes[i])previous.fingerprints.delete(id);
      });
    }
    if(state==='claimed'||state==='discarded')messages.delete(message.id);
    return {workspaceId:entry.workspaceId,agentId:entry.agentId,sessionId:entry.sessionId,messageId:message.id,
      state,...(state==='discarded'?{retryAfterMs:retryMs,
        tasks:entry.taskIds.map((id,i)=>({id,episodeId:entry.episodes[i]}))}:{})};
  }
  const forget=id=>{
    for(const key of lastSent.keys())if(key.startsWith(id+'|'))lastSent.delete(key);
    for(const [messageId,entry] of messages)if(entry.workspaceId===id){
      messages.delete(messageId);activeTurnNotified.delete(entry.sessionId);
    }
  };
  return {track,remove,send,observeInbox,forget,liveCount:()=>live.size};
}
