import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {createRegistry,workspacePolicyPath} from '../lib/core.js';
import {apply} from '../lib/index.js';

test('stop tracking survives restart, preserves workspace-specific thresholds, and blocks auto re-registration',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'governance-pause-'));
 const root=path.join(temp,'project'),store=path.join(temp,'state');
 await fs.mkdir(root);
 let cleanup=()=>{};
 const makeApi=()=>{
   let handler;
   const ctx={logger:{warn(){},error(){}},
     webServer:{register(spec){handler=spec.handler;return ()=>{};}},
     workingDirectory:{get:()=>root},on(){},
     effect(fn){const stop=fn();cleanup=()=>stop?.();}};
   apply(ctx,{stateDirectory:store});
   return async(method,endpoint,body)=>{
     const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
     req.method=method;req.url='/api/dsh-workspace-governance'+endpoint;
     req.headers={host:'127.0.0.1:19000',...(method==='GET'?{}:{'x-wg-request':'1'})};
     let code,reply;await handler(req,{writeHead(c){code=c;},end(s){reply=JSON.parse(s);}});
     return {code,...reply};
   };
 };
 try{
   let api=makeApi();
   const added=await api('POST','/workspaces',{root});
   assert.equal(added.code,200);
   const ws=added.workspace;
   const custom=await api('PUT','/defaults',{id:ws.id,defaultFileLimit:789,aggregateLimit:null,warningRatio:0.9,expectedVersion:1});
   assert.equal(custom.code,200);
   const suspended=await api('DELETE','/workspaces',{id:ws.id});
   assert.equal(suspended.code,200);
   assert.equal(suspended.suspended,true);
   const after=await api('GET','/workspaces');
   assert.equal(after.workspaces.length,0);
   assert.ok(after.suspendedRoots.includes(root));
   assert.equal((await api('POST','/workspaces',{root})).code,409,'automatic registration must not silently resume a paused workspace');
   assert.equal((await fs.stat(workspacePolicyPath(root,store))).isFile(),true,'policy is preserved');
   cleanup();
   api=makeApi();
   const restarted=await api('GET','/workspaces');
   assert.equal(restarted.workspaces.length,0);
   assert.ok(restarted.suspendedRoots.includes(root));
   assert.equal((await api('POST','/workspaces',{root})).code,409);
   const manual=await api('POST','/workspaces',{root,manual:true});
   assert.equal(manual.code,200);
   assert.equal(manual.workspace.policy.defaultFileLimit,789);
   assert.equal(manual.workspace.policy.warningRatio,0.9);
   assert.equal((await api('GET','/workspaces')).suspendedRoots.length,0);
 }finally{cleanup();await fs.rm(temp,{recursive:true,force:true});}
});
