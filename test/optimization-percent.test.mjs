import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_POLICY,optimizationTarget,effectiveOptimizationPercent,effectivePolicy} from '../lib/core.js';
import {collectRemediationTasks} from '../lib/remediation-queue.js';

test('advisory target uses selected threshold minus reduction points',()=>{
 const policy={...structuredClone(DEFAULT_POLICY),defaultFileLimit:2400,
  optimizationPercent:10,warningRatio:.8,directories:{docs:{fileLimit:800}},
  files:{'docs/overridden.md':{fileLimit:600}}};
 assert.equal(effectiveOptimizationPercent(DEFAULT_POLICY),10);
 for(const [file,limit] of [['README.md',2400],['docs/inherited.md',800],['docs/overridden.md',600]]){
  assert.equal(effectivePolicy(policy,file).fileLimit,limit);
  assert.equal(optimizationTarget(policy,{limit,projected:limit},'warning').targetCount,Math.floor(limit*.7));
 }
 assert.deepEqual(optimizationTarget(policy,{limit:2400,projected:2520},'warning'),
  {percent:10,triggerPercent:80,targetUsagePercent:70,targetCount:1680,requiredReduction:840});
 assert.deepEqual(optimizationTarget(policy,{limit:2400,projected:2520},'overflow'),
  {percent:10,triggerPercent:100,targetUsagePercent:90,targetCount:2160,requiredReduction:360});
 assert.equal(optimizationTarget({...policy,optimizationPercent:5},{limit:2400,projected:2400,requiredReduction:181},'overflow').requiredReduction,181);
 assert.equal(optimizationTarget(policy,{limit:2400,projected:2520,requiredReduction:1000},'warning').requiredReduction,1000);
 assert.equal(optimizationTarget({...policy,warningRatio:.05},{limit:100,projected:10},'warning').targetCount,0);
});

test('each mode controls advisory tasks, independently of all write tools',()=>{
 const policy={...structuredClone(DEFAULT_POLICY),defaultFileLimit:100,
  optimizationPercent:10,warningRatio:.8,capacityMode:'warning'};
 const ws={id:'ws',policy};
 const scan={workspaceId:'ws',policyVersion:1,truncated:false,issues:[],
  tree:{type:'folder',path:'',limit:null,children:[
   {type:'file',path:'report.md',name:'report.md',chars:90,limit:100,digest:'a'}]}};
 assert.deepEqual(collectRemediationTasks(ws,scan).tasks.map(t=>[t.targetPercent,t.requiredReduction]),[[70,20]]);
 policy.capacityMode='overflow';
 assert.equal(collectRemediationTasks(ws,scan).total,0);
 scan.tree.children[0].chars=105;
 assert.deepEqual(collectRemediationTasks(ws,scan).tasks.map(t=>[t.targetPercent,t.requiredReduction]),[[90,15]]);
 policy.capacityMode='off';
 assert.equal(collectRemediationTasks(ws,scan).total,0);
});