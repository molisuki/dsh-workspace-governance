import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

async function client(options={}){
 const code=await fs.readFile(fileURLToPath(new URL('../lib/client.js',import.meta.url)),'utf8');
 let module,state,viewState;const effects=[];const listeners=new Map();
 const document={fullscreenElement:null,
  addEventListener(name,fn){listeners.set(name,fn)},
  removeEventListener(name,fn){if(listeners.get(name)===fn)listeners.delete(name)},
  dispatch(name,event){listeners.get(name)?.(event)},
  async exitFullscreen(){this.fullscreenElement=null;this.dispatch('fullscreenchange');}};
 const React={
  createElement:(type,props,...children)=>({type,props:props||{},children}),
  useState:value=>{
   const cell={value:typeof value==='function'?value():value};
   state=cell.value;
   return [cell.value,update=>{
    cell.value=typeof update==='function'?update(cell.value):update;
    state=cell.value;
    if(cell.value&&typeof cell.value==='object'&&'scale'in cell.value&&'x'in cell.value) viewState=cell.value;
   }];
  },
  useRef:value=>({current:value}),
  useMemo:fn=>fn(),
  useEffect:fn=>{effects.push(fn);},
  useLayoutEffect:fn=>{effects.push(fn);},
  useCallback:fn=>fn
 };
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load(m){module=m;}},devicePixelRatio:options.devicePixelRatio},console,document,
  ResizeObserver:options.ResizeObserver});
 return {plugin:module.factory(()=>React),state:()=>state,viewState:()=>viewState,document,
  runEffect:()=>{const cleanups=effects.map(fn=>fn());return()=>cleanups.forEach(clean=>clean?.());}};
}
const item=(path,type,chars,limit,status,children=[])=>({
 path,name:path.split('/').pop()||'Workspace',type,chars,limit,status,children,
 files:type==='file'?1:children.reduce((v,x)=>v+x.files,0),
 issues:status==='overflow'?1:0
});
const root=item('','folder',6200,null,'unlimited',[
 item('docs','folder',2100,null,'unlimited',[
  item('docs/guide.md','file',870,1000,'warning'),
  item('docs/reference.md','file',1230,2400,'ok')
 ]),
 item('README.md','file',580,1000,'ok'),
 item('AGENTS.md','file',1120,1000,'overflow')
]);
const scan={truncated:false,issues:[{type:'overflow',path:'AGENTS.md'}]};
const choices={warningRatio:.8,scan,expanded:{'':true}};
const visit=(value,fn)=>{if(!value||typeof value!=='object')return null;if(fn(value))return value;
 for(const child of value.children||[]){const hit=visit(child,fn);if(hit)return hit;}
 return null;};

test('topology uses real parent-child paths, stable geometry and collapsed branches without losing result count',async()=>{
 const {plugin}=await client();
 const collapsed=plugin.mindMapTopology(root,choices);
 assert.equal(collapsed.matches,4,'collapsed folders still contain Markdown files');
 assert.deepEqual(Array.from(collapsed.nodes.map(x=>x.path)),['','docs','README.md','AGENTS.md']);
 assert.equal(collapsed.links.length,3);
 assert.equal(collapsed.nodes.find(x=>x.path==='docs').open,false);
 const full=plugin.mindMapTopology(root,{...choices,expanded:{'':true,docs:true}});
 assert.equal(full.nodes.length,6);
 assert.equal(full.links.length,5);
 assert.equal(full.matches,4);
 const docs=full.nodes.find(x=>x.path==='docs'),guide=full.nodes.find(x=>x.path==='docs/guide.md');
 assert.ok(guide.x>docs.x);
 assert.ok(guide.y>=0&&guide.y<full.height);
 assert.match(full.links.find(x=>x.to==='docs/guide.md').d,/^M \d+ \d+ C /);
 assert.ok(full.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));
 const shut=plugin.mindMapTopology(root,{...choices,expanded:{'':false,docs:false}});
 assert.deepEqual(Array.from(shut.nodes.map(x=>x.path)),['','docs','README.md','AGENTS.md']);
 assert.equal(shut.nodes[0].open,true,'workspace root cannot collapse');
 assert.equal(shut.nodes.find(n=>n.path==='docs').open,false);
 assert.equal(shut.matches,4);
 const filtered=plugin.mindMapTopology(root,{...choices,tab:'warning',expanded:{'':false,docs:false}});
 assert.equal(filtered.nodes[0].open,true);
 assert.equal(filtered.nodes.some(n=>n.path==='docs/guide.md'),false,'explicit folder collapse prevails over filter auto-expansion');
});

async function interactiveMap(tree,options){
 const code=await fs.readFile(new URL('../lib/client.js',import.meta.url),'utf8');
 let module,slot=0,changed=false,layoutEffects=[];
 const hooks=[];
 const React={
  createElement:(type,props,...children)=>({type,props:props??{},children}),
  useState:initial=>{
   const at=slot++;
   if(!hooks[at])hooks[at]={value:typeof initial==='function'?initial():initial};
   return [hooks[at].value,next=>{
    const value=typeof next==='function'?next(hooks[at].value):next;
    if(value!==hooks[at].value){hooks[at].value=value;changed=true;}
   }];
  },
  useRef:initial=>{const at=slot++;return hooks[at]??(hooks[at]={current:initial});},
  useLayoutEffect:fn=>{slot++;layoutEffects.push(fn);},
  useEffect:()=>{slot++;},
  useMemo:fn=>{slot++;return fn();},
  useCallback:fn=>{slot++;return fn;}
 };
 vm.runInNewContext(code,{window:{devicePixelRatio:1,__ModuleLoader__:{load(value){module=value;}}},console});
 const plugin=module.factory(()=>React);
 let expanded={'':true},selected='',rendered,layout;
 const render=()=>{
  layout=plugin.mindMapTopology(tree,{...options,expanded});
  for(let attempt=0;attempt<5;attempt++){
   slot=0;changed=false;layoutEffects=[];
   rendered=plugin.MindMap({layout,selected,
    onSelect:path=>{selected=path;},
    onToggle:(path,open)=>{expanded={...expanded,[path]:!open};},
    onExpandAll:()=>{expanded=plugin.directoryExpansionMap(tree,true);},
    onCollapseAll:()=>{expanded=plugin.directoryExpansionMap(tree,false);}
   });
   for(const effect of layoutEffects)effect();
   if(!changed)break;
   assert.ok(attempt<4,'anchor must settle without repeated state updates');
  }
  return rendered;
 };
 const view=()=>hooks.find(h=>h?.value&&typeof h.value==='object'&&'scale'in h.value)?.value;
 const at=path=>{
  const node=layout.nodes.find(n=>n.path===path);
  assert.ok(node,'expected layout node '+path);
  const v=view();
  return {x:(node.x+node.width/2)*v.scale+v.x,y:(node.y+node.height/2)*v.scale+v.y};
 };
 const click=path=>{
  const node=visit(rendered,n=>n.type==='button'&&n.props?.title===path&&
   String(n.props.className).includes('wg-map-node'));
  assert.ok(node,'expected clickable node '+path);
  node.props.onClick();
  return render();
 };
 render();
 return {plugin,render,click,at,view,layout:()=>layout,hooks,tree,expanded:()=>expanded};
}

test('directory anchors retain exact screen coordinates across repeated folds in every mind-map view',async()=>{
 const nested=item('','folder',1000,null,'unlimited',[
  item('docs','folder',750,null,'unlimited',[
   item('docs/chapters','folder',500,null,'unlimited',[
    item('docs/chapters/first.md','file',125,150,'warning'),
    item('docs/chapters/second.md','file',250,100,'overflow'),
    item('docs/chapters/third.md','file',125,100,'overflow')
   ]),
   item('docs/third.md','file',250,150,'warning')
  ]),
  item('other.md','file',250,100,'overflow')
 ]);
 const policy={directories:{docs:{fileLimit:110}},files:{
   'docs/chapters/first.md':{fileLimit:100},
   'docs/chapters/second.md':{fileLimit:100},
   'docs/third.md':{fileLimit:150}}};
 for(const tab of ['tree','warning','overflow','overrides']){
  const map=await interactiveMap(nested,{...choices,tab,policy});
  const baseView=map.view();
  const before=map.at('docs');
  map.click('docs');
  const expanded=map.at('docs');
  assert.ok(Math.abs(expanded.x-before.x)<1e-8&&Math.abs(expanded.y-before.y)<1e-8,
   tab+' folder must stay fixed when expanded');
  assert.equal(map.view().scale,baseView.scale);
  const chapterBefore=map.at('docs/chapters');
  map.click('docs/chapters');
  const chapterAfter=map.at('docs/chapters');
  assert.ok(Math.abs(chapterAfter.x-chapterBefore.x)<1e-8&&Math.abs(chapterAfter.y-chapterBefore.y)<1e-8,
   tab+' nested folder must stay fixed');
  const beforeClose=map.at('docs/chapters');
  map.click('docs/chapters');
  assert.ok(Math.abs(map.at('docs/chapters').y-beforeClose.y)<1e-8,
   tab+' nested collapse must preserve anchor');
  const beforeDocsClose=map.at('docs');
  map.click('docs');
  assert.ok(Math.abs(map.at('docs').y-beforeDocsClose.y)<1e-8,
   tab+' parent collapse must preserve anchor');
 }
});

test('folder expansion preserves existing zoom and pan without recentering while protecting controls',async()=>{
 const map=await interactiveMap(root,choices);
 // Simulate a manually navigated viewport with non-integer scale and translation.
 const viewHook=map.hooks.find(h=>h?.value&&typeof h.value==='object'&&'scale'in h.value);
 viewHook.value={x:-141.75,y:77.25,scale:1.625};
 map.render();
 const oldView=map.view(),before=map.at('docs');
 map.click('docs');
 const after=map.at('docs'),next=map.view();
 assert.ok(Math.abs(after.x-before.x)<1e-9&&Math.abs(after.y-before.y)<1e-9);
 assert.equal(next.scale,oldView.scale);
 assert.equal(next.x,oldView.x,'equal node depth must preserve horizontal pan');
 assert.equal(map.layout().nodes.find(n=>n.path==='docs').open,true);
 const beforeFold=map.at('docs');
 map.click('docs');
 assert.ok(Math.abs(map.at('docs').y-beforeFold.y)<1e-9);
 const missing=map.plugin.mindMapAnchorView(oldView,{x:10,y:20},null);
 assert.equal(missing,oldView,'removed nodes must not manufacture an offset');
});

test('every category starts with collapsed child folders and identical repository root screen anchor',async()=>{
 const {plugin}=await client();
 const categories=['tree','warning','overflow','overrides'];
 const rule={directories:{docs:{fileLimit:2200}},files:{'docs/guide.md':{fileLimit:1000}}};
 const reference=plugin.mindMapTopology(root,{...choices,tab:'tree',expanded:{'':true}});
 const baselineView=plugin.mindMapRootView(reference,640,440,reference.width);
 for(const tab of categories){
  const layout=plugin.mindMapTopology(root,{...choices,tab,policy:rule,expanded:{'':true}});
  const r=layout.nodes.find(n=>n.path==='');
  assert.ok(r,'root must exist in '+tab);
  assert.equal(r.open,true);
  assert.ok(layout.nodes.filter(n=>n.node.type==='folder'&&n.path!=='').every(n=>!n.open),
   'all nested folders must initially be collapsed in '+tab);
  const view=plugin.mindMapRootView(layout,640,440,reference.width);
  assert.equal(view.scale,1);
  assert.equal(view.x,baselineView.x,'all categories use Directory as their horizontal baseline');
  assert.equal(r.x*view.scale+view.x,reference.nodes[0].x+baselineView.x);
  assert.equal((r.y+r.height/2)*view.scale+view.y,220);
  assert.equal(view.x,Math.max(8-r.x,Math.min(28-r.x,(640-reference.width)/2-112)),
   'Directory baseline uses a compact left anchor while retaining the root');
 }
 const filtered=plugin.mindMapTopology(root,{...choices,tab:'warning',expanded:{'':true}});
 assert.equal(filtered.nodes.some(n=>n.path==='docs/guide.md'),false);
 assert.ok(filtered.matches>0,'hidden matches are still counted');
 const resized=plugin.mindMapRootView(reference,980,520,reference.width);
 assert.equal(reference.nodes[0].x+resized.x,
  Math.max(8,Math.min(28,reference.nodes[0].x+(980-reference.width)/2-112)));
 assert.equal(reference.nodes[0].y+reference.nodes[0].height/2+resized.y,260);
 assert.ok(reference.nodes[0].x+resized.x<=28,'root stays near the left edge in a spacious viewport');
 const narrow=plugin.mindMapRootView(reference,280,360,reference.width);
 assert.equal(reference.nodes[0].x+narrow.x,8,'root remains fully visible on narrow viewports');
});
test('actual container measurement centers Directory, resize recalculates only before interaction, reset restores center',async()=>{
 let resize,disconnected=false,wheel;
 class FakeResizeObserver{
  constructor(handler){resize=handler;}
  observe(){}
  disconnect(){disconnected=true;}
 }
 const {plugin,viewState,runEffect}=await client({ResizeObserver:FakeResizeObserver});
 const layout=plugin.mindMapTopology(root,choices);
 const rendered=plugin.MindMap({layout,selected:'',referenceWidth:layout.width,
  onSelect:()=>{},onToggle:()=>{},onExpandAll:()=>{},onCollapseAll:()=>{}});
 const map=visit(rendered,v=>v.props?.className==='wg-map-viewport');
 const bounds={width:900,height:520};
 map.props.ref.current={
  get clientWidth(){return bounds.width;},get clientHeight(){return bounds.height;},
  getBoundingClientRect(){return {left:0,top:0,...bounds};},
  addEventListener(name,fn){if(name==='wheel')wheel=fn;},removeEventListener(){}
 };
 const cleanup=runEffect();
 assert.deepEqual(JSON.parse(JSON.stringify(viewState())),JSON.parse(JSON.stringify(plugin.mindMapRootView(layout,900,520,layout.width))));
 const initial=viewState();
 bounds.width=1000;bounds.height=600;resize();
 const resized=plugin.mindMapRootView(layout,1000,600,layout.width);
 assert.deepEqual(JSON.parse(JSON.stringify(viewState())),JSON.parse(JSON.stringify(resized)));
 assert.equal(initial.x,resized.x,'root remains at the same left anchor when the card becomes wider');
 assert.notEqual(initial.y,resized.y,'the vertical center follows the resized viewport');
 wheel({currentTarget:map.props.ref.current,clientX:340,clientY:250,deltaY:-200,preventDefault(){}});
 const zoomed=viewState();
 bounds.width=1200;bounds.height=700;resize();
 assert.equal(viewState(),zoomed,'resize must not move a manually navigated mind map');
 const reset=visit(rendered,v=>v.props?.['aria-label']==='还原导图');
 reset.props.onClick();
 assert.deepEqual(JSON.parse(JSON.stringify(viewState())),JSON.parse(JSON.stringify(plugin.mindMapRootView(layout,1200,700,layout.width))));
 cleanup();
 assert.equal(disconnected,true);
});
test('high-density stage aligns CSS translations to physical pixels without scaling text',async()=>{
 const {plugin}=await client({devicePixelRatio:2});
 const layout=plugin.mindMapTopology(root,choices);
 const rendered=plugin.MindMap({layout,selected:'',referenceWidth:365.5,
  onSelect:()=>{},onToggle:()=>{},onExpandAll:()=>{},onCollapseAll:()=>{}});
 const stage=visit(rendered,n=>n.props?.className==='wg-map-stage');
 assert.ok(stage);
 const view=plugin.mindMapRootView(layout,640,440,365.5);
 const sharpX=Math.round(view.x*2)/2;
 const sharpY=Math.round(view.y*2)/2;
 assert.equal(stage.props.style.transform,
  'translate('+sharpX+'px,'+sharpY+'px) scale(1)');
 assert.equal(layout.nodes[0].height,36,'high-density positioning must not shrink node text');
});
test('global expand and collapse cover every directory while preserving the repository root',async()=>{
 const {plugin}=await client();
 const opened=plugin.directoryExpansionMap(root,true);
 assert.equal(opened[''],true);
 assert.equal(opened.docs,true);
 const full=plugin.mindMapTopology(root,{...choices,expanded:opened});
 assert.equal(full.nodes.length,6);
 const closed=plugin.directoryExpansionMap(root,false);
 assert.equal(closed[''],true);
 assert.equal(closed.docs,false);
 const folded=plugin.mindMapTopology(root,{...choices,expanded:closed});
 assert.equal(folded.nodes.length,4);
 assert.equal(folded.matches,4);
});

test('dense multi-branch layout fits substantially more directories while preserving node separation',async()=>{
 const {plugin}=await client();
 const folders=Array.from({length:48},(_,i)=>{
  const dir='unit-'+String(i).padStart(2,'0');
  return item(dir,'folder',280,null,'unlimited',[item(dir+'/index.md','file',280,1000,'ok')]);
 });
 const tree=item('','folder',48*280,null,'unlimited',folders);
 const layout=plugin.mindMapTopology(tree,{...choices,expanded:plugin.directoryExpansionMap(tree,true)});
 assert.equal(layout.nodes.length,97);
 assert.equal(layout.nodes[0].height,36);
 assert.equal(layout.nodes.find(n=>n.path==='unit-01').width,158);
 assert.equal(layout.nodes.find(n=>n.path==='unit-01/index.md').width,198);
 const leaves=layout.nodes.filter(n=>n.node.type==='file').sort((a,b)=>a.y-b.y);
 assert.equal(leaves[1].y-leaves[0].y,48);
 assert.equal(layout.height,48*48+32);
 assert.equal(layout.links.length,96);
 const frame=plugin.mindMapFrame(layout,640,460);
 assert.ok(frame.scale>=.55);
 assert.ok(frame.scale<1,'large graph should start at readable overview scale');
 const visible=plugin.mindMapVisibleNodes(layout,frame,640,460);
 assert.ok(visible.length>=25,'dense layout should expose at least 25 nodes in a 640x460 viewport');
 assert.ok(visible.length<layout.nodes.length,'viewport pruning must avoid rendering every offscreen node');
 assert.ok(visible.some(n=>n.path===''),'root remains discoverable in overview');
 const focus=plugin.mindMapFrame(layout,640,460,'unit-08/index.md');
 const focusNode=layout.nodes.find(n=>n.path==='unit-08/index.md');
 const x=(focusNode.x+focusNode.width/2)*focus.scale+focus.x;
 const y=(focusNode.y+focusNode.height/2)*focus.scale+focus.y;
 assert.ok(Math.abs(x-320)<.0001);
 assert.ok(Math.abs(y-230)<.0001);
 assert.ok(plugin.mindMapVisibleNodes(layout,focus,640,460).some(n=>n.path===focusNode.path));
 for(const node of visible.filter(n=>n.path!==''))
  assert.ok(layout.linkByChild[node.path],node.path+' should retain its parent connector');
});
test('expand-all framing is one-shot and never overrides subsequent wheel pan interactions',async()=>{
 const {plugin,state,runEffect}=await client();
 const directories=Array.from({length:30},(_,i)=>item('d'+i,'folder',80,null,'unlimited',[
  item('d'+i+'/index.md','file',80,2400,'ok')
 ]));
 const tree=item('','folder',2400,null,'unlimited',directories);
 const layout=plugin.mindMapTopology(tree,{...choices,expanded:plugin.directoryExpansionMap(tree,true)});
 const rendered=plugin.MindMap({layout,selected:'d14/index.md',frameRequest:1,
  onSelect:()=>{},onToggle:()=>{},onExpandAll:()=>{},onCollapseAll:()=>{}});
 const map=visit(rendered,v=>v.props?.className==='wg-map-viewport');
 let wheel;
 map.props.ref.current={clientWidth:640,clientHeight:460,
  getBoundingClientRect:()=>({left:0,top:0,width:640,height:460}),
  addEventListener(name,handler){if(name==='wheel')wheel=handler;},
  removeEventListener(){}};
 const cleanup=runEffect();
 const expected=plugin.mindMapFrame(layout,640,460,'d14/index.md');
 assert.equal(state().scale,expected.scale);
 assert.equal(state().x,expected.x);
 assert.equal(state().y,expected.y);
 wheel({currentTarget:map.props.ref.current,clientX:280,clientY:190,deltaY:-70,preventDefault(){}});
 assert.ok(state().scale>expected.scale,'manual zoom still operates after auto framing');
 cleanup();
});
test('warning, overflow and explicit limit views retain ancestry and status boundaries',async()=>{
 const {plugin}=await client();
 const warn=plugin.mindMapTopology(root,{...choices,tab:'warning',expanded:{docs:true}});
 assert.ok(warn.nodes.some(n=>n.path==='docs/guide.md'));
 assert.ok(warn.nodes.some(n=>n.path==='docs'));
 assert.equal(warn.nodes.some(n=>n.path==='README.md'),false);
 const problem=plugin.mindMapTopology(root,{...choices,tab:'overflow'});
 assert.ok(problem.nodes.some(n=>n.path==='AGENTS.md'));
 assert.equal(problem.nodes.find(n=>n.path==='').relevant,false,
  'root is not a failing item when only descendants are over budget');
 assert.equal(problem.nodes.find(n=>n.path==='').state.kind,'neutral');
 assert.equal(problem.nodes.some(n=>n.path==='README.md'),false);
 const policy={directories:{docs:{fileLimit:1800}},files:{'README.md':{fileLimit:1300},'AGENTS.md':{exempt:true}}};
 const overrides=plugin.mindMapTopology(root,{...choices,tab:'overrides',policy});
 assert.equal(overrides.matches,2,'only explicit directory and file overrides count');
 assert.ok(overrides.nodes.some(n=>n.path==='docs'));
 assert.ok(overrides.nodes.some(n=>n.path==='README.md'));
 assert.equal(overrides.nodes.some(n=>n.path==='AGENTS.md'),false,'protected filename and exemption do not count');
 assert.equal(overrides.nodes.some(n=>n.path==='docs/guide.md'),false,'inherited directory limit is not a file override');
 assert.equal(overrides.nodes.find(n=>n.path==='docs').relevant,true);
 assert.equal(overrides.nodes.find(n=>n.path==='').relevant,false,'root is ancestry, not an explicit override');
 const full=plugin.mindMapTopology(root,{...choices,expanded:{'':true,docs:true}});
 assert.ok(Math.abs(full.nodes.find(n=>n.path==='README.md').percentage-58)<1e-9);
 assert.equal(full.nodes.find(n=>n.path==='docs/guide.md').state.kind,'warning');
 assert.equal(full.nodes.find(n=>n.path==='AGENTS.md').state.kind,'overlimit');
 assert.ok(Math.abs(full.nodes.find(n=>n.path==='AGENTS.md').percentage-112)<1e-9);
});

test('limit override filter excludes aggregate-only and inherited limits but preserves all configured nested Markdown ancestors',async()=>{
 const {plugin}=await client();
 const deep=item('','folder',1600,null,'unlimited',[
  item('docs','folder',1000,null,'unlimited',[
   item('docs/notes','folder',500,null,'unlimited',[
    item('docs/notes/entry.md','file',500,2400,'ok')
   ]),
   item('docs/README.md','file',500,2400,'ok')
  ]),
  item('AGENTS.md','file',600,2400,'ok')
 ]);
 const options={...choices,tab:'overrides'};
 const noOverrides=plugin.mindMapTopology(deep,{...options,policy:{directories:{docs:{aggregateLimit:2500}},files:{'AGENTS.md':{exempt:true}}}});
 assert.equal(noOverrides.matches,0,'aggregate-only, exemption and standard governance names cannot classify');
 assert.equal(noOverrides.nodes.length,1,'root remains the only navigation anchor when no overrides exist');
 const fileOnly=plugin.mindMapTopology(deep,{...options,expanded:{docs:true,'docs/notes':true},policy:{directories:{docs:{aggregateLimit:2500}},files:{'docs/notes/entry.md':{fileLimit:1900}}}});
 assert.equal(fileOnly.matches,1);
 assert.deepEqual(Array.from(fileOnly.nodes.map(n=>n.path)),['','docs','docs/notes','docs/notes/entry.md']);
 assert.equal(fileOnly.nodes.find(n=>n.path==='docs').relevant,false);
 assert.equal(fileOnly.nodes.find(n=>n.path==='docs/notes').relevant,false);
 assert.equal(fileOnly.nodes.find(n=>n.path==='docs/notes/entry.md').relevant,true);
 const folderOnly=plugin.mindMapTopology(deep,{...options,policy:{directories:{docs:{fileLimit:1900}},files:{'AGENTS.md':{mode:'strict'}}}});
 assert.equal(folderOnly.matches,1);
 assert.deepEqual(Array.from(folderOnly.nodes.map(n=>n.path)),['','docs']);
 const both=plugin.mindMapTopology(deep,{...options,expanded:{docs:true,'docs/notes':true},policy:{directories:{docs:{fileLimit:1900}},files:{'docs/notes/entry.md':{fileLimit:1600}}}});
 assert.equal(both.matches,2);
 assert.ok(both.nodes.some(n=>n.path==='docs/notes/entry.md'));
 const collapsed=plugin.mindMapTopology(deep,{...options,expanded:{docs:false},policy:{directories:{docs:{fileLimit:1900}},files:{'docs/notes/entry.md':{fileLimit:1600}}}});
 assert.equal(collapsed.matches,2,'counts still include explicitly overridden descendants in folded branches');
 assert.equal(collapsed.nodes.some(n=>n.path==='docs/notes/entry.md'),false);
});
test('actual DOM MindMap has filename-overlaid health fill, zoom anchored to pointer, pan, click and independent folder toggle',async()=>{
 const {plugin,state,runEffect}=await client();
 const layout=plugin.mindMapTopology(root,{...choices,expanded:{'':true,docs:true}});
 let clicked=null,toggled=null,wasOpen=null,expandedAll=0,collapsedAll=0;
 const rendered=plugin.MindMap({layout,selected:'README.md',onSelect:path=>clicked=path,
  onToggle:(path,open)=>{toggled=path;wasOpen=open;},
  onExpandAll:()=>expandedAll++,onCollapseAll:()=>collapsedAll++});
 const map=visit(rendered,v=>v.props?.className==='wg-map-viewport');
 assert.ok(map);
 let wheelListener,wheelOptions,removed=false;
 map.props.ref.current={clientWidth:640,clientHeight:480,getBoundingClientRect:()=>({left:100,top:30,width:640,height:480}),
   addEventListener(name,fn,options){assert.equal(name,'wheel');wheelListener=fn;wheelOptions=options;},
   removeEventListener(name,fn){removed=name==='wheel'&&fn===wheelListener;}};
 const cleanWheel=runEffect();
 assert.equal(wheelOptions.passive,false);
 const file=visit(rendered,v=>String(v.props?.className||'').includes('wg-map-node wg-map-file')&&v.props['aria-label']?.includes('README.md'));
 assert.ok(file);
 assert.ok(String(file.props.className).includes('selected'));
 assert.equal(file.children[0].props.className.includes('wg-map-file-fill'),true);
 assert.equal(file.children[0].props.style.width,'58%');
 assert.equal(file.children[1].children[0],'README.md');
 file.props.onClick();
 assert.equal(clicked,'README.md');
 const tooFull=visit(rendered,v=>String(v.props?.className||'').includes('wg-map-node wg-map-file')&&v.props['aria-label']?.includes('AGENTS.md'));
 assert.equal(tooFull.children[0].props.style.width,'100%');
 assert.ok(tooFull.props['aria-label'].includes('112.0%'));
 const folder=visit(rendered,v=>v.props?.['aria-label']==='docs 目录');
 assert.ok(folder,'folder itself is interactive, not a separate +/- control');
 assert.equal(folder.props['aria-expanded'],true);
 folder.props.onClick();
 assert.equal(clicked,'docs');
 assert.equal(toggled,'docs');
 assert.equal(wasOpen,true);
 assert.equal(visit(rendered,v=>v.props?.className==='wg-map-expander'),null);
 const repo=visit(rendered,v=>v.props?.['aria-label']==='Workspace 目录');
 assert.ok(repo);
 assert.equal(repo.props['aria-expanded'],true);
 repo.props.onClick();
 assert.equal(clicked,'');
 assert.equal(toggled,'docs','workspace root click selects but never collapses');
 let prevented=false;
 wheelListener({currentTarget:map.props.ref.current,clientX:260,clientY:120,deltaY:-200,
  preventDefault(){prevented=true;}});
 assert.equal(prevented,true);
 const zoomed=state();
 assert.ok(zoomed.scale>1);
 const initial=plugin.mindMapRootView(layout,640,480);
 assert.ok(Math.abs(((160-zoomed.x)/zoomed.scale)-(160-initial.x))<.0001,'cursor-anchored zoom preserves world position');
 map.props.onPointerDown({button:0,pointerId:4,clientX:150,clientY:140,
  target:{closest:()=>null},currentTarget:{setPointerCapture(){}}});
 map.props.onPointerMove({pointerId:4,clientX:180,clientY:180});
 const shifted=state();
 // The isolated renderer does not rerender callback closures after state updates.
 const initialRender=plugin.mindMapRootView(layout,640,440);
 assert.equal(shifted.x,initialRender.x+30);
 assert.equal(shifted.y,initialRender.y+40);
 map.props.onPointerUp({pointerId:4,currentTarget:{releasePointerCapture(){}}});
 const controls=visit(rendered,v=>v.props?.className==='wg-map-controls');
 assert.ok(controls);
 assert.equal(controls.children.length,4,'bottom-right controls +, −, =, fullscreen only');
 assert.deepEqual(Array.from(controls.children.map(v=>v.children[0])),['+','−','=','⛶']);
 assert.equal(visit(rendered,v=>v.props?.className==='wg-map-toolbar'),null);
 const plus=visit(rendered,v=>v.props?.['aria-label']==='展开全部目录');
 plus.props.onClick();
 assert.equal(expandedAll,1);
 const minus=visit(rendered,v=>v.props?.['aria-label']==='收起全部目录');
 minus.props.onClick();
 assert.equal(collapsedAll,1);
 assert.equal(state().scale,shifted.scale,'global expand/collapse never change zoom');
 const reset=visit(rendered,v=>v.props?.['aria-label']==='还原导图');
 reset.props.onClick();
 assert.equal(state().scale,1);
 cleanWheel();assert.equal(removed,true);
 assert.equal(state().x,initial.x);
 assert.equal(state().y,initial.y);
});
test('fullscreen button uses native API and exits via button or Esc; falls back to overlay when native fullscreen is unavailable',async()=>{
 const {plugin,state,runEffect,document}=await client();
 const layout=plugin.mindMapTopology(root,{...choices,expanded:{docs:true}});
 const rendered=plugin.MindMap({layout,selected:'',onSelect:()=>{},onToggle:()=>{},
  onExpandAll:()=>{},onCollapseAll:()=>{}});
 const map=visit(rendered,v=>v.props?.className==='wg-map-viewport');
 map.props.ref.current={addEventListener(){},removeEventListener(){}};
 const shell=rendered.props.ref;
 let entered=0;
 shell.current={requestFullscreen:async()=>{entered++;document.fullscreenElement=shell.current;document.dispatch('fullscreenchange');}};
 const cleanup=runEffect();
 const fullscreen=visit(rendered,v=>v.props?.['aria-label']==='全屏导图');
 assert.ok(fullscreen);
 assert.equal(fullscreen.props['aria-pressed'],false);
 await fullscreen.props.onClick();
 assert.equal(entered,1);
 assert.equal(state(),true);
 await fullscreen.props.onClick();
 assert.equal(state(),false);
 assert.equal(document.fullscreenElement,null);
 await fullscreen.props.onClick();
 assert.equal(state(),true);
 document.fullscreenElement=null;
 document.dispatch('fullscreenchange');
 assert.equal(state(),false,'browser Esc exiting native fullscreen updates plugin state');
 shell.current.requestFullscreen=async()=>{throw Error('browser denied fullscreen')};
 await fullscreen.props.onClick();
 assert.equal(state(),true,'fallback overlay activates when native fullscreen is blocked');
 document.dispatch('keydown',{key:'Escape'});
 assert.equal(state(),false,'Esc closes the fallback fullscreen view');
 shell.current.requestFullscreen=undefined;
 await fullscreen.props.onClick();
 assert.equal(state(),true,'fallback overlay works without Fullscreen API');
 await fullscreen.props.onClick();
 assert.equal(state(),false,'same button toggles fallback overlay off');
 cleanup();
});
