import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {apply} from '../lib/index.js';
import {createRegistry} from '../lib/core.js';

test('mode configuration persists while plugin leaves native tools unmodified',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-soft-mode-'));
 const root=path.join(tmp,'repo'),state=path.join(tmp,'state');
 await fs.mkdir(root);
 let route,dispose;const events=[];
 const ctx={logger:{warn(){},error(){}},webServer:{register(opts){route=opts.handler;return()=>{};}},
  on(name){events.push(name);},effect(fn){dispose=fn();}};
 apply(ctx,{stateDirectory:state});
 const request=async(method,where,body)=>{
  const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
  req.method=method;req.url='/api/dsh-workspace-governance'+where;
  req.headers={host:'localhost:19000',...(method==='GET'?{}:{'x-wg-request':'1'})};
  let status,data;await route(req,{writeHead(x){status=x;},end(s){data=JSON.parse(s);}});
  return {status,...data};
 };
 try{
  const ws=(await request('POST','/workspaces',{root})).workspace;
  assert.equal((await request('PUT','/defaults',{id:ws.id,defaultFileLimit:100,warningRatio:.8,optimizationPercent:10,expectedVersion:1})).status,200);
  for(const [mode,version] of [['warning',2],['overflow',3],['off',4]]){
   assert.equal((await request('PUT','/mode',{id:ws.id,mode,expectedVersion:version})).status,200);
   const result=await request('GET','/maintenance?id='+ws.id);
   assert.equal(result.mode,mode);assert.equal(result.advisoryMode,'running-agent-steer');
   assert.equal(result.supportedTools,undefined);
  }
  assert.deepEqual(events,[]);
  assert.equal((await createRegistry(state)).find(ws.id).policy.capacityMode,'off');
 }finally{dispose?.();await fs.rm(tmp,{recursive:true,force:true});}
});