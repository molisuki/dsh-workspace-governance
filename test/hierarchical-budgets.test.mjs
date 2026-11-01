import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRegistry,effectivePolicy,effectiveDirectoryPolicy,scanWorkspace} from '../lib/core.js';

test('workspace and nested directory cumulative budgets are independent from file limits',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'wg-hierarchy-'));
 try{
  const root=path.join(home,'repo');
  await fs.mkdir(path.join(root,'docs','deep'),{recursive:true});
  await fs.writeFile(path.join(root,'README.md'),'abcdef');
  await fs.writeFile(path.join(root,'docs','a.md'),'abcdefghij');
  await fs.writeFile(path.join(root,'docs','deep','b.md'),'abcdefghijkl');
  await fs.writeFile(path.join(root,'docs','deep','c.md'),'abcdefghij');
  const registry=await createRegistry(path.join(home,'policies')),ws=await registry.add(root);
  const id=ws.id;
  await registry.updateDefaults(id,{defaultFileLimit:8,warningRatio:0.8,aggregateLimit:36},1);
  await registry.updateRule(id,'directories','docs',{fileLimit:11,aggregateLimit:30},2);
  await registry.updateRule(id,'directories','docs/deep',{fileLimit:9,aggregateLimit:21},3);
  await registry.updateRule(id,'files','docs/deep/b.md',{fileLimit:15},4);
  assert.equal(effectivePolicy(registry.find(id).policy,'docs/deep/b.md').fileLimit,15);
  assert.equal(effectivePolicy(registry.find(id).policy,'docs/deep/c.md').fileLimit,9);
  assert.equal(effectivePolicy(registry.find(id).policy,'docs/a.md').fileLimit,11);
  assert.equal(effectivePolicy(registry.find(id).policy,'README.md').fileLimit,8);
  assert.equal(effectiveDirectoryPolicy(registry.find(id).policy,'').aggregateLimit,36);
  let report=await scanWorkspace(registry.find(id));
  const docs=report.tree.children.find(x=>x.path==='docs');
  const deep=docs.children.find(x=>x.path==='docs/deep');
  assert.equal(report.tree.chars,38);
  assert.equal(docs.chars,32);
  assert.equal(deep.chars,22);
  assert.deepEqual(report.issues.filter(x=>x.type==='aggregate-overflow').map(x=>x.path).sort(),['','docs','docs/deep']);
  assert.ok(report.issues.some(x=>x.type==='overflow'&&x.path==='docs/deep/c.md'));
  assert.ok(!report.issues.some(x=>x.type==='overflow'&&x.path==='docs/deep/b.md'));
  assert.equal(report.tree.status,'overflow');
  assert.equal(docs.status,'overflow');
  assert.equal(deep.status,'overflow');
  // A larger file override cannot cancel a parent or child directory budget.
  await registry.updateRule(id,'files','docs/deep/b.md',{fileLimit:100},5);
  report=await scanWorkspace(registry.find(id));
  assert.equal(report.issues.filter(x=>x.type==='aggregate-overflow').length,3);
  assert.equal(report.tree.chars,38);
  // Remove only the explicit file override; the nearest parent value takes effect.
  await registry.updateRule(id,'files','docs/deep/b.md',{fileLimit:null},6);
  assert.equal(effectivePolicy(registry.find(id).policy,'docs/deep/b.md').fileLimit,9);
  assert.equal(registry.find(id).policy.files['docs/deep/b.md'],undefined);
  // Unset root total budget without changing any directory or file budgets.
  const latest=registry.find(id).policy;
  await registry.updateDefaults(id,{defaultFileLimit:latest.defaultFileLimit,warningRatio:latest.warningRatio,aggregateLimit:null},7);
  report=await scanWorkspace(registry.find(id));
  assert.equal(report.tree.limit,null);
  assert.equal(report.issues.filter(x=>x.type==='aggregate-overflow').length,2);
  assert.equal(registry.find(id).policy.directories.docs.aggregateLimit,30);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('invalid aggregate budgets and outdated policy versions cannot mutate a workspace',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'wg-budget-'));
 try{
  const root=path.join(home,'repo');await fs.mkdir(root);
  const registry=await createRegistry(path.join(home,'policies')),ws=await registry.add(root);
  await assert.rejects(registry.updateDefaults(ws.id,{defaultFileLimit:2500,warningRatio:0.8,aggregateLimit:0},1),/Invalid/);
  await assert.rejects(registry.updateRule(ws.id,'directories','docs',{aggregateLimit:-3},1),/Invalid/);
  assert.equal(registry.find(ws.id).policy.version,1);
  await registry.updateDefaults(ws.id,{defaultFileLimit:2400,warningRatio:0.8,aggregateLimit:5000},1);
  await assert.rejects(registry.updateRule(ws.id,'directories','docs',{aggregateLimit:100},1),/Stale version/);
  assert.equal(registry.find(ws.id).policy.aggregateLimit,5000);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
