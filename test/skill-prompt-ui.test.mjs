import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {DEFAULT_CUSTOM_PROMPT,DEFAULT_EMBEDDED_PROMPT,DEFAULT_CUSTOM_CANCEL_PROMPT,DEFAULT_EMBEDDED_CANCEL_PROMPT,effectiveSkillSettings} from '../lib/skill-strategy.js';

function find(tree,predicate){
 if(!tree||typeof tree!=='object')return null;
 if(predicate(tree))return tree;
 for(const child of tree.children??[]){const result=find(child,predicate);if(result)return result;}
 return null;
}
function matches(tree,predicate,out=[]){
 if(!tree||typeof tree!=='object')return out;
 if(predicate(tree))out.push(tree);
 for(const child of tree.children??[])matches(child,predicate,out);
 return out;
}
async function clientHarness(startMode='custom',{legacy=false}={}){
 let source=await fs.readFile(new URL('../lib/client.js',import.meta.url),'utf8');
 assert.ok(source.includes('return {apply,inject:'),'stable client factory signature for isolated UI test');
 source=source.replace('return {apply,inject:','return {Page,cancelFallback,apply,inject:');
 const persisted=effectiveSkillSettings({});
 persisted.mode=startMode;
 persisted.customSkill='Original Skill document';
 persisted.customPrompt='SAVED CUSTOM PROMPT';
 persisted.embeddedPrompt='SAVED EMBEDDED PROMPT';
 persisted.customCancelPrompt='SAVED CUSTOM CANCEL {{items}}';
 persisted.embeddedCancelPrompt='SAVED EMBEDDED CANCEL {{items}}';
 if(legacy){delete persisted.customCancelPrompt;delete persisted.embeddedCancelPrompt;}
 const workspace={id:'ws',name:'demo',root:'D:/demo',policy:{
  version:1,defaultFileLimit:2400,warningRatio:.8,optimizationPercent:10,
  capacityMode:'warning',directories:{},files:{}}};
 const status={ok:true,available:true,mode:'warning',workspaceId:'ws',policyVersion:1,
  events:[],skillSettings:{...persisted},
  skillPromptDefaults:{customPrompt:DEFAULT_CUSTOM_PROMPT,embeddedPrompt:DEFAULT_EMBEDDED_PROMPT,
   customCancelPrompt:DEFAULT_CUSTOM_CANCEL_PROMPT,embeddedCancelPrompt:DEFAULT_EMBEDDED_CANCEL_PROMPT}};
 if(legacy){delete status.skillPromptDefaults.customCancelPrompt;delete status.skillPromptDefaults.embeddedCancelPrompt;}
 const store=new Map([
  [0,[workspace]],[1,'ws'],[18,false],[19,false],[20,startMode],
  [21,persisted.customSkill],[22,persisted.customPrompt],
  [23,persisted.embeddedPrompt],[24,status],[25,false],
  [26,persisted.customCancelPrompt??DEFAULT_CUSTOM_CANCEL_PROMPT],
  [27,persisted.embeddedCancelPrompt??DEFAULT_EMBEDDED_CANCEL_PROMPT]
 ]);
 let cursor=0,module,effects=[];
 const calls=[];
 const React={
  createElement:(type,props,...children)=>({type,props:props??{},children}),
  useState:initial=>{
   const at=cursor++;
   if(!store.has(at))store.set(at,typeof initial==='function'?initial():initial);
   return [store.get(at),next=>store.set(at,typeof next==='function'?next(store.get(at)):next)];
  },
  useRef:value=>({current:value}),
  useEffect:(fn,deps)=>effects.push({fn,deps}),
  useMemo:fn=>fn(),
  useCallback:fn=>fn
 };
 const fetch=async(url,options)=>{
  const route=url.split('/api/dsh-workspace-governance')[1];
  if(route==='/skill-settings'&&options.method==='PUT'){
   const input=JSON.parse(options.body);
   calls.push({route,input});
   Object.assign(persisted,input.settings);
   workspace.policy.version++;
   status.policyVersion=workspace.policy.version;
   status.skillSettings={...persisted};
   return {ok:true,status:200,json:async()=>({ok:true,policy:{...workspace.policy}})};
  }
  if(route==='/logs'&&options.method==='DELETE'){
   const input=JSON.parse(options.body);calls.push({route,input});
   status.events=status.events.filter(event=>event.id!==input.eventId);
   return {ok:true,status:200,json:async()=>({ok:true,deletedId:input.eventId})};
  }
  if(route==='/restore'&&options.method==='POST'){
   const input=JSON.parse(options.body);calls.push({route,input});
   return {ok:true,status:200,json:async()=>({ok:true,path:input.path,restoredHash:input.backupHash})};
  }
  if(route==='/scan')return {ok:true,status:200,json:async()=>({ok:true,scan:{workspaceId:'ws',scanned:0,tree:{path:'',type:'folder',children:[]}}})};
  if(route==='/workspaces')return {ok:true,status:200,json:async()=>({
   ok:true,workspaces:[workspace],selected:'ws',suspendedRoots:[]
  })};
  if(route.startsWith('/maintenance?'))return {ok:true,status:200,json:async()=>({...status})};
  throw Error('Unexpected endpoint: '+route);
 };
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){module=value;}},confirm:()=>true,
  setInterval:()=>0,clearInterval:()=>{}},setInterval:()=>0,clearInterval:()=>{},fetch,console});
 const plugin=module.factory(()=>React);
 assert.equal(plugin.cancelFallback,DEFAULT_EMBEDDED_CANCEL_PROMPT,'legacy client fallback matches the server-owned canonical template');
 const render=()=>{cursor=0;effects=[];return plugin.Page({services:{}});};
 const syncMaintenance=async()=>{
  const effect=effects.find(item=>item.deps?.length===1&&item.deps[0]==='ws');
  assert.ok(effect,'maintenance refresh effect');
  effect.fn();
  for(let i=0;i<20;i++)await Promise.resolve();
 };
 return {render,syncMaintenance,store,calls,persisted,status};
}
const promptToggle=tree=>find(tree,n=>n.type==='button'&&n.props?.className==='wg-prompt-toggle');
const promptEditor=(tree,mode)=>find(tree,n=>n.type==='textarea'&&
 n.props?.['aria-label']===(mode==='custom'?'自定义 Agent 精简提示词':'内置 Skill Agent 精简提示词'));
const cancelToggle=tree=>find(tree,n=>n.type==='button'&&n.props?.['aria-controls']==='wg-cancel-prompt-content');
const cancelEditor=(tree,mode)=>find(tree,n=>n.type==='textarea'&&
 n.props?.['aria-label']===(mode==='custom'?'自定义 Agent 取消提示词':'内置 Skill Agent 取消提示词'));
const button=(tree,label)=>find(tree,n=>typeof n.type==='function'&&n.children?.[0]===label);
const actionRow=(tree,labels)=>find(tree,n=>n.props?.className==='wg-skill-actions'&&
 labels.every(label=>n.children?.some(child=>child.children?.[0]===label)));
const skillCardToggle=tree=>find(tree,n=>n.type==='button'&&n.props?.['aria-controls']==='wg-skill-content');
function openSkillCard(h){
 let tree=h.render();
 assert.equal(skillCardToggle(tree)?.props?.['aria-expanded'],false);
 skillCardToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(skillCardToggle(tree)?.props?.['aria-expanded'],true);
 return tree;
}

test('Agent Skill card and capacity guard start collapsed; Skill header alone expands and re-collapses its contents',async()=>{
 const h=await clientHarness('custom');
 let tree=h.render();
 const guard=find(tree,n=>n.type==='button'&&n.props?.['aria-controls']==='wg-advisory-content');
 assert.equal(guard?.props?.['aria-expanded'],false);
 assert.equal(skillCardToggle(tree)?.props?.['aria-expanded'],false);
 assert.equal(find(tree,n=>n.props?.id==='wg-skill-content'),null);
 assert.equal(promptToggle(tree),null);
 assert.equal(find(tree,n=>n.props?.['aria-label']==='Agent 精简 Skill 模式'),null);
 tree=openSkillCard(h);
 assert.ok(find(tree,n=>n.props?.id==='wg-skill-content'));
 assert.ok(promptToggle(tree));
 assert.equal(promptToggle(tree).props['aria-expanded'],false);
 skillCardToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(skillCardToggle(tree)?.props?.['aria-expanded'],false);
 assert.equal(find(tree,n=>n.props?.id==='wg-skill-content'),null);
 assert.equal(promptToggle(tree),null);
 assert.equal(h.calls.length,0,'collapsing or expanding the card cannot persist changes');
});

test('file change detection is read-only and does not expose a duplicate manual send path',async()=>{
 const h=await clientHarness('embedded');
 h.status.remediation={verified:true,total:1,overflow:0,tasks:[{
  id:'a'.repeat(64),fingerprint:'b'.repeat(64),kind:'file',path:'docs/notice.md',
  current:92,limit:100,usagePercent:92,trigger:'warning',triggerPercent:80,
  reductionPoints:10,targetPercent:70,targetChars:70,requiredReduction:22,
  protected:false}]};
 let tree=h.render();
 const guard=()=>find(tree,n=>n.type==='button'&&n.props?.['aria-controls']==='wg-advisory-content');
 const detector=()=>find(tree,n=>n.type==='button'&&n.props?.['aria-controls']==='wg-detection-content');
 assert.equal(guard()?.props?.['aria-expanded'],false);
 assert.equal(detector()?.props?.['aria-expanded'],false);
 assert.equal(find(tree,n=>n.props?.id==='wg-detection-content'),null);
 assert.equal(find(tree,n=>n.props?.className==='wg-remediation-item'),null);
 assert.ok(detector()?.children?.[0]?.children?.some(n=>n?.children?.[0]==='待处理 1'),
  'the collapsed header displays the pending task count');
 guard().props.onClick();tree=h.render();
 assert.equal(guard().props['aria-expanded'],true);
 assert.equal(detector().props['aria-expanded'],false);
 assert.equal(find(tree,n=>n.props?.className==='wg-remediation-item'),null,
  'opening Agent capacity settings must not reveal detection tasks');
 detector().props.onClick();tree=h.render();
 assert.equal(detector().props['aria-expanded'],true);
 assert.equal(guard().props['aria-expanded'],true);
 assert.ok(find(tree,n=>n.props?.id==='wg-detection-content'));
 assert.ok(find(tree,n=>n.props?.className==='wg-remediation-item'));
 assert.equal(button(tree,'复制精简任务'),null);
 assert.equal(button(tree,'标记已查看'),null);
 assert.ok(find(tree,n=>n.props?.className==='wg-remediation-delivery'&&n.children[0]==='等待自动投递'));
 assert.equal(h.status.remediation.total,1,'display state never clears capacity warnings');
 h.status.remediation.tasks[0].deliveredTo={lead:h.status.remediation.tasks[0].fingerprint};
 tree=h.render();
 assert.ok(find(tree,n=>n.props?.className==='wg-remediation-delivery'&&n.children[0]==='已推送至 1 个对话'));
 detector().props.onClick();tree=h.render();
 assert.equal(detector().props['aria-expanded'],false);
 assert.equal(guard().props['aria-expanded'],true);
 assert.equal(find(tree,n=>n.props?.className==='wg-remediation-item'),null);
 assert.equal(h.calls.length,0,'display-only card must never submit a task');
});
test('log tab renders measured changes, restores guarded file and deletes individual event after confirmation',async()=>{
 const h=await clientHarness('custom');
 h.status.events=[{id:'e1',type:'compressed',path:'docs/notes.md',at:'2026-11-01T08:00:00.000Z',
  detail:'重复段落压缩',beforeChars:1200,afterChars:900,backupHash:'a'.repeat(64),expectedHash:'b'.repeat(64)},
  {id:'e2',type:'blocked',path:'README.md',at:'2026-11-01T09:00:00.000Z',detail:'上限拒绝'}];
 let tree=h.render();
 const tab=find(tree,n=>n.type==='button'&&n.children[0]==='日志');
 assert.ok(tab,'log tab sits beside special category');
 tab.props.onClick();
 tree=h.render();
 const card=find(tree,n=>n.props?.className==='wg-card wg-log-card');
 assert.ok(card,'log tab should render log card, not mind map');
 assert.equal(find(tree,n=>n.props?.className==='wg-map-shell'),null);
 assert.ok(find(card,n=>n.type==='strong'&&n.props?.className==='reduced'&&n.children.join('')==='减少 300 (25.0%)'));
 assert.ok(find(card,n=>n.props?.className==='wg-log-unmeasured'&&n.children[0]==='字符变化：无法比较'));
 assert.ok(button(card,'恢复文档'));
 assert.ok(button(card,'删除日志'));
 await button(card,'恢复文档').props.onClick();
 assert.ok(h.calls.some(x=>x.route==='/restore'&&x.input.confirmed===true&&x.input.path==='docs/notes.md'));
 tree=h.render();
 await button(tree,'删除日志').props.onClick();
 assert.ok(h.calls.some(x=>x.route==='/logs'&&x.input.eventId==='e1'));
 assert.equal(h.status.events.length,1);
 tree=h.render();
 const newCard=find(tree,n=>n.props?.className==='wg-card wg-log-card');
 assert.ok(newCard);
 assert.equal(button(newCard,'恢复文档'),null);
});

test('Custom Skill prompt is collapsed by default; unfolding and restoring its canonical default does not persist until Save',async()=>{
 const h=await clientHarness('custom');
 let tree=openSkillCard(h);
 assert.equal(promptToggle(tree)?.props['aria-expanded'],false);
 assert.equal(promptToggle(tree)?.props['aria-controls'],'wg-skill-prompt-content');
 assert.equal(promptEditor(tree,'custom'),null);
 assert.equal(button(tree,'保存 Skill 与提示词'),null,'collapsed Custom Skill prompt must hide Save UI');
 assert.equal(button(tree,'还原默认提示词'),null,'collapsed Custom Skill prompt must hide Restore UI');
 assert.ok(find(tree,n=>n.type==='textarea'&&n.props?.['aria-label']==='自定义 Skill 规范'),
  'Custom Skill body remains editable when its Agent prompt is collapsed');
 promptToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(promptToggle(tree).props['aria-expanded'],true);
 assert.equal(promptEditor(tree,'custom').props.value,'SAVED CUSTOM PROMPT');
 assert.ok(actionRow(tree,['还原默认提示词','保存 Skill 与提示词']),
  'reset and save must share one row in Custom Skill mode');
 assert.equal(matches(tree,n=>typeof n.type==='function'&&n.children?.[0]==='保存 Skill 与提示词').length,1);
 assert.ok(button(tree,'还原默认提示词'));
 button(tree,'还原默认提示词').props.onClick();
 tree=h.render();
 assert.equal(promptEditor(tree,'custom').props.value,DEFAULT_CUSTOM_PROMPT);
 assert.equal(h.persisted.customPrompt,'SAVED CUSTOM PROMPT');
 assert.equal(h.calls.length,0);
 promptToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(promptToggle(tree).props['aria-expanded'],false);
 assert.equal(button(tree,'保存 Skill 与提示词'),null,'Save disappears when prompt is collapsed again');
 promptToggle(tree).props.onClick();
 tree=h.render();
 assert.ok(actionRow(tree,['还原默认提示词','保存 Skill 与提示词']));
 assert.ok(button(tree,'保存 Skill 与提示词'));
 await button(tree,'保存 Skill 与提示词').props.onClick();
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].input.settings.customPrompt,DEFAULT_CUSTOM_PROMPT);
 assert.equal(h.persisted.embeddedPrompt,'SAVED EMBEDDED PROMPT');
});


test('Embedded Skill prompt is collapsed by default; restore uses canonical default without altering embedded resources',async()=>{
 const h=await clientHarness('embedded');
 let tree=openSkillCard(h);
 assert.equal(promptToggle(tree)?.props['aria-expanded'],false);
 assert.equal(promptEditor(tree,'embedded'),null);
 promptToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(promptEditor(tree,'embedded').props.value,'SAVED EMBEDDED PROMPT');
 assert.ok(actionRow(tree,['还原默认提示词','保存提示词']));
 button(tree,'还原默认提示词').props.onClick();
 tree=h.render();
 assert.equal(promptEditor(tree,'embedded').props.value,DEFAULT_EMBEDDED_PROMPT);
 assert.equal(h.calls.length,0);
 await button(tree,'保存提示词').props.onClick();
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].input.settings.embeddedPrompt,DEFAULT_EMBEDDED_PROMPT);
 assert.equal(h.persisted.customPrompt,'SAVED CUSTOM PROMPT');
});

test('Custom cancel prompt is directly below advisory, independently collapsible, resettable and saved alone',async()=>{
 const h=await clientHarness('custom');
 let tree=openSkillCard(h);
 assert.equal(cancelToggle(tree)?.props['aria-expanded'],false);
 assert.equal(cancelEditor(tree,'custom'),null);
 const toggles=matches(tree,n=>n.props?.className==='wg-prompt-toggle');
 assert.deepEqual(toggles.map(n=>n.children[0]),['完整 Agent 精简提示词','完整 Agent 取消提示词']);
 cancelToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(cancelEditor(tree,'custom').props.value,'SAVED CUSTOM CANCEL {{items}}');
 assert.equal(promptEditor(tree,'custom'),null);
 assert.ok(button(tree,'保存取消提示词'));
 button(tree,'还原默认取消提示词').props.onClick();
 tree=h.render();
 assert.equal(cancelEditor(tree,'custom').props.value,DEFAULT_CUSTOM_CANCEL_PROMPT);
 assert.equal(h.persisted.customCancelPrompt,'SAVED CUSTOM CANCEL {{items}}');
 await button(tree,'保存取消提示词').props.onClick();
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].input.settings.customCancelPrompt,DEFAULT_CUSTOM_CANCEL_PROMPT);
 assert.equal(h.calls[0].input.settings.customPrompt,'SAVED CUSTOM PROMPT');
 assert.equal(h.calls[0].input.settings.embeddedCancelPrompt,'SAVED EMBEDDED CANCEL {{items}}');
 assert.equal(h.persisted.customPrompt,'SAVED CUSTOM PROMPT');
});

test('saving the advisory does not save an unsaved cancellation draft',async()=>{
 const h=await clientHarness('custom');
 let tree=openSkillCard(h);
 cancelToggle(tree).props.onClick();
 tree=h.render();
 cancelEditor(tree,'custom').props.onChange({target:{value:'DRAFT CANCEL {{items}}'}});
 promptToggle(tree).props.onClick();
 tree=h.render();
 await button(tree,'保存 Skill 与提示词').props.onClick();
 assert.equal(h.persisted.customCancelPrompt,'SAVED CUSTOM CANCEL {{items}}');
 assert.equal(h.calls[0].input.settings.customCancelPrompt,'SAVED CUSTOM CANCEL {{items}}');
 tree=h.render();
 assert.equal(cancelEditor(tree,'custom').props.value,'DRAFT CANCEL {{items}}');
 await button(tree,'保存取消提示词').props.onClick();
 assert.equal(h.persisted.customCancelPrompt,'DRAFT CANCEL {{items}}');
 assert.equal(h.persisted.customPrompt,'SAVED CUSTOM PROMPT');
});

test('Embedded cancel prompt is separately editable and the Skill mode switch discards unsaved cancellation changes',async()=>{
 const h=await clientHarness('embedded');
 let tree=openSkillCard(h);
 cancelToggle(tree).props.onClick();
 tree=h.render();
 const editor=cancelEditor(tree,'embedded');
 assert.equal(editor.props.value,'SAVED EMBEDDED CANCEL {{items}}');
 editor.props.onChange({target:{value:'WORKSPACE_GOVERNANCE: CANCEL\\n{{items}}\\nNew edit'}});
 tree=h.render();
 assert.ok(cancelEditor(tree,'embedded').props.value.includes('New edit'));
 const customOption=find(tree,n=>n.type==='input'&&n.props?.name==='wg-skill-mode'&&n.props?.value==='custom');
 customOption.props.onChange();
 assert.equal(h.store.get(25),false);
 for(let i=0;i<20;i++)await Promise.resolve();
 tree=h.render();
 assert.equal(h.calls[0].input.settings.embeddedCancelPrompt,'SAVED EMBEDDED CANCEL {{items}}');
 assert.equal(h.store.get(27),'SAVED EMBEDDED CANCEL {{items}}');
 assert.equal(cancelToggle(tree).props['aria-expanded'],false);
 const embeddedOption=find(tree,n=>n.type==='input'&&n.props?.name==='wg-skill-mode'&&n.props?.value==='embedded');
 embeddedOption.props.onChange();
 for(let i=0;i<20;i++)await Promise.resolve();
 tree=h.render();
 cancelToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(cancelEditor(tree,'embedded').props.value,'SAVED EMBEDDED CANCEL {{items}}');
 button(tree,'还原默认取消提示词').props.onClick();
 tree=h.render();
 assert.equal(cancelEditor(tree,'embedded').props.value,DEFAULT_EMBEDDED_CANCEL_PROMPT);
 await button(tree,'保存取消提示词').props.onClick();
 assert.equal(h.persisted.embeddedCancelPrompt,DEFAULT_EMBEDDED_CANCEL_PROMPT);
 assert.equal(h.persisted.embeddedPrompt,'SAVED EMBEDDED PROMPT');
});

test('legacy backend never renders a blank cancellation prompt or silently rejects ordinary Skill changes',async()=>{
 const h=await clientHarness('embedded',{legacy:true});
 let tree=openSkillCard(h);
 await h.syncMaintenance();
 tree=h.render();
 cancelToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(cancelEditor(tree,'embedded').props.value,DEFAULT_EMBEDDED_CANCEL_PROMPT);
 assert.equal(cancelEditor(tree,'embedded').props.disabled,true);
 assert.equal(button(tree,'还原默认取消提示词').props.disabled,true);
 assert.equal(button(tree,'保存取消提示词').props.disabled,true);
 assert.ok(find(tree,node=>node.type==='p'&&String(node.children[0]).includes('重新加载插件')));
 const customOption=find(tree,node=>node.type==='input'&&node.props?.name==='wg-skill-mode'&&node.props?.value==='custom');
 customOption.props.onChange();
 for(let i=0;i<25;i++)await Promise.resolve();
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].input.settings.mode,'custom');
 assert.equal(Object.hasOwn(h.calls[0].input.settings,'customCancelPrompt'),false);
 assert.equal(Object.hasOwn(h.calls[0].input.settings,'embeddedCancelPrompt'),false);
 tree=h.render();
 cancelToggle(tree).props.onClick();
 tree=h.render();
 assert.equal(cancelEditor(tree,'custom').props.value,DEFAULT_CUSTOM_CANCEL_PROMPT);
});

test('upgraded runtime fills cancellation template without changing user advisory content',async()=>{
 const h=await clientHarness('custom',{legacy:true});
 openSkillCard(h);
 await h.syncMaintenance();
 assert.equal(h.store.get(26),DEFAULT_CUSTOM_CANCEL_PROMPT);
 h.status.skillSettings.customCancelPrompt='SERVER CUSTOM CANCEL {{items}}';
 h.status.skillSettings.embeddedCancelPrompt='SERVER EMBEDDED CANCEL {{items}}';
 h.status.skillPromptDefaults.customCancelPrompt=DEFAULT_CUSTOM_CANCEL_PROMPT;
 h.status.skillPromptDefaults.embeddedCancelPrompt=DEFAULT_EMBEDDED_CANCEL_PROMPT;
 await h.syncMaintenance();
 assert.equal(h.store.get(26),'SERVER CUSTOM CANCEL {{items}}');
 assert.equal(h.store.get(27),'SERVER EMBEDDED CANCEL {{items}}');
 assert.equal(h.store.get(22),'SAVED CUSTOM PROMPT');
 const tree=h.render();
 cancelToggle(tree).props.onClick();
 const shown=h.render();
 assert.equal(cancelEditor(shown,'custom').props.disabled,false);
 assert.equal(cancelEditor(shown,'custom').props.value,'SERVER CUSTOM CANCEL {{items}}');
});

test('expanded editors have one heading only, no unrelated persistent parameter list, and bounded height',async()=>{
 for(const mode of ['custom','embedded']){
  const h=await clientHarness(mode);
  let tree=openSkillCard(h);
  promptToggle(tree).props.onClick();
  cancelToggle(tree).props.onClick();
  tree=h.render();
  const card=find(tree,n=>n.props?.id==='wg-skill-content');
  const headings=matches(card,n=>n.type==='button'&&n.props?.className==='wg-prompt-toggle');
  assert.deepEqual(headings.map(n=>n.children[0]),['完整 Agent 精简提示词','完整 Agent 取消提示词']);
  assert.equal(matches(card,n=>n.type==='label'&&n.props?.className==='wg-prompt-label').length,0);
  assert.equal(promptEditor(tree,mode).props.rows,6);
  assert.equal(cancelEditor(tree,mode).props.rows,6);
  assert.equal(matches(card,n=>n.type==='p'&&String(n.children[0]).includes('支持 {{file}}')).length,0);
  assert.equal(matches(card,n=>n.type==='p'&&String(n.children[0]).includes('必需变量：{{items}}')).length,1);
 }
});

test('Switching from an expanded Custom prompt to Embedded collapses the editor and does not silently persist unsaved reset',async()=>{
 const h=await clientHarness('custom');
 let tree=openSkillCard(h);
 promptToggle(tree).props.onClick();
 tree=h.render();
 button(tree,'还原默认提示词').props.onClick();
 assert.equal(h.store.get(22),DEFAULT_CUSTOM_PROMPT);
 tree=h.render();
 const embeddedOption=find(tree,n=>n.type==='input'&&n.props?.name==='wg-skill-mode'&&n.props?.value==='embedded');
 assert.ok(embeddedOption);
 embeddedOption.props.onChange();
 assert.equal(h.store.get(19),false,'mode switch immediately collapses both prompt editors');
 for(let i=0;i<12&&!h.calls.length;i++)await Promise.resolve();
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].input.settings.mode,'embedded');
 assert.equal(h.calls[0].input.settings.customPrompt,'SAVED CUSTOM PROMPT','unsaved reset must not be silently saved');
 for(let i=0;i<16;i++)await Promise.resolve();
 tree=h.render();
 assert.equal(h.store.get(20),'embedded');
 assert.equal(h.store.get(19),false);
 assert.equal(promptEditor(tree,'embedded'),null);
 assert.equal(h.store.get(22),'SAVED CUSTOM PROMPT','unsaved reset is discarded on mode switch');
 const customOption=find(tree,n=>n.type==='input'&&n.props?.name==='wg-skill-mode'&&n.props?.value==='custom');
 customOption.props.onChange();
 assert.equal(h.store.get(19),false);
 for(let i=0;i<16;i++)await Promise.resolve();
 tree=h.render();
 assert.equal(h.store.get(20),'custom');
 assert.equal(promptToggle(tree).props['aria-expanded'],false);
 assert.equal(promptEditor(tree,'custom'),null);
});
