import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {validateSkillSettings} from './skill-strategy.js';
import { createHash, randomUUID } from 'node:crypto';

export const IGNORED = new Set(['.git','node_modules','.next','dist','build','.turbo','.cache','.venv','coverage','.dsh']);
export const EXTENSIONS = new Set(['.md']);
export const INTEGRITY_ISSUES = new Set(['unreadable-directory','unreadable-document','invalid-encoding','oversized-document']);
export const DEFAULT_POLICY = Object.freeze({ defaultFileLimit:2400, warningRatio:0.8, capacityMode:'overflow', directories:{}, files:{}, version:1 });
export const DEFAULT_OPTIMIZATION_PERCENT=10;
export function effectiveOptimizationPercent(policy){return policy.optimizationPercent??DEFAULT_OPTIMIZATION_PERCENT;}
/** Shared advisory target; never grants write or deletion authority. */
export function optimizationTarget(policy,decision,trigger=effectiveCapacityMode(policy)==='warning'?'warning':'overflow'){
  const percent=effectiveOptimizationPercent(policy);
  const triggerPercent=trigger==='warning'?Math.round(policy.warningRatio*100):100;
  const targetUsagePercent=Math.max(0,triggerPercent-percent);
  const targetCount=Math.floor(decision.limit*targetUsagePercent/100);
  return {percent,triggerPercent,targetUsagePercent,targetCount,
    requiredReduction:Math.max(0,decision.projected-targetCount,decision.requiredReduction??0)};
}
export const CAPACITY_MODES=Object.freeze(['warning','overflow','off']);
export function effectiveCapacityMode(policy){return policy.capacityMode??'overflow';}
const defaultState = () => ({schema:1, revision:0, workspaces:[], selected:null});
const hash = value => createHash('sha256').update(value).digest('hex');
const norm = value => value.split(path.sep).join('/');
const validRelative = value => typeof value==='string' && value!=='' && !path.isAbsolute(value) && !value.split(/[\\/]/).some(x=>['..','__proto__','constructor','prototype'].includes(x)) && !value.includes('\0');
export function loadWorkspacePolicySync(root,directory=policyDirectory()){
  const record=JSON.parse(readFileSync(workspacePolicyPath(root,directory),'utf8'));
  if(rootKey(record.root)!==rootKey(root))throw Error('Workspace policy identity mismatch');
  return validatePolicy(structuredClone(record.policy));
}
export const countCharacters = (source,mode='strict') => {
  if(mode==='strict') return Array.from(source).length;
  let total=0, inFence=false;
  for(const line of source.split('\n')){
    if(/^\s*\x60{3,}/.test(line)){inFence=!inFence;continue;}
    if(inFence || /^\s*[-*]\s+\[[^\]]+\]\([^)]+\)\s*$/.test(line))continue;
    total+=Array.from(line.replace(/\s/gu,'')).length;
  }
  return total;
};
export function effectiveDirectoryPolicy(policy, directory='') {
  const rel=norm(directory).replace(/^\/+|\/+$/g,'');
  const segments=rel?rel.split('/'):[];
  let fileLimit=policy.defaultFileLimit,origin='default';
  for(let i=1;i<=segments.length;i++){
    const name=segments.slice(0,i).join('/');
    const value=policy.directories?.[name]?.fileLimit;
    if(value!==undefined){fileLimit=value;origin='directory:'+name;}
  }
  return {fileLimit,origin,aggregateLimit:rel?(policy.directories?.[rel]?.aggregateLimit??null):(policy.aggregateLimit??null)};
}
export function effectivePolicy(policy, relativeFile) {
  const file=norm(relativeFile);
  const dirs=file.split('/').slice(0,-1);
  let fileLimit=policy.defaultFileLimit;
  let mode='strict', origin='default';
  for(let i=0;i<=dirs.length;i++){
    const dir=dirs.slice(0,i).join('/');
    const config=policy.directories?.[dir];
    if(config?.fileLimit!==undefined){fileLimit=config.fileLimit;origin='directory:'+dir;}
    if(config?.mode)mode=config.mode;
  }
  const fileRule=policy.files?.[file];
  if(fileRule?.fileLimit!==undefined){fileLimit=fileRule.fileLimit;origin='file:'+file;}
  if(fileRule?.mode)mode=fileRule.mode;
  return {fileLimit,mode,origin,exempt:fileRule?.exempt===true};
}
export function isProtectedDocument(policy,relative){
  return policy.files?.[relative]?.protected===true||policy.files?.[relative]?.exempt===true||
    ['AGENTS.md','VISION.md','PLAN.md','verification/EVIDENCE.md'].includes(relative);
}
export function inspectLengthMetrics(policy,file,source){
  const rule=effectivePolicy(policy,file);
  return [{type:'file',line:1,scope:'全文',current:countCharacters(source,rule.mode),limit:rule.fileLimit}];
}

function validLimit(n){return Number.isSafeInteger(n)&&n>=1&&n<=100000000;}
export function validatePolicy(policy){
  const fields=new Set(['defaultFileLimit','warningRatio','capacityMode','aggregateLimit','optimizationPercent','skillSettings','directories','files','version']);
  for(const key of Object.keys(policy??{}))if(!fields.has(key))throw Error('Unknown workspace policy field: '+key);
  if(!policy||typeof policy!=='object'||!validLimit(policy.defaultFileLimit)||!Number.isFinite(policy.warningRatio)||!(policy.warningRatio>0&&policy.warningRatio<1))throw Error('Invalid default policy');
  if(policy.aggregateLimit!==undefined&&policy.aggregateLimit!==null&&!validLimit(policy.aggregateLimit))throw Error('Invalid workspace aggregateLimit');
  if(policy.optimizationPercent!==undefined&&(!Number.isSafeInteger(policy.optimizationPercent)||policy.optimizationPercent<1||policy.optimizationPercent>99))throw Error('Invalid optimization percent');
  if(policy.capacityMode!==undefined&&!CAPACITY_MODES.includes(policy.capacityMode))throw Error('Invalid capacity mode');
  if(policy.skillSettings!==undefined)validateSkillSettings(policy.skillSettings);
  for(const type of ['directories','files']){
    if(!policy[type]||typeof policy[type]!=='object'||Array.isArray(policy[type]))throw Error('Invalid rule map');
    for(const [key,rule] of Object.entries(policy[type])){
      if(key && !validRelative(key))throw Error('Unsafe rule path');
      if(!rule||typeof rule!=='object'||Array.isArray(rule))throw Error('Invalid rule');
      for(const field of ['fileLimit','aggregateLimit'])if(rule[field]!==undefined&&!validLimit(rule[field]))throw Error('Invalid '+field);
      if(rule.mode!==undefined&&!['strict','text'].includes(rule.mode))throw Error('Invalid mode');
      if(rule.protected!==undefined&&(type!=='files'||typeof rule.protected!=='boolean'))throw Error('Invalid protected rule');
    }
  }
  return policy;
}
export function duplicateParagraphs(text) {
  const lines=text.split('\n'), seen=new Map(), matches=[];
  let inFence=false, start=-1, buffer=[];
  const flush=()=>{
    if(!buffer.length)return;
    const value=buffer.join(' ').replace(/\s+/g,' ').trim();
    if(value.length>=24){
      if(seen.has(value))matches.push({firstLine:seen.get(value),line:start+1,text:value});
      else seen.set(value,start+1);
    }
    buffer=[];start=-1;
  };
  lines.forEach((line,i)=>{
    if(/^\s*\x60{3,}/.test(line)){flush();inFence=!inFence;return;}
    if(inFence||!line.trim()||/^\s*(?:[#>|]|[-*+]\s|\d+[.)]\s|<|\{)/.test(line)){flush();return;}
    if(start<0)start=i;buffer.push(line.trim());
  });
  flush();return matches;
}
export function proposeDuplicateCompression(source){
  const lines=source.split('\n'),seen=new Set(),drop=new Set(),removed=[];
  let start=-1,inFence=false;
  const close=(end)=>{
    if(start<0)return;
    const normalized=lines.slice(start,end).join(' ').replace(/\s+/g,' ').trim();
    if(normalized.length>=24){
      if(seen.has(normalized)){
        for(let i=start;i<end;i++)drop.add(i);
        removed.push({line:start+1,text:normalized.slice(0,320)});
      }else seen.add(normalized);
    }
    start=-1;
  };
  for(let i=0;i<=lines.length;i++){
    const line=lines[i]??'';
    if(/^\s*\x60{3,}/.test(line)){close(i);inFence=!inFence;continue;}
    if(i===lines.length||inFence||!line.trim()||/^\s*(?:[#>|]|[-*+]\s|\d+[.)]\s|<|\{)/.test(line)){close(i);continue;}
    if(start<0)start=i;
  }
  const after=lines.filter((_,i)=>!drop.has(i)).join('\n');
  return {beforeHash:hash(source),afterHash:hash(after),after,removed,reducedCodepoints:Array.from(source).length-Array.from(after).length};
}
export function policyDirectory(home=os.homedir()){return path.join(home,'.dsh','state','workspace-governance');}
const rootKey = root => path.resolve(root).replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
export const isDSHInternalDefaultRoot=root=>typeof root==='string'&&rootKey(root).endsWith('/documents/deepseek-harness/default-workspace');
export function workspacePolicyPath(root,directory=policyDirectory()){
  return path.join(directory,hash(rootKey(root))+'.json');
}
export async function createRegistry(directory=policyDirectory()){
  const state={...defaultState(),suspendedRoots:[]};
  const pausePath=root=>workspacePolicyPath(root,directory).replace(/\.json$/,'.paused');
  let entries=[];
  try{entries=await fs.readdir(directory,{withFileTypes:true});}
  catch(e){if(e.code!=='ENOENT')throw e;}
  for(const entry of entries){
    if(!entry.isFile()||!/^[0-9a-f]{64}\.paused$/.test(entry.name))continue;
    const paused=JSON.parse(await fs.readFile(path.join(directory,entry.name),'utf8'));
    if(typeof paused.root!=='string'||path.basename(pausePath(paused.root))!==entry.name)throw Error('Invalid paused workspace marker');
    state.suspendedRoots.push(paused.root);
  }
  for(const entry of entries){
    if(!entry.isFile()||!/^[0-9a-f]{64}\.json$/.test(entry.name))continue;
    const ws=JSON.parse(await fs.readFile(path.join(directory,entry.name),'utf8'));
    if(!ws||typeof ws.root!=='string'||!path.isAbsolute(ws.root)||
       path.basename(workspacePolicyPath(ws.root,directory))!==entry.name||
       typeof ws.id!=='string'||typeof ws.name!=='string')throw Error('Invalid workspace policy record: '+entry.name);
    validatePolicy(ws.policy);
    if(state.suspendedRoots.some(root=>rootKey(root)===rootKey(ws.root)))continue;
    if(state.workspaces.some(x=>x.id===ws.id||rootKey(x.root)===rootKey(ws.root)))throw Error('Duplicate workspace policy identity');
    state.workspaces.push(ws);
  }
  state.selected=state.workspaces[0]?.id??null;
  const persist=async(ws,previousVersion)=>{
    validatePolicy(ws.policy);
    const file=workspacePolicyPath(ws.root,directory);
    await fs.mkdir(directory,{recursive:true});
    let old;
    try{old=JSON.parse(await fs.readFile(file,'utf8'));}
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(previousVersion===null&&old)throw Error('Stale version');
    if(previousVersion!==null&&(!old||old.policy.version!==previousVersion||old.id!==ws.id))throw Error('Stale version');
    const temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
    try{
      await fs.writeFile(temp,JSON.stringify(ws,null,2)+'\n',{flag:'wx',mode:0o600});
      await fs.rename(temp,file);
    }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
  };
  const update=async(id,transform,expectedVersion)=>{
    const index=state.workspaces.findIndex(w=>w.id===id);
    if(index<0)throw Error('Unknown workspace');
    const ws=state.workspaces[index];
    if(expectedVersion!==undefined&&ws.policy.version!==expectedVersion)throw Error('Stale version');
    const next={...ws,policy:structuredClone(ws.policy)};
    transform(next.policy);
    validatePolicy(next.policy);
    next.policy.version=(ws.policy.version||0)+1;
    await persist(next,ws.policy.version);
    state.workspaces[index]=next;state.revision++;
    return structuredClone(next.policy);
  };
  return {
    snapshot:()=>structuredClone(state),
    async add(input,{manual=false}={}){
      if(typeof input!=='string'||!path.isAbsolute(input))throw Error('Absolute path required');
      if(!manual&&isDSHInternalDefaultRoot(input))throw Error('DSH internal default folder is not a project workspace');
      const real=await fs.realpath(input);
      if(!(await fs.stat(real)).isDirectory())throw Error('Workspace must be a directory');
      const same=state.workspaces.find(w=>rootKey(w.root)===rootKey(real));
      if(same)return same;
      const paused=state.suspendedRoots.some(root=>rootKey(root)===rootKey(real));
      if(paused&&!manual)throw Error('Workspace tracking paused; manual re-registration required');
      const file=workspacePolicyPath(real,directory);
      let existing;
      try{existing=JSON.parse(await fs.readFile(file,'utf8'));}
      catch(e){if(e.code!=='ENOENT')throw e;}
      const ws=existing??{id:randomUUID(),root:real,name:path.basename(real),policy:structuredClone(DEFAULT_POLICY),createdAt:new Date().toISOString()};
      if(existing){
        if(rootKey(existing.root)!==rootKey(real))throw Error('Workspace hash collision');
        validatePolicy(existing.policy);
      }else await persist(ws,null);
      if(paused){
        await fs.rm(pausePath(real),{force:true});
        state.suspendedRoots=state.suspendedRoots.filter(root=>rootKey(root)!==rootKey(real));
      }
      state.workspaces.push(ws);state.selected=ws.id;state.revision++;
      return structuredClone(ws);
    },
    async suspend(id){
      const index=state.workspaces.findIndex(w=>w.id===id);
      if(index<0)throw Error('Unknown workspace');
      const ws=state.workspaces[index],marker=pausePath(ws.root);
      await fs.mkdir(directory,{recursive:true});
      const temp=marker+'.'+randomUUID()+'.tmp';
      try{
        await fs.writeFile(temp,JSON.stringify({root:ws.root,pausedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
        await fs.rename(temp,marker);
      }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
      // Keep this workspace's independent budget rules: suspending tracking is not policy deletion.
      state.suspendedRoots.push(ws.root);
      state.workspaces.splice(index,1);
      if(state.selected===id)state.selected=state.workspaces[0]?.id??null;
      state.revision++;
      return ws.root;
    },
    async remove(id){
      const index=state.workspaces.findIndex(w=>w.id===id);
      if(index<0)throw Error('Unknown workspace');
      const ws=state.workspaces[index];
      await fs.rm(workspacePolicyPath(ws.root,directory));
      state.workspaces.splice(index,1);
      if(state.selected===id)state.selected=state.workspaces[0]?.id??null;
      state.revision++;
    },
    updateRule(id,scope,relative,rule,expectedVersion){
      if(!['directories','files'].includes(scope)||!validRelative(relative))throw Error('Invalid rule target');
      return update(id,policy=>{
        if(rule===null)delete policy[scope][relative];
        else{
          const resolved={...(policy[scope][relative]??{}),...rule};
          if(resolved.aggregateLimit===null)delete resolved.aggregateLimit;
          if(resolved.fileLimit===null)delete resolved.fileLimit;
          if(Object.keys(resolved).length===0)delete policy[scope][relative];
          else policy[scope][relative]=resolved;
        }
      },expectedVersion);
    },
    updateCapacityMode(id,mode,expectedVersion){
      if(!CAPACITY_MODES.includes(mode))throw Error('Invalid capacity mode');
      return update(id,policy=>{policy.capacityMode=mode;},expectedVersion);
    },
    updateSkillSettings(id,settings,expectedVersion){
      validateSkillSettings(settings);
      return update(id,policy=>{policy.skillSettings=structuredClone(settings);},expectedVersion);
    },
    updateDefaults(id,{defaultFileLimit,warningRatio,aggregateLimit,optimizationPercent},expectedVersion){
      return update(id,policy=>{
        policy.defaultFileLimit=defaultFileLimit;policy.warningRatio=warningRatio;
        if(aggregateLimit!==undefined){
          if(aggregateLimit===null)delete policy.aggregateLimit;
          else policy.aggregateLimit=aggregateLimit;
        }
        if(optimizationPercent!==undefined)policy.optimizationPercent=optimizationPercent;
      },expectedVersion);
    },
    find:id=>state.workspaces.find(w=>w.id===id)
  };
}
export async function safeDocument(workspace,relative){
  if(!validRelative(relative))throw Error('Unsafe relative path');
  const root=await fs.realpath(workspace.root);
  const target=await fs.realpath(path.resolve(root,relative));
  const prefix=root.endsWith(path.sep)?root:root+path.sep;
  if(!target.toLowerCase().startsWith(prefix.toLowerCase()))throw Error('Outside workspace');
  const stat=await fs.stat(target);
  if(!stat.isFile()||stat.size>2*1024*1024||!EXTENSIONS.has(path.extname(target).toLowerCase()))throw Error('Unsupported document');
  return {target,stat,relative:norm(relative)};
}
/** Shared measurement for full and incremental scans. */export function measureMarkdownDocument(workspace,relative,text){
  const rule=effectivePolicy(workspace.policy,relative);
  const metrics=inspectLengthMetrics(workspace.policy,relative,text);
  const chars=metrics[0].current;
  const exceeded=metrics.filter(metric=>metric.current>metric.limit);
  const duplicates=duplicateParagraphs(text);
  return {
    node:{path:relative,name:relative.split('/').at(-1),type:'file',chars,
      fileLimit:rule.fileLimit,limit:rule.fileLimit,origin:rule.origin,
      protected:isProtectedDocument(workspace.policy,relative),status:exceeded.length?'overflow':chars>=rule.fileLimit*workspace.policy.warningRatio?'warning':'ok',
      duplicates:duplicates.length,digest:hash(text),issues:exceeded.length},
    issues:[
      ...exceeded.map(metric=>({type:'overflow',scope:metric.type,path:relative,
        current:metric.current,limit:metric.limit,line:metric.line})),
      ...duplicates.map(duplicate=>({type:'duplicate',path:relative,...duplicate}))
    ]
  };
}

/**
 * Re-read only the changed Markdown file. Rebuild in-memory ancestor totals and
 * aggregate issues; no other file contents or directories are traversed.
 * Returning null means structural/integrity uncertainty requires a full scan.
 */
export async function patchScanDocument(workspace,previous,relative){
  if(!previous||previous.truncated||previous.workspaceId!==workspace.id||
     previous.policyVersion!==workspace.policy.version||
     previous.issues.some(issue=>INTEGRITY_ISSUES.has(issue.type)))return null;
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||
     relative.includes('\\')||relative.split('/').some(segment=>!segment||
       segment==='.'||segment==='..'||IGNORED.has(segment)))return null;
  if(!EXTENSIONS.has(path.extname(relative).toLowerCase()))return null;
  const parts=relative.split('/'),tree=structuredClone(previous.tree);
  let parent=tree;
  for(const segment of parts.slice(0,-1)){
    parent=parent.children?.find(child=>child.type==='folder'&&child.name===segment);
    if(!parent)return null;
  }
  const existing=parent.children.findIndex(node=>node.name===parts.at(-1));
  const target=path.join(workspace.root,...parts);
  let measurement=null;
  try{
    const stat=await fs.lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)return null;
    const resolvedRoot=await fs.realpath(workspace.root),resolved=await fs.realpath(target);
    if(!resolved.startsWith(resolvedRoot+path.sep))return null;
    const source=await fs.readFile(target,'utf8');
    const after=await fs.lstat(target);
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||
       after.ino!==stat.ino||source.includes('\uFFFD'))return null;
    measurement=measureMarkdownDocument(workspace,relative,source);
  }catch(error){if(error.code!=='ENOENT')return null;}
  if(existing<0&&!measurement)return previous;
  if(existing>=0)parent.children.splice(existing,1);
  if(measurement)parent.children.push(measurement.node);
  // Full scan orders folders before files; preserve topology without disk traversal.
  parent.children.sort((a,b)=>Number(b.type==='folder')-Number(a.type==='folder')||
    a.name.localeCompare(b.name));
  const issues=previous.issues.filter(issue=>issue.type!=='aggregate-overflow'&&issue.path!==relative);
  if(measurement)issues.push(...measurement.issues);
  function summarize(node){
    if(node.type==='file')return;
    node.children=node.children.filter(child=>{
      if(child.type==='folder'){summarize(child);return child.files>0;}
      return true;
    });
    node.chars=node.children.reduce((sum,child)=>sum+child.chars,0);
    node.files=node.children.reduce((sum,child)=>sum+(child.type==='file'?1:child.files),0);
    node.issues=node.children.reduce((sum,child)=>sum+(child.issues??0),0);
    if(node.limit!==null&&node.limit!==undefined&&node.chars>node.limit){
      node.issues++;
      issues.push({type:'aggregate-overflow',path:node.path,current:node.chars,
        limit:node.limit,excess:node.chars-node.limit});
    }
    node.status=node.limit===null||node.limit===undefined?'unlimited':
      node.chars>node.limit?'overflow':
      node.chars>=node.limit*workspace.policy.warningRatio?'warning':'ok';
  }
  summarize(tree);
  const next={...previous,tree,issues,scanned:tree.files,updatedAt:new Date().toISOString()};
  next.fingerprint=hash(JSON.stringify({id:workspace.id,version:workspace.policy.version,tree,issues}));
  return next;
}
export async function scanWorkspace(workspace,{maxFiles=20000,maxEntries=100000}={}){
  const root=await fs.realpath(workspace.root);
  const rootRule=effectiveDirectoryPolicy(workspace.policy);
  const tree={path:'',name:workspace.name,type:'folder',children:[],chars:0,files:0,issues:0,limit:rootRule.aggregateLimit,...rootRule};
  const issues=[];let scanned=0,visited=0,truncated=false;
  async function walk(abs,node,depth){
    if(depth>30){truncated=true;return;}
    let entries;
    try{entries=await fs.readdir(abs,{withFileTypes:true});}
    catch(error){issues.push({type:'unreadable-directory',path:node.path,message:String(error.code||error.message)});return;}
    entries.sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name));
    for(const entry of entries){
      if(scanned>=maxFiles||visited++>=maxEntries){truncated=true;break;}
      if(entry.isSymbolicLink()||IGNORED.has(entry.name))continue;
      const rel=node.path?node.path+'/'+entry.name:entry.name, full=path.join(abs,entry.name);
      if(entry.isDirectory()){
        const directoryRule=effectiveDirectoryPolicy(workspace.policy,rel);
        const child={path:rel,name:entry.name,type:'folder',children:[],chars:0,files:0,issues:0,limit:directoryRule.aggregateLimit,...directoryRule};
        await walk(full,child,depth+1);
        // Only Markdown-bearing directories belong to the presentation tree.
        // On-disk directories, their rules and unrelated diagnostic evidence remain untouched.
        if(child.files===0)continue;
        node.children.push(child);
        node.chars+=child.chars;node.files+=child.files;node.issues+=child.issues;
        if(child.limit!==null&&child.chars>child.limit){issues.push({type:'aggregate-overflow',path:rel,current:child.chars,limit:child.limit,excess:child.chars-child.limit});child.issues++;node.issues++;}
        child.status=child.limit===null?'unlimited':child.chars>child.limit?'overflow':child.chars>=child.limit*workspace.policy.warningRatio?'warning':'ok';
      }else if(entry.isFile()&&EXTENSIONS.has(path.extname(entry.name).toLowerCase())){
        scanned++;
        let stat,text;
        try{
          stat=await fs.stat(full);
          if(stat.size>2*1024*1024){issues.push({type:'oversized-document',path:rel});continue;}
          text=await fs.readFile(full,'utf8');
        }catch(error){issues.push({type:'unreadable-document',path:rel,message:String(error.code||error.message)});continue;}
        if(text.includes('\uFFFD')){issues.push({type:'invalid-encoding',path:rel});continue;}
        const measurement=measureMarkdownDocument(workspace,rel,text);
        node.children.push(measurement.node);node.chars+=measurement.node.chars;node.files++;
        node.issues+=measurement.node.issues;
        issues.push(...measurement.issues);
      }
    }
  }
  await walk(root,tree,0);
  if(tree.limit!==null&&tree.chars>tree.limit){
    issues.push({type:'aggregate-overflow',path:'',current:tree.chars,limit:tree.limit,excess:tree.chars-tree.limit});tree.issues++;
  }
  tree.status=tree.limit===null?'unlimited':tree.chars>tree.limit?'overflow':tree.chars>=tree.limit*workspace.policy.warningRatio?'warning':'ok';
  return {workspaceId:workspace.id,policyVersion:workspace.policy.version,tree,issues,scanned,truncated,updatedAt:new Date().toISOString(),fingerprint:hash(JSON.stringify({id:workspace.id,version:workspace.policy.version,tree,issues}))};
}
