import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createRegistry,effectiveDirectoryPolicy,effectivePolicy} from '../lib/core.js';
import os from 'node:os';
import path from 'node:path';

test('new workspace has a 2400 root default and no generated directory overrides',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'wg-inheritance-'));
 try{
  const dir=path.join(home,'repo');await fs.mkdir(path.join(dir,'docs'),{recursive:true});
  const reg=await createRegistry(path.join(home,'policies')),ws=await reg.add(dir);
  assert.equal(ws.policy.defaultFileLimit,2400);
  assert.deepEqual(ws.policy.directories,{});
  assert.equal(effectiveDirectoryPolicy(ws.policy,'docs').fileLimit,2400);
  assert.equal(effectivePolicy(ws.policy,'docs/example.md').fileLimit,2400);
  assert.equal(ws.policy.directories.docs,undefined);
  await reg.updateRule(ws.id,'directories','docs',{fileLimit:700},1);
  assert.equal(effectiveDirectoryPolicy(reg.find(ws.id).policy,'docs').fileLimit,700);
  await reg.updateRule(ws.id,'directories','docs',{fileLimit:null},2);
  assert.equal(reg.find(ws.id).policy.directories.docs,undefined);
  assert.equal(effectivePolicy(reg.find(ws.id).policy,'docs/example.md').fileLimit,2400);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
test('mind map folder expansion is isolated from inherited threshold editor behavior',async()=>{
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 assert.ok(source.includes("node.path===''||"));
 assert.ok(source.includes("node.path===''||expanded[node.path]===true"));
 assert.match(source,/if\(!file&&item\.path!==''&&item\.hasChildren\)\s*\{/);
 assert.ok(source.includes('anchor.current={layout,path:item.path,node:item}'),
  'folder expansion must capture its screen anchor before layout mutation');
 assert.ok(source.includes('onToggle(item.path,item.open)'));
 assert.ok(source.includes("placeholder:inherit?'继承自'+source:''"));
 assert.ok(source.includes("directoryOverride===undefined?'':String(directoryOverride)"));
 assert.ok(source.includes("fileOverride===undefined?'':String(fileOverride)"));
 assert.ok(source.includes("draft.trim()===''?null"));
 assert.ok(source.includes("rule:{fileLimit:override}"));
});
test('threshold setting UI displays exactly one editor corresponding to selected node type',async()=>{
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 const start=source.indexOf("const limitEditor=active?c('div'");
 const end=source.indexOf("return c('main',{className:'wg-root'}",start);
 const card=source.slice(start,end);
 assert.ok(start>0&&end>start);
 const first=card.indexOf("label:'工作区默认单文件上限'");
 const second=card.indexOf("label:'目录单文件上限 · '");
 const third=card.indexOf("label:'单文件上限 · '");
 assert.ok(first>=0&&first<second&&second<third);
 assert.equal((card.match(/renderLimitRow\(/g)||[]).length,3);
 assert.ok(card.includes("isRoot?renderLimitRow({label:'工作区默认单文件上限'"));
 assert.ok(card.includes("active.type==='folder'?renderLimitRow({label:'目录单文件上限 · '"));
 assert.ok(card.includes("renderLimitRow({label:'单文件上限 · '"));
 assert.ok(!card.includes('directoryPath?renderLimitRow'));
 assert.ok(!card.includes('filePath?renderLimitRow'));
 assert.ok(!card.includes('预警阈值'));
 assert.ok(!card.includes('累计上限'));
 assert.ok(!card.includes('登记行上限'));
 assert.ok(source.includes("if(value===current.policy.defaultFileLimit)"));
 assert.ok(source.includes("warningRatio:current.policy.warningRatio,aggregateLimit:current.policy.aggregateLimit??null"));
});
test('rendered editor selects one numeric input for root, child directory or Markdown file',async()=>{
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 const start=source.indexOf('const limitEditor=active?');
 const end=source.indexOf(';',start);
 assert.ok(start>=0&&end>start);
 const expression=source.slice(start+'const limitEditor='.length,end);
 const build=new Function('active','isRoot','directoryPath','filePath','workspaceLimit','directoryLimit','fileLimit','inheritedFrom',
   'setWorkspaceLimit','setDirectoryLimit','setFileLimit','saveLimit','renderLimitRow','c',`return (${expression});`);
 const c=(type,props,...children)=>({type,props,children});
 const renderLimitRow=props=>({type:'numeric-editor',...props});
 const render=(active)=>build(active,active?.type==='folder'&&active.path==='',
   active?.type==='file'?(active.path.split('/').slice(0,-1).join('/')):active?.path,
   active?.type==='file'?active.path:null,'2400','','','工作区默认',()=>{},()=>{},()=>{},()=>{},renderLimitRow,c);
 const cases=[
  [{type:'folder',path:''},'工作区默认单文件上限'],
  [{type:'folder',path:'docs'},'目录单文件上限 · docs'],
  [{type:'file',path:'README.md'},'单文件上限 · README.md'],
  [{type:'file',path:'docs/README.md'},'单文件上限 · docs/README.md']
 ];
 for(const [node,label] of cases){
  const panel=render(node);
  const inputs=panel.children.filter(child=>child?.type==='numeric-editor');
  assert.equal(inputs.length,1,'only one editor for '+node.path);
  assert.equal(inputs[0].label,label);
 }
 assert.equal(render(null),null);
});
test('inheritance displays a concrete source, not an unqualified inheritance label',async()=>{
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 assert.ok(source.includes("return '目录 '+key"));
 assert.ok(source.includes("return '工作区默认'"));
 assert.ok(source.includes("'继承自目录 '+active.origin.slice(10)"));
 assert.ok(source.includes("'继承自工作区默认'"));
 assert.ok(!source.includes('README 专项'));
 assert.ok(!source.includes('PLAN 单条上限'));
});
