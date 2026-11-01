import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createGovernanceSkillProvider,embeddedSkillLocations,EMBEDDED_SKILL_NAMES} from '../lib/embedded-skills.js';
import {apply} from '../lib/index.js';

const embeddedRoot=path.resolve(fileURLToPath(new URL('../embedded-skills/',import.meta.url)));
test('both original complete Skill trees are embedded with byte-for-byte manifest integrity',async()=>{
 const manifest=JSON.parse(await fs.readFile(path.join(embeddedRoot,'manifest.json'),'utf8'));
 assert.deepEqual(manifest.skills,['semantic-refactor-forge','forensic-prune']);
 assert.deepEqual(Array.from(EMBEDDED_SKILL_NAMES),manifest.skills);
 assert.equal(manifest.files.length,24);
 const seen=new Set();
 for(const item of manifest.files){
  assert.ok(!item.path.startsWith('/')&&!item.path.split('/').includes('..'));
  const entry=path.resolve(embeddedRoot,item.path);
  assert.ok(entry.startsWith(embeddedRoot+path.sep));
  const data=await fs.readFile(entry);
  assert.equal(data.byteLength,item.size,item.path);
  assert.equal(createHash('sha256').update(data).digest('hex'),item.sha256,item.path);
  seen.add(item.path);
 }
 for(const name of manifest.skills){
  const scan=async dir=>{
   for(const item of await fs.readdir(dir,{withFileTypes:true})){
    const full=path.join(dir,item.name);
    if(item.isDirectory())await scan(full);
    else {assert.ok(item.isFile());assert.ok(seen.has(path.relative(embeddedRoot,full).split(path.sep).join('/')));}
   }
  };
  await scan(path.join(embeddedRoot,name));
 }
  const paths=embeddedSkillLocations();
  assert.equal(paths.length,2);
  const root='D:/project/Aevum';
  const skillSettings={mode:'embedded',customSkill:'Original custom workspace Skill'};
  const provider=createGovernanceSkillProvider({registryReady:Promise.resolve({
    snapshot:()=>({workspaces:[{root,policy:{skillSettings}}]})
  })});
  const catalog=await provider.list({cwd:root});
  assert.equal(provider.name,'workspace-governance-bundled');
  assert.deepEqual(catalog.map(skill=>skill.name),manifest.skills);
  assert.ok(catalog.every(skill=>skill.invocation.modelInvocable));
  for(const {name,root:directory,entry} of paths){
    assert.ok(directory.startsWith(embeddedRoot+path.sep));
    const source=await fs.readFile(entry,'utf8');
    const definition=await provider.get(catalog.find(skill=>skill.name===name),{cwd:root});
    assert.equal(definition.content,source,'full original skill is loaded on demand: '+name);
    assert.equal(definition.resourceBase.path,directory);
  }
  skillSettings.mode='custom';
  const customCatalog=await provider.list({cwd:root});
  assert.deepEqual(customCatalog.map(skill=>skill.name),['workspace-governance-custom']);
  assert.equal((await provider.get(customCatalog[0],{cwd:root})).content,skillSettings.customSkill);
  assert.equal((await provider.list({cwd:'D:/other'})).length,0,'Skill catalog is workspace-scoped');
  assert.equal(await provider.get(catalog[0],{cwd:root}),undefined);
  skillSettings.mode='off';
  assert.deepEqual(await provider.list({cwd:root}),[]);
  assert.equal(await provider.get(customCatalog[0],{cwd:root}),undefined);
});