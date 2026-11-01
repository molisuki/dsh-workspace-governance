import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {apply} from '../lib/index.js';
test('review → version guard → approved compression → rollback, without touching user repositories',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'wg-api-test-'));
 const repo=path.join(tmp,'repo'),doc=path.join(repo,'docs','repeated.md');
 await fs.mkdir(path.dirname(doc),{recursive:true});
 const paragraph='This is the same intentionally repeated paragraph with a stable meaning.';
 const original='# Review\n\n'+paragraph+'\n\nDifferent content should be preserved.\n\n'+paragraph+'\n';
 await fs.writeFile(doc,original);
 await fs.writeFile(path.join(repo,'AGENTS.md'),paragraph+'\n\n'+paragraph+'\n');
 let handler,dispose;
 const ctx={logger:{warn(){},error(){}},
  webServer:{register(spec){handler=spec.handler;return()=>{handler=null;};}},
  effect(fn){dispose=fn();}
 };
 apply(ctx,{stateDirectory:path.join(tmp,'workspaces')});
 const call=async(method,route,body,headers={})=>{
  const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
  req.method=method;req.url='/api/dsh-workspace-governance'+route;
  req.headers={host:'127.0.0.1:19000',...(method==='GET'?{}:{'x-wg-request':'1'}),...headers};
  let code,response;
  await handler(req,{writeHead(n){code=n;},end(text){response=JSON.parse(text);}});
  return {code,...response};
 };
 try{
  const registered=await call('POST','/workspaces',{root:repo});
  assert.equal(registered.code,200);
  const id=registered.workspace.id;
  const defaults=await call('PUT','/defaults',{id,defaultFileLimit:3600,warningRatio:0.8,aggregateLimit:5000,expectedVersion:1});
  assert.equal(defaults.code,200);
  assert.equal(defaults.policy.aggregateLimit,5000);
  const directory=await call('PUT','/rules',{id,scope:'directories',relative:'docs',rule:{fileLimit:500,aggregateLimit:700},expectedVersion:2});
  assert.equal(directory.code,200);
  const view=await call('GET','/tree?id='+encodeURIComponent(id));
  assert.equal(view.code,200);
  assert.equal(view.scan.tree.limit,5000);
  const docs=view.scan.tree.children.find(x=>x.path==='docs');
  assert.equal(docs.limit,700);
  assert.equal(docs.fileLimit,500);
  const staleBudget=await call('PUT','/rules',{id,scope:'directories',relative:'docs',rule:{aggregateLimit:100},expectedVersion:2});
  assert.equal(staleBudget.code,409);
  const same=await call('GET','/workspaces');
  assert.equal(same.workspaces.find(w=>w.id===id).policy.directories.docs.aggregateLimit,700);
  const before=await call('POST','/preview',{id,path:'docs/repeated.md'});
  assert.equal(before.proposal.removed.length,1);
  assert.ok(before.proposal.reducedCodepoints>0);
  await fs.appendFile(doc,'Concurrent user edit\n');
  const stale=await call('POST','/apply',{id,path:'docs/repeated.md',confirmed:true,expectedHash:before.proposal.beforeHash});
  assert.equal(stale.code,409);
  assert.match(await fs.readFile(doc,'utf8'),/Concurrent user edit/);
  await fs.writeFile(doc,original);
  const applied=await call('POST','/apply',{id,path:'docs/repeated.md',confirmed:true,expectedHash:before.proposal.beforeHash});
  assert.equal(applied.code,200);
  assert.equal(applied.removedCount,1);
  assert.equal((await fs.readFile(doc,'utf8')).includes(paragraph),true);
  assert.equal((await fs.readFile(doc,'utf8')).split(paragraph).length,2);
  const restored=await call('POST','/restore',{id,path:'docs/repeated.md',confirmed:true,backupHash:applied.beforeHash,expectedHash:applied.afterHash});
  assert.equal(restored.code,200);
  assert.equal(await fs.readFile(doc,'utf8'),original);
  const protectedPreview=await call('POST','/preview',{id,path:'AGENTS.md'});
  assert.equal(protectedPreview.protected,true);
  const denied=await call('POST','/apply',{id,path:'AGENTS.md',confirmed:true,expectedHash:protectedPreview.proposal.beforeHash});
  assert.equal(denied.code,403);
  const csrf=await call('POST','/workspaces',{root:repo},{'x-wg-request':'0'});
  assert.equal(csrf.code,403);
 }finally{dispose();await fs.rm(tmp,{recursive:true,force:true});}
});