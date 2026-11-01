import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

async function load(){
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 let module;
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(input){module=input;}}}});
 const plugin=module.factory(()=>({createElement(){}}));
 return {source,capacityStatus:plugin.capacityStatus};
}
test('workspace-derived ratio, inclusive warning threshold and true overflow have distinct states',async()=>{
 const {capacityStatus}=await load();
 const doc=chars=>({type:'file',path:'notes.md',status:'ok',chars,limit:2400});
 const kind=(chars,ratio=0.8)=>capacityStatus(doc(chars),{issues:[]},ratio).kind;
 assert.equal(kind(0),'normal');
 assert.equal(kind(1919),'normal');
 assert.equal(kind(1920),'warning');
 assert.equal(kind(2376),'warning');
 assert.equal(kind(2400),'warning');
 assert.equal(kind(2401),'overlimit');
 assert.equal(kind(2159,0.9),'normal');
 assert.equal(kind(2160,0.9),'warning');
 assert.equal(kind(1200,0.5),'warning');
 assert.equal(kind(1300,0.5),'warning');
});
test('unlimited directory does not display false normal or fabricated utilization',async()=>{
 const {capacityStatus}=await load();
 const root={type:'folder',path:'',status:'unlimited',chars:224297,files:215,limit:null};
 const state=capacityStatus(root,{issues:[]},0.8);
 assert.equal(state.kind,'neutral');
 assert.equal(state.hasBudget,false);
 assert.equal(state.percentage,null);
 const affected=capacityStatus(root,{issues:[{type:'overflow',path:'docs/a.md'}]},0.8);
 assert.equal(affected.kind,'neutral','a child overrun cannot masquerade as a root aggregate-budget overrun');
 assert.equal(affected.hasBudget,false);
 assert.equal(affected.label,'');
 const ownAggregate=capacityStatus({...root,limit:12000,chars:14000,status:'overflow'},
  {issues:[{type:'aggregate-overflow',path:'',current:14000,limit:12000}]},0.8);
 assert.equal(ownAggregate.kind,'overlimit');
 assert.equal(ownAggregate.hasBudget,true);
 const childOnlyWithOwnBudget=capacityStatus({...root,limit:300000,status:'ok'},
  {issues:[{type:'overflow',path:'docs/a.md'}]},0.8);
 assert.equal(childOnlyWithOwnBudget.kind,'normal','only this directory aggregate budget sets directory health');
 const incomplete=capacityStatus(root,{truncated:true,issues:[]},0.8);
 assert.equal(incomplete.kind,'unverified');
 assert.equal(incomplete.percentage,null);
 const other={type:'folder',path:'other',status:'unlimited',chars:400,limit:null};
 assert.equal(capacityStatus(other,{issues:[{type:'overflow',path:'docs/a.md'}]},0.8).kind,'neutral');
 assert.equal(capacityStatus(other,{issues:[{type:'aggregate-overflow',path:'docs/research'}]},0.8).kind,'neutral');
});
test('all Markdown documents obey the same inherited file budget',async()=>{
 const {capacityStatus}=await load();
 const registry={type:'file',path:'index.md',status:'ok',chars:2000,limit:2400};
 assert.equal(capacityStatus(registry,{issues:[]}).kind,'warning');
 assert.equal(capacityStatus(registry,{issues:[]}).hasBudget,true);
 assert.equal(capacityStatus({...registry,chars:2401},{issues:[]}).kind,'overlimit');
 assert.equal(capacityStatus({type:'file',path:'PLAN.md',status:'ok',chars:100,limit:8000},{issues:[]}).hasBudget,true);
});
test('capacity panel removes redundant statistics and conditionally renders controls',async()=>{
 const {source}=await load();
 const card=source.slice(source.indexOf("c('div',{className:'wg-card wg-capacity-card'}"),
   source.indexOf('          limitEditor,'));
 assert.ok(card.includes('displayLimit===null?null'));
 assert.ok(card.includes('usageRate===null?null'));
 assert.ok(card.includes("'wg-progress-fill '+capacity.kind"));
 assert.ok(card.includes("canReviewDuplicates?"));
 assert.ok(!card.includes('wg-capacity-grid'));
 assert.ok(!card.includes("'/ 未设置'"));
 assert.ok(source.includes("tab==='logs'?logPanel"));
 assert.ok(source.includes('执行与字符优化日志'));
 assert.ok(source.includes('    maintenancePanel'));
 assert.ok(!source.includes("className:'wg-kpis'"));
});
