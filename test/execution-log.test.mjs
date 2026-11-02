import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {apply} from '../lib/index.js';
import {countCharacters} from '../lib/core.js';

const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function start(state,root){
 let handler,cleanup;
 const ctx={logger:{warn(){},error(){}},webServer:{register(data){handler=data.handler;return()=>{};}},
  workingDirectory:{get:()=>root},
  effect(fn){cleanup=fn();}};
 apply(ctx,{stateDirectory:state});
 const request=async(method,route,body,headers={})=>{
  const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
  req.method=method;req.url='/api/dsh-workspace-governance'+route;
  req.headers={host:'localhost:19111',...(method==='GET'?{}:{'x-wg-request':'1'}),...headers};
  let code,payload;
  await handler(req,{writeHead(value){code=value;},end(value){payload=JSON.parse(value);}});
  return {code,...payload};
 };
 return {request,close:()=>cleanup?.()};
}
async function waitFor(eventFile,predicate){
 for(let i=0;i<80;i++){
  try{const data=JSON.parse(await fs.readFile(eventFile,'utf8'));if(predicate(data))return data;}catch{}
  await delay(12);
 }
 throw Error('event did not persist');
}

test('historical compression snapshots remain restorable without an active compression feature',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-logs-legacy-'));
 const root=path.join(temp,'workspace'),state=path.join(temp,'policies'),file=path.join(root,'note.md');
 await fs.mkdir(root);
 const original='Alpha paragraph for repeat.\n\nBeta different paragraph.\n\nAlpha paragraph for repeat.';
 const after='Alpha paragraph for repeat.\n\nBeta different paragraph.';
 await fs.writeFile(file,after);
 let instance;
 try{
  instance=start(state,root);
  const workspace=(await instance.request('POST','/workspaces',{root})).workspace;
  assert.equal((await instance.request('GET','/tree?id='+workspace.id)).code,200);
  const beforeHash=sha(original),afterHash=sha(after);
  const backup=path.join(temp,'workspace-governance-backups',workspace.id,beforeHash+'.snapshot');
  const logFile=path.join(temp,'workspace-governance-events',workspace.id+'.json');
  await fs.mkdir(path.dirname(backup),{recursive:true});
  await fs.mkdir(path.dirname(logFile),{recursive:true});
  await fs.writeFile(backup,original);
  const event={id:'legacy-compression',type:'compressed',path:'note.md',
    detail:'历史人工压缩',at:'2026-11-01T08:00:00.000Z',
    beforeChars:countCharacters(original),afterChars:countCharacters(after),
    backupHash:beforeHash,expectedHash:afterHash};
  await fs.writeFile(logFile,JSON.stringify([event]));
  const logs=(await instance.request('GET','/maintenance?id='+workspace.id)).events;
  assert.equal(logs.length,1);
  assert.equal(logs[0].type,'compressed');
  assert.equal((await instance.request('POST','/restore',{id:workspace.id,path:'note.md',
    backupHash:beforeHash,expectedHash:afterHash,confirmed:true})).code,200);
  assert.equal(await fs.readFile(file,'utf8'),original);
  await instance.request('POST','/scan',{id:workspace.id});
  assert.deepEqual(new Set((await instance.request('GET','/maintenance?id='+workspace.id)).events.map(e=>e.type)),
    new Set(['compressed','restored']),'legacy recovery must not generate a generic duplicate edit');
 }finally{instance?.close();await fs.rm(temp,{recursive:true,force:true});}
});
test('restart preserves existing content-change logs without relying on compression',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-logs-restart-'));
 const root=path.join(temp,'workspace'),state=path.join(temp,'policies'),file=path.join(root,'note.md');
 await fs.mkdir(root);
 await fs.writeFile(file,'first');
 let first,second;
 try{
  first=start(state,root);
  const ws=(await first.request('POST','/workspaces',{root})).workspace;
  await first.request('GET','/tree?id='+ws.id);
  await fs.writeFile(file,'second');
  await first.request('POST','/scan',{id:ws.id});
  assert.equal((await first.request('GET','/maintenance?id='+ws.id)).events.length,1);
  first.close();first=null;
  second=start(state,root);
  await second.request('GET','/tree?id='+ws.id);
  await fs.writeFile(file,'third');
  await second.request('POST','/scan',{id:ws.id});
  const events=(await second.request('GET','/maintenance?id='+ws.id)).events;
  assert.equal(events.length,2);
  assert.ok(events.every(e=>e.path==='note.md'&&e.type==='changed'));
 }finally{first?.close();second?.close();await fs.rm(temp,{recursive:true,force:true});}
});
test('retired manual compression routes are inaccessible and never change Markdown',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-retired-compress-'));
 const root=path.join(temp,'workspace'),state=path.join(temp,'policies'),file=path.join(root,'note.md');
 await fs.mkdir(root);
 const content='Repeated paragraph appears here.\n\nRepeated paragraph appears here.';
 await fs.writeFile(file,content);
 let instance;
 try{
  instance=start(state,root);
  const ws=(await instance.request('POST','/workspaces',{root})).workspace;
  for(const route of ['/preview','/apply']){
   const result=await instance.request('POST',route,
     {id:ws.id,path:'note.md',confirmed:true,expectedHash:sha(content)});
   assert.equal(result.code,404);
  }
  assert.equal(await fs.readFile(file,'utf8'),content);
 }finally{instance?.close();await fs.rm(temp,{recursive:true,force:true});}
});
test('watching an external Markdown edit creates a persisted log without manual scanning',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-logs-watcher-'));
 const root=path.join(temp,'workspace'),state=path.join(temp,'policies'),file=path.join(root,'note.md');
 await fs.mkdir(root);
 await fs.writeFile(file,'one');
 let instance;
 try{
  instance=start(state,root);
  const ws=(await instance.request('POST','/workspaces',{root})).workspace;
  assert.equal((await instance.request('GET','/tree?id='+ws.id)).code,200);
  await fs.writeFile(file,'two and more');
  const events=await waitFor(path.join(temp,'workspace-governance-events',ws.id+'.json'),
    items=>items.some(item=>item.path==='note.md'&&item.type==='changed'));
  const log=events.find(item=>item.path==='note.md'&&item.type==='changed');
  assert.equal(log.beforeChars,3);
  assert.equal(log.afterChars,12);
 }finally{instance?.close();await fs.rm(temp,{recursive:true,force:true});}
});

test('direct Markdown changes are logged once without an Agent receipt or a character reduction',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-logs-edits-'));
 const root=path.join(temp,'workspace'),state=path.join(temp,'policies'),file=path.join(root,'note.md');
 await fs.mkdir(root);
 const initial='ABCD\nEFGH',equalLength='WXYZ\n1234',shorter='short';
 await fs.writeFile(file,initial);
 let instance;
 try{
  instance=start(state,root);
  const ws=(await instance.request('POST','/workspaces',{root})).workspace;
  assert.equal((await instance.request('GET','/tree?id='+ws.id)).code,200);
  assert.equal((await instance.request('GET','/maintenance?id='+ws.id)).events.length,0);
  await fs.writeFile(file,equalLength);
  assert.equal((await instance.request('POST','/scan',{id:ws.id})).code,200);
  let events=(await instance.request('GET','/maintenance?id='+ws.id)).events;
  assert.equal(events.length,1);
  assert.equal(events[0].type,'changed');
  assert.equal(events[0].beforeChars,initial.length);
  assert.equal(events[0].afterChars,equalLength.length);
  assert.equal(events[0].detail,'Markdown 内容已修改');
  await instance.request('POST','/scan',{id:ws.id});
  assert.equal((await instance.request('GET','/maintenance?id='+ws.id)).events.length,1);
  await fs.writeFile(file,shorter);
  await instance.request('POST','/scan',{id:ws.id});
  events=(await instance.request('GET','/maintenance?id='+ws.id)).events;
  assert.equal(events.length,2);
  assert.equal(events[0].beforeChars,equalLength.length);
  assert.equal(events[0].afterChars,shorter.length);
  await fs.writeFile(path.join(root,'added.md'),'new');
  await instance.request('POST','/scan',{id:ws.id});
  events=(await instance.request('GET','/maintenance?id='+ws.id)).events;
  assert.equal(events.length,3);
  assert.equal(events[0].detail,'新增 Markdown 文件');
  assert.equal(events[0].afterChars,3);
  assert.equal(events[0].beforeChars,undefined);
  await fs.unlink(path.join(root,'added.md'));
  assert.equal((await instance.request('POST','/scan',{id:ws.id})).code,200);
  await waitFor(path.join(temp,'workspace-governance-events',ws.id+'.json'),
    items=>items.some(item=>item.detail==='删除 Markdown 文件'));
  events=(await instance.request('GET','/maintenance?id='+ws.id)).events;
  assert.equal(events.length,4);
  assert.equal(events[0].detail,'删除 Markdown 文件');
  assert.equal(events[0].beforeChars,3);
  assert.equal(events[0].afterChars,undefined);
  const changedPolicy=await instance.request('PUT','/defaults',{id:ws.id,
    expectedVersion:ws.policy.version,defaultFileLimit:3000,warningRatio:ws.policy.warningRatio});
  assert.equal(changedPolicy.code,200);
  await instance.request('POST','/scan',{id:ws.id});
  assert.equal((await instance.request('GET','/maintenance?id='+ws.id)).events.length,4,
    'policy-only changes are not Markdown edits');
 }finally{instance?.close();await fs.rm(temp,{recursive:true,force:true});}
});
