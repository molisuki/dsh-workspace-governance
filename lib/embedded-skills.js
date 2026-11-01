import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {effectiveSkillSettings} from './skill-strategy.js';

const bundleRoot=fileURLToPath(new URL('../embedded-skills/',import.meta.url));
export const EMBEDDED_SKILL_NAMES=Object.freeze(['semantic-refactor-forge','forensic-prune']);
const entries=EMBEDDED_SKILL_NAMES.map(name=>{
 const root=path.join(bundleRoot,name),entry=path.join(root,'SKILL.md');
 return Object.freeze({name,root,entry,body:readFileSync(entry,'utf8')});
});
export function embeddedSkillLocations(){
 return entries.map(({name,root,entry})=>({name,root,entry}));
}
const provider='workspace-governance-bundled',customName='workspace-governance-custom';
const invocation=Object.freeze({modelInvocable:true,userInvocable:true});
const candidate=({name,entry,root,description,source='bundled',rank=600})=>({
 name,description,source,provider,invocation,rank,locator:name,
 ...(entry?{path:entry}:{}),...(root?{resourceBase:{kind:'directory',path:root}}:{})
});
const bundled=entries.map(({name,root,entry})=>candidate({name,root,entry,
 description:name==='forensic-prune'?'Evidence-based asset and dependency pruning':'High-fidelity semantic and structural refactoring'}));
const cwdEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&
 path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
/** Native Skill catalog provider: full bodies are loaded on demand, never attached to a governance advisory. */
export function createGovernanceSkillProvider({registryReady}={}){
 async function configured(cwd){
  if(!cwd||!registryReady)return null;
  const registry=await registryReady;
  return registry.snapshot().workspaces.find(w=>cwdEqual(w.root,cwd))??null;
 }
  return {
    name:provider,
    async list({cwd}={}){
      const workspace=await configured(cwd);
      if(!workspace)return [];
      const settings=effectiveSkillSettings(workspace.policy);
      if(settings.mode==='embedded')return bundled;
      if(settings.mode==='custom'&&typeof settings.customSkill==='string'&&settings.customSkill.trim())
        return [candidate({name:customName,description:'Workspace-scoped custom Markdown refactoring policy',
          source:'runtime',rank:550})];
      return [];
    },
    async get(summary,{cwd}={}){
      if(summary?.provider!==provider)return undefined;
      const workspace=await configured(cwd);
      if(!workspace)return undefined;
      const settings=effectiveSkillSettings(workspace.policy);
      const entry=entries.find(item=>item.name===summary.name);
      if(entry)return settings.mode==='embedded'?
        {...bundled.find(item=>item.name===entry.name),content:entry.body}:undefined;
      if(summary.name!==customName||settings.mode!=='custom'||!settings.customSkill?.trim())
        return undefined;
      return {...candidate({name:customName,description:'Workspace-scoped custom Markdown refactoring policy',
        source:'runtime',rank:550}),content:settings.customSkill};
    }
  };
}

const activeSkillNames=policy=>{
 const mode=effectiveSkillSettings(policy).mode;
 return mode==='embedded'?[...EMBEDDED_SKILL_NAMES]:
   mode==='custom'?[customName]:[];
};
const pendingForDetachedSession=new WeakMap();
// The committed native message surface determines whether a Skill remains active.
function skillVisible(session,name,messages=[]){
 const parts=[...messages];
 if(typeof session?.deriveMessages==='function')
  parts.push(...(session.deriveMessages()??[]));
 const observed=parts.some(message=>
  message?.source?.kind==='skill-invocation'&&message.source.name===name||
  message?.role==='tool'&&Array.isArray(message.content)&&
   message.content.some(block=>block?.type==='text'&&
    block.text.includes('<skill_content name="'+name+'">')));
 if(observed)return true;
 // Detached test hosts cannot record accepted pre-step messages; real sessions
 // rely on their committed surface so compaction can enable a legitimate reload.
 return typeof session?.deriveMessages!=='function'&&
  pendingForDetachedSession.get(session)?.has(name)===true;
}const escapeResource=value=>String(value).replaceAll('&','&amp;')
 .replaceAll('<','&lt;').replaceAll('>','&gt;');
function renderSkill(skill){
 const resources=skill.resourceBase?.kind==='directory'?
  'Base directory for this skill: '+escapeResource(skill.resourceBase.path)+
  '\nResolve relative paths against this directory.':
  'Resources for this skill are managed by '+escapeResource(skill.provider)+'.';
 return '<skill_content name="'+skill.name+'">\n'+
  '<skill_resources>\n'+resources+'\n</skill_resources>\n\n'+
  '<skill_instructions>\n'+skill.content+'\n</skill_instructions>\n</skill_content>';
}/** Reuse host-loaded skills and enter missing bodies through native skill-invocation messages. */
export async function prepareGovernanceSkills({agent,decision,skills,policy,signal}={}){
 if(!decision||decision.kind==='reject'||!Array.isArray(decision.messages)||
    !decision.messages.some(message=>message?.source?.kind==='workspace-governance'))
  return decision;
 const needed=activeSkillNames(policy);
 if(!needed.length)return decision;
 const additions=[];
 for(const name of needed){
  if(skillVisible(agent.session,name,[...decision.messages,...additions]))continue;
  const skill=await skills.get(name,{cwd:agent.session?.header?.cwd,scope:agent,signal});
  signal?.throwIfAborted?.();
  if(!skill||skill.invocation?.modelInvocable===false)
   throw Error('Workspace Governance Skill unavailable: '+name);
  additions.push({id:randomUUID(),role:'user',content:[{type:'text',text:renderSkill(skill)}],
   source:{kind:'skill-invocation',name,form:'instructions'}});
 }
  if(additions.length&&typeof agent.session?.deriveMessages!=='function'){
   const known=pendingForDetachedSession.get(agent.session)??new Set();
   for(const item of additions)known.add(item.source.name);
   pendingForDetachedSession.set(agent.session,known);
  }
  return additions.length?{...decision,messages:[...decision.messages,...additions]}:decision;
}