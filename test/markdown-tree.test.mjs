import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRegistry,scanWorkspace} from '../lib/core.js';

test('Markdown-only sparse tree retains only necessary ancestor closure',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'wg-md-tree-'));
 try{
  const repo=path.join(home,'project');
  for(const name of ['docs/guides/deep','assets/icons','engine/service','blank','docs/images','docs/unrelated']){
   await fs.mkdir(path.join(repo,name),{recursive:true});
  }
  const markdown='## Guide\n\nContent\n';
  await fs.writeFile(path.join(repo,'docs/guides/deep/guide.md'),markdown);
  await fs.writeFile(path.join(repo,'README.MD'),markdown);
  await fs.writeFile(path.join(repo,'docs/images/diagram.svg'),'<svg/>');
  await fs.writeFile(path.join(repo,'docs/unrelated/note.txt'),markdown);
  await fs.writeFile(path.join(repo,'engine/service/main.js'),markdown);
  await fs.writeFile(path.join(repo,'assets/icons/icon.png'),'png');
  const registry=await createRegistry(path.join(home,'policies')),ws=await registry.add(repo);
  await registry.updateRule(ws.id,'directories','docs/guides/deep',{fileLimit:5});
  const report=await scanWorkspace(registry.find(ws.id));
  assert.equal(report.scanned,2);
  const paths=[];
  const visit=node=>{paths.push(node.path);for(const child of node.children??[])visit(child);};
  visit(report.tree);
  assert.deepEqual(paths,['','docs','docs/guides','docs/guides/deep','docs/guides/deep/guide.md','README.MD']);
  assert.equal(report.tree.files,2);
  assert.equal(report.tree.children[0].files,1);
  assert.ok(report.issues.some(x=>x.path==='docs/guides/deep/guide.md'&&x.type==='overflow'));
  assert.ok(!paths.some(x=>x.includes('engine')||x.includes('assets')||x.includes('images')));
  assert.ok((await fs.stat(path.join(repo,'assets/icons/icon.png'))).isFile());
  await fs.rename(path.join(repo,'docs/guides/deep/guide.md'),path.join(repo,'docs/guides/deep/guide.txt'));
  const after=await scanWorkspace(registry.find(ws.id));
  assert.deepEqual(after.tree.children.map(x=>x.path),['README.MD']);
  assert.equal(after.tree.files,1);
  assert.equal(registry.find(ws.id).policy.directories['docs/guides/deep'].fileLimit,5);
  await fs.rm(path.join(repo,'README.MD'));
  const empty=await scanWorkspace(registry.find(ws.id));
  assert.equal(empty.scanned,0);
  assert.deepEqual(empty.tree.children,[]);
  assert.equal(empty.truncated,false);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
