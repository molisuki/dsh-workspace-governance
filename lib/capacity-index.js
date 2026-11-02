import {scanWorkspace,patchScanDocument,INTEGRITY_ISSUES} from './core.js';

/**
 * Single per-workspace scan authority shared by UI and advisory remediation.
 * Watch notifications enqueue paths; only those files are re-read from disk.
 * Topology/policy uncertainty is resolved by a full scan, not a guessed delta.
 */
export function createCapacityIndex({scan=scanWorkspace,patch=patchScanDocument,onUpdated}={}){
 const workspaces=new Map();
 const entry=id=>{
  if(!workspaces.has(id))workspaces.set(id,{
   value:null,version:null,workspace:null,revision:0,dirty:new Set(),full:true,unverified:false,pending:null
  });
  return workspaces.get(id);
 };
 function invalidate(id){
  const item=entry(id);
  item.revision++;item.full=true;item.dirty.clear();
 }
 function markDirty(id,relative){
  const item=entry(id);
  item.revision++;
  if(typeof relative!=='string'||!relative)invalidate(id);
  else if(!item.full)item.dirty.add(relative);
 }
 async function get(ws,{force=false}={}){
  const item=entry(ws.id);
  item.workspace=ws;
  if(item.version!==ws.policy.version){
   item.version=ws.policy.version;
   invalidate(ws.id);
  }
  if(force&&!(item.pending&&item.full))invalidate(ws.id);
  if(item.pending)return item.pending;
  if(item.value&&!item.full&&!item.dirty.size)return item.value;
  const pending=(async()=>{
   for(let attempt=0;attempt<4;attempt++){
    const revision=item.revision,paths=[...item.dirty],current=item.workspace;
    let next;
    if(item.full||!item.value)next=await scan(current);
    else{
     next=item.value;
     for(const changed of paths){
      next=await patch(current,next,changed);
      if(!next){next=await scan(current);break;}
     }
    }
    if(item.revision!==revision)continue;
    item.dirty.clear();
    // Keep incomplete snapshots for cheap UI display; never treat them as verified.
    // Subsequent filesystem events and explicit refresh requests still re-read the disk.
    item.unverified=next.truncated||next.issues.some(issue=>INTEGRITY_ISSUES.has(issue.type));
    const previous=item.value;
    item.value=next;item.full=false;
    if(previous!==next)onUpdated?.(current,previous,next);
    return next;
   }
   throw Error('Unstable workspace scan; file changes continue during validation');
  })();
  item.pending=pending;
  try{return await pending;}
  finally{if(item.pending===pending)item.pending=null;}
 }
 function isCurrent(id,value){
  const item=workspaces.get(id);
  return !!item&&item.value===value&&!item.full&&!item.dirty.size&&!item.unverified;
 }
 function forget(id){workspaces.delete(id);}
 return {get,markDirty,invalidate,isCurrent,forget,size:()=>workspaces.size};
}
