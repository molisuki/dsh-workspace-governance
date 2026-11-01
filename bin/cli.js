#!/usr/bin/env node
import { createRegistry, scanWorkspace } from '../lib/core.js';
const args=process.argv.slice(2);
const usage='Usage: node bin/cli.js list | add <absolute-path> | check <workspace-id> | rules <workspace-id>';try{
  const registry=await createRegistry();
  if(args[0]==='list')console.log(JSON.stringify(registry.snapshot(),null,2));
  else if(args[0]==='add'&&args[1])console.log(JSON.stringify(await registry.add(args[1]),null,2));
  else if(args[0]==='rules'&&args[1]){
    const w=registry.find(args[1]);if(!w)throw Error('Unknown workspace');
    console.log(JSON.stringify(w.policy,null,2));
  }else if(args[0]==='check'&&args[1]){
    const w=registry.find(args[1]);if(!w)throw Error('Unknown workspace');
    const report=await scanWorkspace(w);console.log(JSON.stringify(report,null,2));
    if(report.truncated||report.issues.some(i=>['overflow','aggregate-overflow','row-overflow'].includes(i.type)))process.exitCode=1;
  }else throw Error(usage);
}catch(e){console.error(e.message);process.exitCode=2;}
