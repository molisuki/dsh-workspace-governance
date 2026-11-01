import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRegistry,workspacePolicyPath,loadWorkspacePolicySync,policyDirectory} from '../lib/core.js';

test('workspace-specific policy records are separate and do not require any global registry',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'wg-per-workspace-'));
 try{
  const workspaceDir=policyDirectory(home);
  const one=path.join(home,'one'),two=path.join(home,'two');
  await fs.mkdir(one);await fs.mkdir(two);
  const registry=await createRegistry(workspaceDir);
  const first=await registry.add(one),second=await registry.add(two);
  await registry.updateRule(first.id,'files','README.md',{fileLimit:111},1);
  await registry.updateRule(second.id,'files','README.md',{fileLimit:222},1);
  const p1=workspacePolicyPath(one,workspaceDir),p2=workspacePolicyPath(two,workspaceDir);
  assert.notEqual(p1,p2);
  assert.equal((await fs.readdir(workspaceDir)).length,2);
  assert.equal(loadWorkspacePolicySync(one,workspaceDir).files['README.md'].fileLimit,111);
  assert.equal(loadWorkspacePolicySync(two,workspaceDir).files['README.md'].fileLimit,222);
  assert.deepEqual(await fs.readdir(path.join(home,'.dsh','state')),['workspace-governance']);
  const reloaded=await createRegistry(workspaceDir);
  assert.equal(reloaded.snapshot().workspaces.length,2);
  assert.equal(reloaded.find(first.id).policy.files['README.md'].fileLimit,111);
  await reloaded.updateRule(first.id,'files','README.md',{fileLimit:333},2);
  assert.equal(loadWorkspacePolicySync(two,workspaceDir).files['README.md'].fileLimit,222);
  assert.equal(loadWorkspacePolicySync(one,workspaceDir).files['README.md'].fileLimit,333);
  await assert.rejects(registry.updateRule(first.id,'files','README.md',{fileLimit:444},2),/Stale version/);
  assert.equal(loadWorkspacePolicySync(one,workspaceDir).files['README.md'].fileLimit,333);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
