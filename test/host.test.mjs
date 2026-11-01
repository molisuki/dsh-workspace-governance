import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {apply,inject,name} from '../lib/index.js';
test('host route registration, read response and origin protection',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-host-'));
 let handler,cleanup;
 const ctx={
  logger:{warn(){},error(){}},
  webServer:{register(spec){assert.equal(spec.kind,'prefix');handler=spec.handler;return()=>{handler=null;};}},
  effect(fn){cleanup=fn();}
 };
 apply(ctx,{stateDirectory:path.join(temp,'state')});
 assert.equal(name,'dsh-workspace-governance');
 assert.deepEqual(inject,['webServer','agents','skills']);
  async function call(method,url,origin,body,host='127.0.0.1:19000',remote){
    const req=Readable.from(body?[JSON.stringify(body)]:[]);
    req.method=method;req.url=url;req.headers={host,...(origin?{origin}:{})};
    if(remote)req.socket={remoteAddress:remote};
    let code,reply;const res={writeHead(status){code=status;},end(data){reply=JSON.parse(data);}};
    await handler(req,res);return {code,reply};
  }
  try{
  const status=await call('GET','/api/dsh-workspace-governance/status');
  assert.equal(status.code,200);
  assert.ok(Array.isArray(status.reply.watching));
  const bad=await call('POST','/api/dsh-workspace-governance/workspaces','https://attacker.example',{root:'C:/Windows'});
  assert.equal(bad.code,403);
   assert.equal((await call('GET','/api/dsh-workspace-governance/workspaces',
     undefined,undefined,'attacker.example')).code,403,'DNS rebinding Host rejected');
   assert.equal((await call('GET','/api/dsh-workspace-governance/workspaces',
     undefined,undefined,'127.0.0.1:19000','192.0.2.45')).code,403,'remote peers rejected');
   assert.equal((await call('GET','/api/dsh-workspace-governance/workspaces',
     undefined,undefined,'127.0.0.1:19000','::ffff:127.0.0.1')).code,200);
   const wrong=await call('GET','/api/dsh-workspace-governance/tree?id=nonexistent');
   assert.equal(wrong.code,404);
  }finally{cleanup();await fs.rm(temp,{recursive:true,force:true});}
});
