import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {apply} from '../lib/index.js';
import {countCharacters,effectivePolicy,proposeDuplicateCompression} from '../lib/core.js';

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

test('approved duplicate compression records effective character delta and remains restore-capable',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-logs-compress-'));
 const root=path.join(temp,'workspace'),state=path.join(temp,'policies'),file=path.join(root,'note.md');
 await fs.mkdir(root);
 const original='Alpha paragraph for repeat.\n\nBeta different paragraph.\n\nAlpha paragraph for repeat.';
 assert.ok(proposeDuplicateCompression(original).removed.length>0);
 await fs.writeFile(file,original);
 let instance;
 try{
  instance=start(state,root);
  const workspace=(await instance.request('POST','/workspaces',{root})).workspace;
  const preview=await instance.request('POST','/preview',{id:workspace.id,path:'note.md'});
  assert.equal(preview.code,200);
  const applied=await instance.request('POST','/apply',{id:workspace.id,path:'note.md',
   confirmed:true,expectedHash:preview.proposal.beforeHash});
  assert.equal(applied.code,200);
  const event=(await instance.request('GET','/maintenance?id='+workspace.id)).events.find(e=>e.type==='compressed');
  assert.ok(event);
  const mode=effectivePolicy(workspace.policy,'note.md').mode;
  const updated=await fs.readFile(file,'utf8');
  assert.equal(event.beforeChars,countCharacters(original,mode));
  assert.equal(event.afterChars,countCharacters(updated,mode));
  assert.equal(event.expectedHash,sha(updated));
  const restored=await instance.request('POST','/restore',{id:workspace.id,path:'note.md',
   backupHash:event.backupHash,expectedHash:event.expectedHash,confirmed:true});
  assert.equal(restored.code,200);
  assert.equal(await fs.readFile(file,'utf8'),original);
 }finally{instance?.close();await fs.rm(temp,{recursive:true,force:true});}
});
