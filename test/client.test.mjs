import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
async function clientPlugin(){
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 let module;
 const React={
  createElement:(type,props,...children)=>({type,props,children}),
  useState:value=>[typeof value==='function'?value():value,()=>{}],
  useRef:value=>({current:value}),
  useCallback:fn=>fn,
  useMemo:fn=>fn(),
  useEffect:()=>{}
 };
 const sandbox={
  window:{__ModuleLoader__:{load(value){module=value;}}},
  document:{createElement(){return {dataset:{},remove(){}};},head:{appendChild(){}}},
  console
 };
 vm.runInNewContext(source,sandbox,{filename:'client.js'});
 assert.equal(module.id,'dsh-workspace-governance');
 const plugin=module.factory(name=>{assert.equal(name,'react');return React;});
 return {plugin};
}
const scopeFor=(rows,items)=>({
 sessions:{list:{getSnapshot:()=>({byId:Object.fromEntries(rows.map(r=>[r.id,r]))})}},
 workspaces:{list:{getSnapshot:()=>({items})}}
});
test('browser bundle registers sidebar and main panel using native DSH services',async()=>{
 const {plugin}=await clientPlugin();
 let main,styles=0,cleanup;
 const services=scopeFor([],[]);
 const ctx={
  effect(fn){cleanup=fn();},
  inject(names,run){assert.deepEqual(Array.from(names),['slots','sessions','workspaces']);run({...services,slots:this.slots});},
  slots:{
   inject(slot,fn){assert.ok(['main','sidebar.panellist'].includes(slot));fn();},
   register(opts,component){
    if(opts.name==='main'){main=component;assert.equal(opts.key,'workspace-governance');}
    else assert.equal(opts.id,'workspace-governance');
    return()=>{};
   }
  }
 };
 // Fake DOM is already supplied, only the scope wiring and render need validation.
 plugin.apply(ctx);
 assert.equal(typeof main,'function');
 const view=main();
 assert.equal(view.type.name,'Page');
 assert.equal(view.props.services.sessions,services.sessions);
 const shell=view.type(view.props);
 assert.equal(shell.type,'main');
 cleanup();
});
test('Markdown mind map integrates file health fills and retains existing detail budgets',async()=>{
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 const map=source.slice(source.indexOf('  function MindMap('),source.indexOf('  function Page({services})'));
 assert.ok(map.includes('wg-map-file-fill'));
 assert.ok(map.includes('wg-map-label'));
 assert.ok(map.includes('wg-map-percent'));
 assert.ok(map.includes("addEventListener('wheel',onWheel,{passive:false})"));
 assert.ok(map.includes('onPointerMove'));
 assert.ok(map.includes('onToggle'));
 assert.ok(!map.includes('wg-tree-amount'));
 assert.ok(!map.includes('wg-tree-name'));
 assert.ok(!map.includes('node.fileLimit'));
 assert.ok(source.includes('目录文档容量'));
 assert.ok(source.includes('Agent 容量提示'));
 assert.ok(source.includes('已扫描字符 / 单文件上限'));
 assert.ok(source.includes('所有后代 MD 累计上限')===false);
 assert.ok(source.includes('执行与字符优化日志'));
 assert.ok(source.includes("type:'radio',name:'wg-capacity-mode'"));
 assert.ok(source.includes("request('/mode','PUT'"));
 assert.ok(source.includes("request('/maintenance?id='"));
});
test('mind map card and original detail panel preserve the existing navigation and maintenance surfaces',async()=>{
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 assert.ok(source.includes("c('h1',null,'Workspace Governance')"));
 assert.ok(source.includes("c('aside',{className:'wg-card wg-mindmap-card'}"));
 assert.ok(source.includes("c('section',{className:'wg-details'}"));
 assert.ok(source.includes("    maintenancePanel"));
 assert.ok(source.includes("          limitEditor"));
 assert.ok(source.includes("c('div',{className:'wg-capacity-percent '+capacity.kind}"));
 assert.ok(source.includes("role:'radiogroup','aria-label':'Agent 容量管理模式'"));
 assert.ok(!source.includes("wg-settings-trigger','aria-label'"));
 assert.ok(source.includes("['tree','目录'],['warning','预警'],['overflow','超限'],['overrides','专项'],['logs','日志']"));
 assert.ok(source.includes("'专项文档'"));
 assert.ok(!source.includes('专项 · 已设上限'));
 assert.ok(source.includes("setExpanded({'':true});setMapFrameRequest(0)"));
 assert.ok(!source.includes("['special','专项']"));
 assert.ok(source.includes("request('/logs','DELETE'"));
 assert.ok(source.includes("tab==='logs'?logPanel"));
 assert.ok(!source.includes('专项视图仅标识受保护文档'));
 assert.ok(!source.includes('protectedFile:protectedPath'));
 assert.ok(!source.includes("['tree','容量监控']"));
 assert.ok(!source.includes("['rules','阈值设置']"));
 assert.ok(!source.includes("placeholder:'搜索 Markdown 或目录路径'"));
 assert.ok(!source.includes("className:'wg-map-toolbar'"));
 assert.ok(!source.includes("className:'wg-map-expander'"));
 assert.ok(source.includes('grid-template-columns:repeat(2,minmax(0,1fr))!important'));
 assert.ok(source.includes('align-items:stretch!important'));
 assert.ok(source.includes('height:100%!important'));
 assert.ok(source.includes('background:#fff!important;color:#293a50!important'));
 assert.ok(source.includes('.wg-map-controls{position:absolute;right:10px;bottom:10px'));
 assert.ok(source.includes('shape-rendering:geometricPrecision'));
 assert.ok(source.includes('text-rendering:optimizeLegibility'));
 assert.ok(source.includes('.wg-map-viewport{position:relative;flex:1;min-height:260px'));
 assert.ok(!source.includes('min-height:clamp(360px,52vh,620px)'));
 assert.ok(!source.includes('.wg-map-viewport{min-height:0}'));
 assert.ok(source.includes('box-shadow:0 6px 20px #203b5910'));
 assert.ok(source.includes('Math.round(view.x*dpr)/dpr'));
 assert.ok(source.includes('leftBias=112'));
 assert.ok(source.includes('scan.policyVersion===current.policy.version'));
 assert.ok(source.includes('sequence===scanRequest.current'));
 assert.ok(!source.includes('存在超限文档'));
});
test('client stylesheet and topology contain no obsolete tree/search/icon/switch remnants',async()=>{
 const source=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 const removed=['.wg-search{','.wg-tree-row{','.wg-tree-name{','.wg-chevron{','.wg-diagnostics{',
  '.wg-issue{','.wg-switch{','.wg-guard-toggle{','.wg-icon{','.wg-button.primary{',
  'const Icon=',"filter=''",'const search=filter.trim()',"className:'wg-search'"];
 assert.equal(source.includes('wg-tree-panel'),false);
 assert.equal(source.includes("'.wg-tree{"),false);
 for(const dead of removed)assert.equal(source.includes(dead),false,'Obsolete client code: '+dead);
 assert.ok(source.includes("c('aside',{className:'wg-card wg-mindmap-card'"));
 assert.ok(source.includes('wg-map-viewport'));
 assert.ok(source.includes("['overrides','专项'],['logs','日志']"));
});
test('capacity status uses scan outcomes without inventing an automatic compaction state',async()=>{
 const {plugin}=await clientPlugin();
 assert.equal(plugin.capacityStatus(null,null).kind,'idle');
 assert.equal(plugin.capacityStatus({type:'file',path:'notes.md',status:'ok',chars:100,limit:2400},{}).kind,'normal');
 assert.equal(plugin.capacityStatus({type:'file',path:'notes.md',status:'warning',chars:2000,limit:2400},{}).kind,'warning');
 assert.equal(plugin.capacityStatus({type:'file',path:'notes.md',status:'overflow'},{}).kind,'overlimit');
 assert.equal(plugin.capacityStatus({type:'file',path:'index.md',status:'ok',chars:50,limit:2400},{}).kind,'normal');
 assert.equal(plugin.capacityStatus({type:'file',path:'index.md',status:'overflow',chars:2500,limit:2400},{}).kind,'overlimit');
 assert.equal(plugin.capacityStatus({type:'folder',path:'docs',status:'unlimited'},{
   issues:[{type:'aggregate-overflow',path:'docs/research'}]
 }).kind,'neutral');
 assert.equal(plugin.capacityStatus({type:'folder',path:'other',status:'unlimited'},{
   issues:[{type:'aggregate-overflow',path:'docs'}]
 }).kind,'neutral');
});
test('native workspace follows main-view ownership, not stale registry order',async()=>{
 const {plugin}=await clientPlugin();
 const rows=[{id:'s-1',cwd:'C:\\Projects\\A',retainedBy:{mainView:1}},
             {id:'s-2',cwd:'D:\\Projects\\B',retainedBy:{mainView:0}}];
 const items=[{workspaceId:'b',path:'D:\\Projects\\B',sessionIds:['s-2']},
              {workspaceId:'a',path:'C:\\Projects\\A',sessionIds:['s-1']}];
 const scope=scopeFor(rows,items);
 assert.equal(plugin.nativeWorkspaceRoot(scope),'C:\\Projects\\A');
 rows[0].retainedBy.mainView=0;
 rows[1].retainedBy.mainView=1;
 assert.equal(plugin.nativeWorkspaceRoot(scope),'D:\\Projects\\B');
 rows[0].retainedBy.mainView=1;
 assert.equal(plugin.nativeWorkspaceRoot(scope),null,'ambiguous simultaneous owners must not guess');
 rows[0].retainedBy.mainView=0;
 rows[1].retainedBy.mainView=0;
 assert.equal(plugin.nativeWorkspaceRoot(scope),null,'no main-view owner must not switch to random first workspace');
 assert.equal(plugin.nativeWorkspaceRoot(scopeFor([], [{workspaceId:'alone',path:'E:\\Single',sessionIds:[]}])), 'E:\\Single', 'single registered workspace can be selected without a session');
 assert.equal(plugin.nativeWorkspaceRoot(scopeFor([{id:'s3',cwd:'E:\\Temp\\Repo',retainedBy:{mainView:1}}],[])),'E:\\Temp\\Repo');
 assert.equal(plugin.nativeWorkspaceRoot({}),null);
});
test('DSH internal default directory is never mistaken for an active project workspace',async()=>{
 const {plugin}=await clientPlugin();
 const internal='C:\\Users\\ExampleUser\\Documents\\deepseek-harness\\default-workspace';
 const actual='D:\\Demo Projects\\SampleProject';
 const services=scopeFor([], [{workspaceId:'default',path:internal,sessionIds:[]}]);
 assert.equal(plugin.nativeWorkspaceRoot(services),null,'single internal DSH fallback must not be a project');
 const active=scopeFor([{id:'session',cwd:internal,workspaceId:'default',retainedBy:{mainView:1}}],
  [{workspaceId:'default',path:internal,sessionIds:['session']}]);
 assert.equal(plugin.nativeWorkspaceRoot(active),null,'main-view agent under DSH fallback is not a project');
 assert.equal(plugin.nativeWorkspaceRoot(scopeFor([{id:'s',cwd:actual,workspaceId:'default',retainedBy:{mainView:1}}],
  [{workspaceId:'default',path:internal,sessionIds:['s']}])),actual,'actual session cwd takes precedence over internal placeholder');
 assert.equal(plugin.nativeWorkspaceRoot(scopeFor([{id:'s',cwd:internal,workspaceId:'project',retainedBy:{mainView:1}}],
  [{workspaceId:'project',path:actual,sessionIds:['s']}])),actual,'explicit project mapping takes precedence');
 let posts=0;
 assert.equal(await plugin.ensureNativeWorkspace(internal,async()=>{posts++;throw Error('must not query/register internal fallback');}),null);
 assert.equal(posts,0);
});
test('paused native workspace never auto-registers, only explicit manual reactivation can resume it',async()=>{
 const {plugin}=await clientPlugin();
 const root='D:\\\\Demo Projects\\\\SampleProject';
 let posts=0;
 const send=async(route,method='GET')=>{
  if(method==='GET')return {workspaces:[],suspendedRoots:[root]};
  posts++;throw Error('must not auto-register paused root');
 };
 assert.equal(await plugin.ensureNativeWorkspace(root,send),null);
 assert.equal(posts,0);
});
test('zero-config registration is idempotent and preserves existing workspace policy',async()=>{
 const {plugin}=await clientPlugin();
 const existing={id:'persist',root:'D:\\Demo Projects\\SampleProject',policy:{version:23,defaultFileLimit:777}};
 const created={id:'new',root:'D:\\Projects\\Another',policy:{version:1,defaultFileLimit:2400}};
 const workspaces=[existing],calls=[];
 const send=async(path,method='GET',body)=>{
  calls.push([path,method,body]);
  if(method==='GET')return {workspaces:[...workspaces]};
  assert.equal(path,'/workspaces');assert.equal(method,'POST');
  assert.equal(body.root,'D:\\Projects\\Another');
  workspaces.push(created);return {workspace:created};
 };
 const retained=await plugin.ensureNativeWorkspace('d:/demo projects/SAMPLEPROJECT/',send);
 assert.equal(retained.id,'persist');
 assert.equal(retained.policy.defaultFileLimit,777);
 assert.equal(calls.filter(x=>x[1]==='POST').length,0);
 const first=await plugin.ensureNativeWorkspace('D:\\Projects\\Another',send);
 assert.equal(first.id,'new');
 const second=await plugin.ensureNativeWorkspace('d:/projects/another/',send);
 assert.equal(second.id,'new');
 assert.equal(calls.filter(x=>x[1]==='POST').length,1);
});
