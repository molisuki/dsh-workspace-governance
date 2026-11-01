window.__ModuleLoader__.load({
 id:'dsh-workspace-governance',
 factory:(require)=>{
  const React=require('react'),h=React.createElement;
  const api='/api/dsh-workspace-governance';
  const request=async(route,method='GET',body)=>{
   const res=await fetch(api+route,{method,cache:'no-store',credentials:'same-origin',headers:body?{'content-type':'application/json','x-wg-request':'1'}:{},body:body?JSON.stringify(body):undefined});
   const json=await res.json();
   if(!res.ok||!json.ok)throw Error(json.error||'HTTP '+res.status);
   return json;
  };
  const c=(tag,props,...children)=>h(tag,props,...children);
  const Button=({children,onClick,disabled=false,title})=>c('button',{type:'button',className:'wg-button',onClick,disabled,title},children);

  const canonicalRoot=value=>typeof value==='string'?value.trim().replace(/[\\/]+$/,'').replace(/\\/g,'/').toLowerCase():'';
  // The DSH fallback directory belongs to the application, not to a real user project.
  const isInternalDefaultWorkspace=root=>canonicalRoot(root).endsWith('/documents/deepseek-harness/default-workspace');
  const realProjectRoot=root=>typeof root==='string'&&root.trim()&&!isInternalDefaultWorkspace(root)?root:null;
  function nativeWorkspaceRoot(services){
   const byId=services?.sessions?.list?.getSnapshot?.()?.byId;
   const items=services?.workspaces?.list?.getSnapshot?.()?.items;
   if(!byId||!Array.isArray(items))return null;
   // DSH owns main-view selection through retainedBy.mainView, not a global "current" id.
   const main=Object.values(byId).filter(row=>row&&(row.retainedBy?.mainView??0)>0);
   if(main.length===0&&items.length===1)return realProjectRoot(items[0].path);
   if(main.length!==1)return null;
   const row=main[0];
   const linked=items.find(item=>item.workspaceId===row.workspaceId||
     (Array.isArray(item.sessionIds)&&item.sessionIds.includes(row.id)));
   // DSH may associate the active session with its internal default folder.
   // Prefer a genuine project cwd in that case, never auto-register the placeholder.
   return realProjectRoot(linked?.path)||realProjectRoot(row.cwd);
  }
  async function ensureNativeWorkspace(root,send=request){
   if(!realProjectRoot(root))return null;
   const listed=await send('/workspaces');
   const existing=listed.workspaces.find(item=>canonicalRoot(item.root)===canonicalRoot(root));
   if(existing)return existing;
   if((listed.suspendedRoots||[]).some(item=>canonicalRoot(item)===canonicalRoot(root)))return null;
   return (await send('/workspaces','POST',{root})).workspace;
  }
  function capacityStatus(node,scan,warningRatio=0.8){
   if(!node)return {kind:'idle',label:'等待扫描',description:'',hasBudget:false,percentage:null};
   const relevant=(scan?.issues||[]).filter(issue=>issue.path===node.path);
   const incomplete=scan?.truncated===true&&node.type==='folder'||
     relevant.some(issue=>['unreadable-document','unreadable-directory','invalid-encoding','oversized-document'].includes(issue.type));
   const hasBudget=Number.isFinite(node.limit)&&node.limit>0;
   const percentage=hasBudget?node.chars/node.limit*100:null;
   if(incomplete)return {kind:'unverified',label:'扫描不完整',description:'存在未计入的文档，当前容量统计不能作为完整验收依据。',hasBudget:false,percentage:null};
   const violations=relevant.filter(issue=>node.type==='file'?issue.type==='overflow':issue.type==='aggregate-overflow');
   if(violations.length||node.status==='overflow'||percentage!==null&&percentage>100){
     return {kind:'overlimit',label:'容量超限',
       description:'',hasBudget,percentage};
   }
   if(!hasBudget)return {kind:'neutral',label:'',description:'',hasBudget:false,percentage:null};
   if(percentage>=warningRatio*100)return {kind:'warning',label:'容量预警',description:'接近字符上限，后续写入应优先精简新增内容。',hasBudget,percentage};
   return {kind:'normal',label:'正常',description:'',hasBudget,percentage};
  }
  function inheritedSource(policy,directory){
   const segments=directory?directory.split('/'):[];
   for(let i=segments.length;i>0;i--){
    const key=segments.slice(0,i).join('/');
    if(policy?.directories?.[key]?.fileLimit!==undefined)return '目录 '+key;
   }
   return '工作区默认';
  }
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  function mindMapTopology(root,{tab='tree',expanded={},warningRatio=.8,scan={},policy={}}={}){
   if(!root)return {nodes:[],links:[],width:0,height:0,matches:0};
   const NODE_STEP=224,ROW_STEP=48,NODE_HEIGHT=36;
   const qualifies=node=>tab==='tree'?true:
     tab==='warning'?node.status==='warning':
     tab==='overflow'?node.status==='overflow':
     tab==='overrides'&&node.path!==''&&(
       node.type==='folder'?policy.directories?.[node.path]?.fileLimit!=null:
       node.type==='file'&&policy.files?.[node.path]?.fileLimit!=null);
   function project(node){
    const items=(node.children||[]).map(project).filter(Boolean);
    const relevant=qualifies(node);
    if(node!==root&&!relevant&&!items.length)return null;
    const open=node.type==='folder'&&(node.path===''||expanded[node.path]===true);
    const matches=(relevant&&(node.type==='file'||tab!=='tree')?1:0)+items.reduce((sum,item)=>sum+item.matches,0);
    return {node,children:open?items:[],relevant,hasChildren:(node.children||[]).length>0,open,matches};
   }
   const tree=project(root);
   const nodes=[],links=[];
   let leaf=0,maxRight=0;
   function assign(item,depth){
    const n=item.node;
    const width=n.type==='file'?198:n.path===''?164:158;
    const x=24+depth*NODE_STEP;
    const descendants=item.children.map(child=>assign(child,depth+1));
    const y=descendants.length?(descendants[0].y+descendants[descendants.length-1].y)/2:24+(leaf++)*ROW_STEP;
    const state=capacityStatus(n,scan,warningRatio);
    const node={node:n,path:n.path,x,y,width,height:NODE_HEIGHT,depth,
      relevant:item.relevant,hasChildren:item.hasChildren,open:item.open,state,percentage:state.percentage};
    nodes.push(node);maxRight=Math.max(maxRight,x+width);
    for(const child of descendants){
     const mid1=x+width+24,mid2=child.x-24,centerY=y+NODE_HEIGHT/2,childCenter=child.y+child.height/2;
     links.push({from:n.path,to:child.path,
       d:'M '+(x+width)+' '+centerY+' C '+mid1+' '+centerY+' '+mid2+' '+childCenter+' '+child.x+' '+childCenter});
    }
    return node;
   }
   assign(tree,0);
   nodes.sort((a,b)=>a.depth-b.depth||a.y-b.y);
   const byY=nodes.slice().sort((a,b)=>a.y-b.y);
   const linkByChild=Object.create(null);
   for(const link of links)linkByChild[link.to]=link;
   return {nodes,byY,links,linkByChild,width:maxRight+24,height:Math.max(100,leaf*ROW_STEP+32),matches:tree.matches};
  }
  function mindMapVisibleNodes(layout,view,width,height){
   if(!width||!height||!view.scale)return layout.nodes;
   const byY=layout.byY??layout.nodes;
   const top=(-view.y-100)/view.scale-36,bottom=(height+100-view.y)/view.scale;
   let lo=0,hi=byY.length;
   while(lo<hi){const mid=(lo+hi)>>1;if(byY[mid].y<top)lo=mid+1;else hi=mid;}
   const result=[];
   const left=(-view.x-120)/view.scale,right=(width+120-view.x)/view.scale;
   for(let i=lo;i<byY.length&&byY[i].y<=bottom;i++){
    const n=byY[i];if(n.x+n.width>=left&&n.x<=right)result.push(n);
   }
   return result;
  }
  function mindMapRootView(layout,viewportWidth=640,viewportHeight=440,referenceWidth=layout?.width){
   const root=layout?.nodes?.find(item=>item.path==='');
   const width=Number.isFinite(viewportWidth)&&viewportWidth>0?viewportWidth:640;
   const height=Number.isFinite(viewportHeight)&&viewportHeight>0?viewportHeight:440;
   const baseline=Number.isFinite(referenceWidth)&&referenceWidth>0?referenceWidth:layout?.width??0;
   const rootX=root?.x??24;
   const leftBias=112;
   return {x:Math.max(8-rootX,Math.min(28-rootX,(width-baseline)/2-leftBias)),
     y:height/2-(root?.y??24)-(root?.height??36)/2,scale:1};
  }
  function mindMapFrame(layout,viewportWidth,viewportHeight,focusPath=''){
   if(!layout?.width||!layout?.height||!viewportWidth||!viewportHeight)return {x:18,y:16,scale:1};
   const margin=20,fit=Math.min(1.1,(viewportWidth-2*margin)/layout.width,
     (viewportHeight-2*margin)/layout.height);
   // Small enough for a legible overview: show everything. Large trees prioritize a readable focus.
   const scale=clamp(fit,.55,1.1);
   if(fit>=.55)return {x:(viewportWidth-layout.width*scale)/2,y:(viewportHeight-layout.height*scale)/2,scale};
   const focus=layout.nodes.find(item=>item.path===focusPath)??layout.nodes[0];
   return {
    x:focus.path===''?20-focus.x*scale:viewportWidth/2-(focus.x+focus.width/2)*scale,
    y:viewportHeight/2-(focus.y+focus.height/2)*scale,
    scale
   };
  }
  function directoryExpansionMap(root,open){
   const branches={'':true};
   const visit=node=>{
    if(node?.type!=='folder')return;
    if(node.path!=='')branches[node.path]=open;
    for(const child of node.children||[])visit(child);
   };
   visit(root);
   return branches;
  }
  function MindMap({layout,selected,onSelect,onToggle,onExpandAll,onCollapseAll,frameRequest=0,referenceWidth=layout?.width}){
   const [fullscreen,setFullscreen]=React.useState(false);
   const [viewportSize,setViewportSize]=React.useState({width:640,height:440});
   const [view,setView]=React.useState(()=>mindMapRootView(layout,640,440,referenceWidth));
   const shell=React.useRef(null),viewport=React.useRef(null),drag=React.useRef(null);
   const navigated=React.useRef(false);
   const fullscreenActive=React.useRef(false),fallbackFullscreen=React.useRef(false);
   React.useEffect(()=>{
    const element=viewport.current;
    if(!element)return undefined;
    const measure=()=>{
     const width=element.clientWidth,height=element.clientHeight;
     if(width>0&&height>0){
      setViewportSize(size=>size.width===width&&size.height===height?size:{width,height});
      if(!navigated.current)setView(mindMapRootView(layout,width,height,referenceWidth));
     }
    };
    measure();
    if(typeof ResizeObserver==='function'){
     const observer=new ResizeObserver(measure);
     observer.observe(element);
     return ()=>observer.disconnect();
    }
    if(typeof window.addEventListener==='function'){
     window.addEventListener('resize',measure);
     return ()=>window.removeEventListener('resize',measure);
    }
    return undefined;
   },[]);
   const updateFullscreen=enabled=>{fullscreenActive.current=enabled;setFullscreen(enabled);};
   React.useEffect(()=>{
    if(!frameRequest||!viewport.current)return;
    navigated.current=true;
    setView(mindMapFrame(layout,viewport.current.clientWidth,viewport.current.clientHeight,selected));
   },[frameRequest]);
   const toggleFullscreen=async()=>{
    const el=shell.current;
    if(!el)return;
    if(fullscreenActive.current){
     if(document.fullscreenElement===el&&typeof document.exitFullscreen==='function'){
      try{await document.exitFullscreen();}catch{return;}
     }
     fallbackFullscreen.current=false;
     updateFullscreen(false);
     return;
    }
    if(typeof el.requestFullscreen==='function'){
     try{
      await el.requestFullscreen();
      if(document.fullscreenElement===el){updateFullscreen(true);return;}
     }catch{}
    }
    fallbackFullscreen.current=true;
    updateFullscreen(true);
   };
   const zoom=(amount,center)=>{
    const el=viewport.current;
    if(!el)return;
    const rect=el.getBoundingClientRect();
    const at=center||{x:rect.width/2,y:rect.height/2};
    setView(v=>{
     const scale=clamp(v.scale*amount,.005,2.5);
     return {x:at.x-(at.x-v.x)*scale/v.scale,y:at.y-(at.y-v.y)*scale/v.scale,scale};
    });
   };
   const onWheel=e=>{
    navigated.current=true;
    e.preventDefault();
    const rect=e.currentTarget.getBoundingClientRect();
    zoom(Math.exp(-e.deltaY*.0015),{x:e.clientX-rect.left,y:e.clientY-rect.top});
   };
   // A native non-passive listener prevents document scroll while zooming the map.
   React.useEffect(()=>{
    const element=viewport.current;
    if(!element)return undefined;
    element.addEventListener('wheel',onWheel,{passive:false});
    return ()=>element.removeEventListener('wheel',onWheel);
   },[]);
   React.useEffect(()=>{
    const onFullscreenChange=()=>{
     if(document.fullscreenElement===shell.current){
      fallbackFullscreen.current=false;
      updateFullscreen(true);
     }else if(!fallbackFullscreen.current)updateFullscreen(false);
    };
    const onKeydown=e=>{
     if(e.key==='Escape'&&fallbackFullscreen.current){
      fallbackFullscreen.current=false;
      updateFullscreen(false);
     }
    };
    document.addEventListener('fullscreenchange',onFullscreenChange);
    document.addEventListener('keydown',onKeydown);
    return ()=>{
     document.removeEventListener('fullscreenchange',onFullscreenChange);
     document.removeEventListener('keydown',onKeydown);
     if(document.fullscreenElement===shell.current)
      Promise.resolve(document.exitFullscreen?.()).catch(()=>{});
     fallbackFullscreen.current=false;
    };
   },[]);
   const onPointerDown=e=>{
    if(e.button!==0||e.target.closest?.('.wg-map-node'))return;
    drag.current={pointerId:e.pointerId,x:e.clientX,y:e.clientY,origin:view};
    e.currentTarget.setPointerCapture?.(e.pointerId);
   };
   const onPointerMove=e=>{
    const state=drag.current;
    if(!state||state.pointerId!==e.pointerId)return;
    const dx=e.clientX-state.x,dy=e.clientY-state.y;
    if(Math.abs(dx)+Math.abs(dy)>2){
      navigated.current=true;
      setView({x:state.origin.x+dx,y:state.origin.y+dy,scale:state.origin.scale});
    }
   };
   const onPointerUp=e=>{
    if(drag.current?.pointerId!==e.pointerId)return;
    drag.current=null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
   };
   const visible=mindMapVisibleNodes(layout,view,viewportSize.width,viewportSize.height);
   const dpr=Number.isFinite(window.devicePixelRatio)&&window.devicePixelRatio>0?window.devicePixelRatio:1;
   const sharpX=Math.round(view.x*dpr)/dpr,sharpY=Math.round(view.y*dpr)/dpr;
   return c('div',{ref:shell,className:'wg-map-shell'+(fullscreen?' wg-map-fullscreen':'')},
    c('div',{className:'wg-map-viewport',ref:viewport,
       onPointerDown,onPointerMove,onPointerUp,onPointerCancel:onPointerUp,
       'aria-label':'Markdown 目录思维导图'},
      c('div',{className:'wg-map-stage',style:{
        width:layout.width,height:layout.height,transform:'translate('+sharpX+'px,'+sharpY+'px) scale('+view.scale+')'}},
        c('svg',{className:'wg-map-edges',width:layout.width,height:layout.height,
          viewBox:'0 0 '+layout.width+' '+layout.height,'aria-hidden':true},
          ...visible.map(node=>layout.linkByChild?.[node.path]).filter(Boolean)
            .map(link=>c('path',{key:link.to,d:link.d}))),
        ...visible.map(item=>{
         const node=item.node,file=node.type==='file';
         const usage=item.percentage,percent=usage===null?'—':usage.toFixed(1)+'%';
         const fill=usage===null?0:Math.round(clamp(usage,0,100)*10)/10;
         const color=item.state.kind==='overlimit'?'overlimit':item.state.kind==='warning'?'warning':
           item.state.kind==='unverified'?'unverified':'normal';
         const isSelected=selected===item.path;
         return c('div',{key:item.path,className:'wg-map-item',style:{
           left:item.x,top:item.y,width:item.width,height:item.height}},
           c('button',{type:'button',className:'wg-map-node '+(file?'wg-map-file '+color:'wg-map-folder')+
              (node.path===''?' wg-map-root':'')+(isSelected?' selected':''),
             'aria-label':file?node.name+' '+percent+' '+item.state.label:node.name+' 目录',
             'aria-pressed':isSelected,
             ...(file||!item.hasChildren?{}:{'aria-expanded':item.path===''?true:item.open}),
             title:item.path||'工作区根目录',
             onPointerDown:e=>e.stopPropagation(),
             onClick:()=>{
               navigated.current=true;
               onSelect(item.path);
               if(!file&&item.path!==''&&item.hasChildren)onToggle(item.path,item.open);
             }},
             file?c('span',{className:'wg-map-file-fill '+color,style:{width:fill+'%'},
               'aria-hidden':true}):null,
             c('span',{className:'wg-map-label'},node.name||'工作区'),
             file?c('span',{className:'wg-map-percent'},percent):
               node.path!==''?c('span',{className:'wg-map-folder-count',title:'目录下 Markdown 文件数量'},String(node.files??0)):null));
        })),
      c('div',{className:'wg-map-controls',onPointerDown:e=>e.stopPropagation()},
        c('button',{type:'button','aria-label':'展开全部目录',title:'展开全部',onClick:onExpandAll},'+'),
        c('button',{type:'button','aria-label':'收起全部目录',title:'收起全部',onClick:onCollapseAll},'−'),
        c('button',{type:'button','aria-label':'还原导图',title:'还原',onClick:()=>{
          navigated.current=false;
          const el=viewport.current;
          setView(mindMapRootView(layout,el?.clientWidth||viewportSize.width,
            el?.clientHeight||viewportSize.height,referenceWidth));
        }},'='),
        c('button',{type:'button','aria-label':fullscreen?'退出全屏':'全屏导图',
          'aria-pressed':fullscreen,title:fullscreen?'退出全屏（Esc）':'全屏',
          onClick:toggleFullscreen},fullscreen?'⤡':'⛶'))
    )
   );
  }
  function Page({services}){
   const [workspaces,setWorkspaces]=React.useState([]),[id,setId]=React.useState(''),[scan,setScan]=React.useState(null),[selected,setSelected]=React.useState('');
   const [tab,setTab]=React.useState('tree'),[expanded,setExpanded]=React.useState({'' :true});
   const [mapFrameRequest,setMapFrameRequest]=React.useState(0);
   const [workspaceLimit,setWorkspaceLimit]=React.useState('2400'),[directoryLimit,setDirectoryLimit]=React.useState(''),[fileLimit,setFileLimit]=React.useState('');
   const [notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[preview,setPreview]=React.useState(null),[lastApply,setLastApply]=React.useState(null),[pathDraft,setPathDraft]=React.useState('');
   const [manualAdd,setManualAdd]=React.useState(false);
   const [trackingPaused,setTrackingPaused]=React.useState(false);
   const [warningPercent,setWarningPercent]=React.useState('80');
   const [optimizationPercent,setOptimizationPercent]=React.useState('10');
   const [advisoryExpanded,setAdvisoryExpanded]=React.useState(false);
   const [skillExpanded,setSkillExpanded]=React.useState(false);
   const [skillPromptExpanded,setSkillPromptExpanded]=React.useState(false);
   const [skillMode,setSkillMode]=React.useState('embedded');
   const [customSkill,setCustomSkill]=React.useState('');
   const [customPrompt,setCustomPrompt]=React.useState('');
   const [embeddedPrompt,setEmbeddedPrompt]=React.useState('');
   const skillEditorVersion=React.useRef('');
   const lastLoadedSkillMode=React.useRef(null);
   const [advisoryStatus,setAdvisoryStatus]=React.useState(null);
   const [nativeRoot,setNativeRoot]=React.useState(()=>nativeWorkspaceRoot(services));
    const [detectionExpanded,setDetectionExpanded]=React.useState(false);
    const loadRequest=React.useRef(0);   const scanRequest=React.useRef(0);
   const activeWorkspaceId=React.useRef(id);
   activeWorkspaceId.current=id;
   React.useEffect(()=>{
    if(!services?.sessions?.list||!services?.workspaces?.list)return undefined;
    const update=()=>{try{setNativeRoot(nativeWorkspaceRoot(services));}catch{setNativeRoot(null);}};
    update();
    const cleanups=[];
    for(const list of [services.sessions.list,services.workspaces.list]){
     if(typeof list.subscribe==='function'){
      try{const stop=list.subscribe(update);if(typeof stop==='function')cleanups.push(stop);}catch{}
     }
    }
    // Reconciliation covers clients whose list does not publish a switch event.
    const interval=window.setInterval(update,2000);
    return ()=>{window.clearInterval(interval);for(const stop of cleanups)stop();};
   },[services]);

   const current=workspaces.find(x=>x.id===id);
   const notify=(value)=>setNotice(value);
   const loadWorkspaces=React.useCallback(async(preferred)=>{
    const version=++loadRequest.current;
    const result=await request('/workspaces');
    if(version!==loadRequest.current)return;
    const projects=result.workspaces.filter(ws=>!isInternalDefaultWorkspace(ws.root));
    setWorkspaces(projects);
    setId(old=>
      (preferred&&projects.some(x=>x.id===preferred)?preferred:null)||
      (old&&projects.some(x=>x.id===old)?old:null)||
      (projects.some(x=>x.id===result.selected)?result.selected:null)||projects[0]?.id||'');
   },[]);
   React.useEffect(()=>{loadWorkspaces().catch(e=>notify(e.message));},[loadWorkspaces]);
   React.useEffect(()=>{
    if(!nativeRoot)return undefined;
    let cancelled=false;
    (async()=>{
     try{
      const ws=await ensureNativeWorkspace(nativeRoot);
      if(!cancelled){
        setTrackingPaused(!ws);
        await loadWorkspaces(ws?.id);
        if(!ws)setId('');
      }
     }catch(e){if(!cancelled)notify('原生工作区同步失败：'+e.message);}
    })();
    return ()=>{cancelled=true;};
   },[nativeRoot,loadWorkspaces]);

   const refresh=React.useCallback(async(force=false)=>{
    if(!id)return;
    const sequence=++scanRequest.current;
    const result=force?await request('/scan','POST',{id}):await request('/tree?id='+encodeURIComponent(id));
    if(activeWorkspaceId.current===id&&sequence===scanRequest.current)
      setScan(previous=>previous?.workspaceId===result.scan?.workspaceId&&
        previous?.fingerprint===result.scan?.fingerprint?previous:result.scan);
   },[id]);
   React.useEffect(()=>{
    setScan(null);setSelected('');setPreview(null);
    skillEditorVersion.current='';
    lastLoadedSkillMode.current=null;
     setSkillExpanded(false);
     setDetectionExpanded(false);    setSkillPromptExpanded(false);
    refresh().catch(e=>notify(e.message));
    const interval=setInterval(()=>refresh().catch(e=>notify(e.message)),3000);
    return ()=>clearInterval(interval);
   },[refresh]);
   React.useEffect(()=>{
    if(!id)return undefined;
    let cancelled=false;
    const update=async()=>{
      try{const data=await request('/maintenance?id='+encodeURIComponent(id));
        if(!cancelled&&activeWorkspaceId.current===id){
          setAdvisoryStatus(data);
          const marker=data.workspaceId+'|'+data.policyVersion;
          if(data.skillSettings&&marker!==skillEditorVersion.current){
            skillEditorVersion.current=marker;
            if(lastLoadedSkillMode.current!==data.skillSettings.mode)setSkillPromptExpanded(false);
            lastLoadedSkillMode.current=data.skillSettings.mode;
            setSkillMode(data.skillSettings.mode);
            setCustomSkill(data.skillSettings.customSkill);
            setCustomPrompt(data.skillSettings.customPrompt);
            setEmbeddedPrompt(data.skillSettings.embeddedPrompt);
          }
        }}
      catch(e){if(!cancelled)setAdvisoryStatus({available:false,enabled:false,events:[],error:e.message});}
    };
    setAdvisoryStatus(null);
    update();
    const timer=setInterval(update,3000);
    return ()=>{cancelled=true;clearInterval(timer);};
   },[id]);
   async function setAdvisoryMode(mode){
     if(!advisoryStatus?.available||!current||mode===advisoryStatus.mode)return;
     await action(async()=>{
       await request('/mode','PUT',{id,mode,expectedVersion:current.policy.version});
       await loadWorkspaces(id);
       const data=await request('/maintenance?id='+encodeURIComponent(id));
       if(activeWorkspaceId.current===id)setAdvisoryStatus(data);
       notify(mode==='off'?'Agent 容量提示已关闭':'Agent 容量触发模式已保存');
     });
   }
   async function saveWarningPercent(){
     await action(async()=>{
       if(!current)throw Error('请选择工作区');
       const percent=Number(warningPercent);
       if(!Number.isInteger(percent)||percent<1||percent>99)throw Error('预警阈值应为 1–99 的整数百分比');
       if(percent===Math.round(current.policy.warningRatio*100))return notify('参数未变化');
       await request('/defaults','PUT',{id,defaultFileLimit:current.policy.defaultFileLimit,
         aggregateLimit:current.policy.aggregateLimit??null,warningRatio:percent/100,expectedVersion:current.policy.version});
       await loadWorkspaces(id);await refresh(true);notify('预警百分比已更新');
     });
   }
   async function saveOptimizationPercent(){
     await action(async()=>{
       if(!current)throw Error('请选择工作区');
       const percent=Number(optimizationPercent);
       if(String(optimizationPercent).trim()===''||!Number.isSafeInteger(percent)||percent<1||percent>99)
         throw Error('目标精简比例应为 1–99 的整数百分比');
       if(percent===(current.policy.optimizationPercent??10))return notify('参数未变化');
       await request('/defaults','PUT',{id,defaultFileLimit:current.policy.defaultFileLimit,
         aggregateLimit:current.policy.aggregateLimit??null,warningRatio:current.policy.warningRatio,
         optimizationPercent:percent,expectedVersion:current.policy.version});
       await loadWorkspaces(id);notify('目标精简比例已保存');
     });
   }
   async function saveSkillSettings(mode=skillMode,useSavedOnSwitch=false){
     if(!current)return notify('请选择工作区');
     await action(async()=>{
       const previous=useSavedOnSwitch?advisoryStatus?.skillSettings:null;
       const settings={mode,customSkill:previous?.customSkill??customSkill,
         customPrompt:previous?.customPrompt??customPrompt,
         embeddedPrompt:previous?.embeddedPrompt??embeddedPrompt};
       if(!settings.customSkill.trim()||!settings.customPrompt.trim()||!settings.embeddedPrompt.trim())
         throw Error('Skill 规范和两套 Agent 提示词不能为空');
       if(settings.customSkill.length>24000||settings.customPrompt.length>12000||settings.embeddedPrompt.length>12000)
         throw Error('Skill 规范或提示词超出字符限制');
       const result=await request('/skill-settings','PUT',{id,settings,expectedVersion:current.policy.version});
       setSkillMode(mode);
       lastLoadedSkillMode.current=mode;
       if(useSavedOnSwitch){
         setCustomSkill(settings.customSkill);
         setCustomPrompt(settings.customPrompt);
         setEmbeddedPrompt(settings.embeddedPrompt);
       }
       skillEditorVersion.current=id+'|'+result.policy.version;
       await loadWorkspaces(id);
       const data=await request('/maintenance?id='+encodeURIComponent(id));
       if(activeWorkspaceId.current===id)setAdvisoryStatus(data);
       notify('Agent 精简 Skill 配置已保存');
     });
   }
   function restoreDefaultSkillPrompt(mode){
     const field=mode==='custom'?'customPrompt':'embeddedPrompt';
     const value=advisoryStatus?.skillPromptDefaults?.[field];
     if(typeof value!=='string'||!value.trim())return notify('默认提示词尚未加载');
     if(mode==='custom')setCustomPrompt(value);
     else setEmbeddedPrompt(value);
     notify('已还原默认提示词；点击保存后生效');
   }
   async function importCustomSkill(event){
     const file=event.target.files?.[0];
     if(!file)return;
     try{
       if(file.size>100000)throw Error('Skill 文件过大');
       const content=await file.text();
       if(content.length>24000||!content.trim())throw Error('Skill 内容必须为 1–24000 字符');
       setCustomSkill(content);
       notify('已导入 Skill 内容，请点击保存完成持久化');
     }catch(error){notify(error.message);}
     finally{event.target.value='';}
   }
   const warningRatio=current?.policy?.warningRatio??0.8;
   const usableScan=scan?.workspaceId===id&&
     (scan.policyVersion==null||current?.policy?.version==null||scan.policyVersion===current.policy.version)?scan:null;
   const referenceLayout=React.useMemo(()=>mindMapTopology(usableScan?.tree??null,
     {tab:'tree',expanded:{'':true},warningRatio,scan:usableScan}),[usableScan,warningRatio]);
   const mapLayout=React.useMemo(()=>mindMapTopology(usableScan?.tree??null,
     {tab,expanded,warningRatio,scan:usableScan,policy:current?.policy}),
     [usableScan,tab,expanded,warningRatio,current?.policy]);
   const visibleNodes=mapLayout.nodes.map(item=>item.node);
   const active=usableScan?(visibleNodes.find(x=>x.path===selected)||
     (tab==='tree'?visibleNodes[0]??null:mapLayout.nodes.find(item=>item.relevant&&item.path!=='')?.node??null)):null;
   const relative=active?.path||'';
   const scope=active?.type==='file'?'files':'directories';
   const rule=relative?current?.policy?.[scope]?.[relative]||{}:{};
   // Root is the only mandatory numeric default; other nodes expose explicit overrides or inheritance.
   const isRoot=active?.type==='folder'&&relative==='';

   const directoryPath=active?.type==='file'?relative.split('/').slice(0,-1).join('/'):relative;
   const filePath=active?.type==='file'?relative:null;
   const directoryOverride=directoryPath?current?.policy?.directories?.[directoryPath]?.fileLimit:undefined;
   const fileOverride=filePath?current?.policy?.files?.[filePath]?.fileLimit:undefined;
   const inheritedFrom=inheritedSource(current?.policy,directoryPath);
   const sourceLabel=active?.origin?.startsWith('file:')?'本文件设置':active?.origin?.startsWith('directory:')?'继承自目录 '+active.origin.slice(10):'继承自工作区默认';
   const capacity=capacityStatus(active,usableScan,warningRatio);
   const displayLimit=capacity.hasBudget?active?.limit:null;
   const usageRate=capacity.percentage;
   const protectedDocument=active?.type==='file'&&active.protected===true;
   const canReviewDuplicates=active?.type==='file'&&active.duplicates>0&&!protectedDocument;
   const restoredHistory=new Set((advisoryStatus?.events||[]).filter(event=>event.type==='restored').map(event=>event.path+'|'+event.expectedHash));
   const remediation=advisoryStatus?.remediation??null;
   const remediationTasks=remediation?.tasks??[];
   const logEvents=advisoryStatus?.events||[];
   const logChanges=logEvents.filter(event=>['verified','compressed','restored'].includes(event.type)&&
     Number.isSafeInteger(event.beforeChars)&&Number.isSafeInteger(event.afterChars));
   const netReduction=logChanges.reduce((total,event)=>total+event.beforeChars-event.afterChars,0);
   const logStatus={verified:'历史执行成功',compressed:'人工压缩完成',restored:'已恢复',
     blocked:'历史阻断',warning:'历史预警',review:'等待复核',conflict:'版本冲突'};
   React.useEffect(()=>{
    setWorkspaceLimit(String(current?.policy?.defaultFileLimit??2400));
    setWarningPercent(String(Math.round((current?.policy?.warningRatio??0.8)*100)));
    setOptimizationPercent(String(current?.policy?.optimizationPercent??10));
    setDirectoryLimit(directoryOverride===undefined?'':String(directoryOverride));
    setFileLimit(fileOverride===undefined?'':String(fileOverride));
   },[id,selected,current?.policy?.defaultFileLimit,current?.policy?.optimizationPercent,directoryOverride,fileOverride,scan?.policyVersion]);
   async function action(task){
    setBusy(true);setNotice('');
    try{await task();}catch(e){notify(e.message);}
    finally{setBusy(false);}
   }
   async function addWorkspace(){
    const root=pathDraft.trim();
    if(!root)return notify('请填写绝对工作区路径');
    await action(async()=>{const response=await request('/workspaces','POST',{root,manual:true});await loadWorkspaces(response.workspace.id);setTrackingPaused(false);setPathDraft('');notify('工作区已重新启用跟踪');});
   }
   async function resumeNativeWorkspace(){
    if(!nativeRoot)return;
    await action(async()=>{
      const response=await request('/workspaces','POST',{root:nativeRoot,manual:true});
      await loadWorkspaces(response.workspace.id);
      setTrackingPaused(false);
      notify('已恢复当前工作区跟踪，原有阈值配置未改变');
    });
   }
   async function removeWorkspace(){
    if(!current||!confirm('停止跟踪这个工作区？插件将不再自动注册此目录，保留全部独立阈值配置和仓库文件。可通过手动添加重新启用。'))return;
    await action(async()=>{await request('/workspaces','DELETE',{id});setId('');setScan(null);setTrackingPaused(true);await loadWorkspaces();notify('已停止跟踪该目录；不会随 DSH 当前工作区自动恢复');});
   }
   function positiveInteger(value,label){
    const n=Number(value);
    if(String(value).trim()===''||!Number.isSafeInteger(n)||n<1||n>100000000)throw Error(label+'必须为 1–100000000 的整数');
    return n;
   }
   async function saveLimit(level){
    await action(async()=>{
      if(!current||!active)throw Error('请选择工作区或文档');
      const version=current.policy.version;
      if(level==='workspace'){
        const value=positiveInteger(workspaceLimit,'工作区默认单文件上限');
        if(value===current.policy.defaultFileLimit)return notify('参数未变化');
        await request('/defaults','PUT',{id,defaultFileLimit:value,
          warningRatio:current.policy.warningRatio,aggregateLimit:current.policy.aggregateLimit??null,expectedVersion:version});
      }else{
        const target=level==='directory'?directoryPath:filePath;
        if(!target)throw Error('当前层级没有可编辑的规则路径');
        const draft=level==='directory'?directoryLimit:fileLimit;
        const override=draft.trim()===''?null:positiveInteger(draft,level==='directory'?'目录单文件上限':'单文件上限');
        const original=level==='directory'?directoryOverride:fileOverride;
        if(override===(original??null))return notify('参数未变化');
        await request('/rules','PUT',{id,scope:level==='directory'?'directories':'files',relative:target,
          rule:{fileLimit:override},expectedVersion:version});
      }
      await loadWorkspaces(id);await refresh(true);notify('单文件字符上限已保存');
    });
   }
   function renderLimitRow({label,value,onChange,onSave,inherit=false,source='工作区默认'}){
    return c('div',{className:'wg-limit-row'},
      c('label',null,label,c('input',{type:'number',min:1,max:100000000,
        required:!inherit,placeholder:inherit?'继承自'+source:'',value,onChange:e=>onChange(e.target.value)})),
      c(Button,{onClick:onSave,disabled:busy},'保存'));
   }
   async function getPreview(node){
    if(node.type!=='file')return;
    await action(async()=>{const output=await request('/preview','POST',{id,path:node.path});setPreview(output);});
   }
   async function applySuggestion(){
    if(!preview||!preview.proposal?.removed?.length||preview.protected)return;
    if(!window.confirm('确认删除列出的完全重复段落？原文件将保存私有快照。'))return;
    await action(async()=>{
      const output=await request('/apply','POST',{id,path:preview.path,confirmed:true,expectedHash:preview.proposal.beforeHash});
      setLastApply({id,path:preview.path,backupHash:output.beforeHash,expectedHash:output.afterHash});
      setPreview(null);await refresh(true);notify('已完成压缩：减少 '+output.reducedCodepoints+' 个字符');
    });
   }
   async function restoreSuggestion(){
    if(!lastApply||!window.confirm('确认恢复压缩前的文件版本？'))return;
    await action(async()=>{
      await request('/restore','POST',{...lastApply,confirmed:true});
      setLastApply(null);await refresh(true);notify('文件已恢复到压缩前版本');
    });
   }
   async function restoreGuardedEvent(event){
    if(!event.backupHash||!event.expectedHash||!event.path)return;
    if(!window.confirm('恢复此文件的受控写入前版本？只有文件仍处于该次写入后的版本时才允许恢复。'))return;
    await action(async()=>{
      await request('/restore','POST',{id,path:event.path,backupHash:event.backupHash,expectedHash:event.expectedHash,confirmed:true});
      await refresh(true);notify('已恢复修改前版本');
    });
   }
   async function deleteLogEvent(event){
     if(!current||!window.confirm('确认删除此条日志？仅删除活动记录，不删除文档或恢复快照。'))return;
     await action(async()=>{
       await request('/logs','DELETE',{id,eventId:event.id});
       const updated=await request('/maintenance?id='+encodeURIComponent(id));
       if(activeWorkspaceId.current===id)setAdvisoryStatus(updated);
       notify('日志已删除，文档与恢复快照均未更改');
     });
   }

   const logPanel=c('section',{className:'wg-card wg-log-card'},
     c('div',{className:'wg-card-top'},c('h2',null,'执行与字符优化日志'),
       c('span',{className:'wg-log-count'},logEvents.length+' 条记录')),
     c('div',{className:'wg-log-summary'},
       c('div',null,c('small',null,'记录总数'),c('strong',null,String(logEvents.length))),
       c('div',null,c('small',null,'已验证执行'),c('strong',null,String(logEvents.filter(e=>['verified','compressed'].includes(e.type)).length))),
       c('div',null,c('small',null,'已记录净减少（负值为增加）'),c('strong',null,(netReduction>0?'+':'')+netReduction.toLocaleString()+' 字符'))),
     c('p',{className:'wg-parameter-note'},'仅统计有前后字符数的记录，采用该文件当时的有效字符统计模式；旧日志缺少指标时标为未记录。最多保留最近 60 条活动记录。'),
     !current?c('p',{className:'wg-empty-docs'},'请选择工作区查看日志'):
     !advisoryStatus?c('p',{className:'wg-empty-docs'},'正在读取日志…'):
     logEvents.length===0?c('p',{className:'wg-empty-docs'},'暂无执行记录'):
     c('div',{className:'wg-log-list'},...logEvents.map(event=>{
       const measured=Number.isSafeInteger(event.beforeChars)&&Number.isSafeInteger(event.afterChars);
       const delta=measured?event.beforeChars-event.afterChars:null;
       const percent=measured&&event.beforeChars>0?delta/event.beforeChars*100:null;
       const canRestore=['verified','compressed'].includes(event.type)&&event.backupHash&&event.expectedHash&&
         !restoredHistory.has(event.path+'|'+event.expectedHash);
       return c('article',{key:event.id,className:'wg-log-event'},
         c('div',{className:'wg-log-heading'},
           c('strong',{className:'wg-log-status '+event.type},logStatus[event.type]||event.type),
           c('time',null,event.at?new Date(event.at).toLocaleString():'时间未记录')),
         c('div',{className:'wg-log-path',title:event.path||''},event.path||'工作区'),
         measured?c('div',{className:'wg-log-metrics'},
           c('span',null,'修改前 ',event.beforeChars.toLocaleString()),
           c('span',null,'修改后 ',event.afterChars.toLocaleString()),
           c('strong',{className:delta>0?'reduced':delta<0?'increased':''},
             delta>0?'减少 '+delta.toLocaleString():delta<0?'增加 '+(-delta).toLocaleString():'无变化',
             percent===null?'':' ('+Math.abs(percent).toFixed(1)+'%)')):
           c('div',{className:'wg-log-unmeasured'},'字符变化：未记录'),
         c('p',{className:'wg-log-detail'},event.detail||'无详细说明'),
         c('div',{className:'wg-log-actions'},
           canRestore?c(Button,{onClick:()=>restoreGuardedEvent(event),disabled:busy},'恢复文档'):null,
           c(Button,{onClick:()=>deleteLogEvent(event),disabled:busy,title:'只删除此条活动日志，不删除文档或恢复快照'},'删除日志')));
     })));
    const maintenancePanel=current?c('section',{className:'wg-card wg-maintenance-card'},
      c('div',{className:'wg-advisory-area'},
        c('button',{type:'button',className:'wg-collapse-header',
          'aria-expanded':advisoryExpanded,'aria-controls':'wg-advisory-content',
          onClick:()=>setAdvisoryExpanded(value=>!value)},
          c('span',null,c('strong',null,'Agent 容量提示'),
            c('small',null,advisoryStatus?.mode==='warning'?'预警提示':
              advisoryStatus?.mode==='overflow'?'超限提示':'已关闭')),
          c('span',{className:'wg-collapse-chevron','aria-hidden':true},advisoryExpanded?'⌃':'⌄')),
        advisoryExpanded?c('div',{id:'wg-advisory-content',className:'wg-trigger-settings'},
          c('div',{className:'wg-trigger-row'},
            c('label',null,'预警百分比',
              c('input',{type:'number',min:1,max:99,step:1,value:warningPercent,'aria-label':'预警百分比',onChange:e=>setWarningPercent(e.target.value)})),
            c(Button,{onClick:saveWarningPercent,disabled:busy},'保存')),
          c('div',{className:'wg-trigger-row'},
            c('label',null,'目标精简比例（触发阈值回退百分点）',
              c('input',{type:'number',min:1,max:99,step:1,value:optimizationPercent,
                'aria-label':'目标精简比例',onChange:e=>setOptimizationPercent(e.target.value)})),
            c(Button,{onClick:saveOptimizationPercent,disabled:busy},'保存')),
          c('p',{className:'wg-parameter-note'},'目标使用率＝当前模式阈值－精简百分点。'),
          c('div',{className:'wg-mode-options',role:'radiogroup','aria-label':'Agent 容量管理模式'},
            ...[['warning','预警提示','达到预警比例后通知匹配的运行中 Agent'],
                ['overflow','超限提示','超过文件有效上限后通知匹配的运行中 Agent'],
                ['off','关闭容量提示','不发送容量精简建议；扫描和显示继续运行']].map(([mode,label,description])=>
              c('label',{className:'wg-mode-option',key:mode},
                c('input',{type:'radio',name:'wg-capacity-mode',value:mode,
                  checked:advisoryStatus?.mode===mode,onChange:()=>setAdvisoryMode(mode),
                  disabled:busy||!advisoryStatus?.available}),
                c('span',null,c('strong',null,label),c('small',null,description)))))
        ):null
      )
    ):null;
    const detectionPanel=current?c('section',{className:'wg-card wg-maintenance-card wg-detection-card'},
      c('button',{type:'button',className:'wg-collapse-header',
        'aria-expanded':detectionExpanded,'aria-controls':'wg-detection-content',
        onClick:()=>setDetectionExpanded(value=>!value)},
        c('span',null,c('strong',null,'文件变更检测'),
          c('small',null,!remediation?.verified?'待核验':'待处理 '+(remediation?.total??0))),
        c('span',{className:'wg-collapse-chevron','aria-hidden':true},detectionExpanded?'⌃':'⌄')),
      detectionExpanded?c('div',{id:'wg-detection-content',className:'wg-remediation-queue'},
        c('p',{className:'wg-parameter-note'},!remediation?.verified?
          '等待完整扫描验证，既有任务不会因扫描失败而自动清除。':
          '文件变更与待办投递状态；无运行中的会话时保留待办。'),
        ...remediationTasks.map(task=>c('div',{className:'wg-remediation-item',key:task.id},
          c('div',null,c('strong',null,(task.kind==='directory'?'目录 · ':'文件 · ')+(task.path||'工作区')),
            c('small',null,task.usagePercent+'% → '+task.targetPercent+'% · 至少减少 '+task.requiredReduction+' 字符')),
          c('span',{className:'wg-remediation-delivery'},
            Object.keys(task.deliveredTo??{}).length?
              '已推送至 '+Object.keys(task.deliveredTo).length+' 个对话':'等待自动投递'))),
        remediation?.overflow>0?c('p',{className:'wg-parameter-note'},'其余 '+remediation.overflow+' 项通过 /remediation 接口查询。'):null
      ):null
    ):null;
   const skillPanel=current?c('section',{className:'wg-card wg-maintenance-card wg-skill-card'},
      c('button',{type:'button',className:'wg-collapse-header',
        'aria-expanded':skillExpanded,'aria-controls':'wg-skill-content',
        onClick:()=>setSkillExpanded(value=>!value)},
        c('span',null,c('strong',null,'Agent 精简 Skill'),
          c('small',null,skillMode==='embedded'?'内置 Skill · Semantic Refactor + Forensic Prune':
            skillMode==='custom'?'自定义 Skill':'Skill 已关闭')),
        c('span',{className:'wg-collapse-chevron','aria-hidden':true},skillExpanded?'⌃':'⌄')),
      skillExpanded?c('div',{id:'wg-skill-content',className:'wg-skill-body'},
        c('div',{className:'wg-mode-options',role:'radiogroup','aria-label':'Agent 精简 Skill 模式'},
          ...[['custom','自定义 Skill','使用工作区内保存的自定义规范和 Agent 提示词'],
              ['embedded','内置 Skill','完整使用 Semantic Refactor 与 Forensic Prune'],
              ['off','关闭 Skill','不附加 Skill；基础容量提示仍按当前模式运行']].map(([mode,label,description])=>
            c('label',{className:'wg-mode-option',key:mode},
              c('input',{type:'radio',name:'wg-skill-mode',value:mode,checked:skillMode===mode,
                onChange:()=>{setSkillPromptExpanded(false);saveSkillSettings(mode,true);},
                disabled:busy||!advisoryStatus?.skillSettings}),
              c('span',null,c('strong',null,label),c('small',null,description))))),
        skillMode==='custom'?c('div',{className:'wg-skill-editors'},
          c('label',null,'自定义 Skill 规范',
            c('textarea',{value:customSkill,onChange:e=>setCustomSkill(e.target.value),
              maxLength:24000,rows:7,'aria-label':'自定义 Skill 规范'})),
          c('label',{className:'wg-import-label'},'导入 Skill 文件（.md / .txt）',
            c('input',{type:'file',accept:'.md,.txt,text/markdown,text/plain',
              'aria-label':'导入 Skill 文件',onChange:importCustomSkill})),
          c('button',{type:'button',className:'wg-prompt-toggle',
            'aria-expanded':skillPromptExpanded,'aria-controls':'wg-skill-prompt-content',
            onClick:()=>setSkillPromptExpanded(value=>!value)},
            '完整 Agent 精简提示词',skillPromptExpanded?'⌃':'⌄'),
          skillPromptExpanded?c('div',{id:'wg-skill-prompt-content',className:'wg-skill-prompt-content'},
            c('label',{className:'wg-prompt-label'},'完整 Agent 精简提示词',
              c('textarea',{value:customPrompt,onChange:e=>setCustomPrompt(e.target.value),
                maxLength:12000,rows:10,'aria-label':'自定义 Agent 精简提示词'})),
            c('div',{className:'wg-skill-actions'},
              c(Button,{onClick:()=>restoreDefaultSkillPrompt('custom'),
                disabled:busy||!advisoryStatus?.skillPromptDefaults?.customPrompt},'还原默认提示词'),
              c(Button,{onClick:()=>saveSkillSettings(),disabled:busy},'保存 Skill 与提示词'))):null):
        skillMode==='embedded'?c('div',{className:'wg-skill-editors'},
          c('div',{className:'wg-embedded-info'},
            c('strong',null,'内置完整规范（只读）'),
            c('p',null,'Semantic Refactor · 16 个文件　/　Forensic Prune · 8 个文件')),
          c('button',{type:'button',className:'wg-prompt-toggle',
            'aria-expanded':skillPromptExpanded,'aria-controls':'wg-skill-prompt-content',
            onClick:()=>setSkillPromptExpanded(value=>!value)},
            '完整 Agent 精简提示词',skillPromptExpanded?'⌃':'⌄'),
          skillPromptExpanded?c('div',{id:'wg-skill-prompt-content',className:'wg-skill-prompt-content'},
            c('label',{className:'wg-prompt-label'},'完整 Agent 精简提示词'),
            c('textarea',{value:embeddedPrompt,onChange:e=>setEmbeddedPrompt(e.target.value),
              maxLength:12000,rows:10,'aria-label':'内置 Skill Agent 精简提示词'}),
            c('div',{className:'wg-skill-actions'},
              c(Button,{onClick:()=>restoreDefaultSkillPrompt('embedded'),
                disabled:busy||!advisoryStatus?.skillPromptDefaults?.embeddedPrompt},'还原默认提示词'),
              c(Button,{onClick:()=>saveSkillSettings(),disabled:busy},'保存提示词'))):null):
        c('p',{className:'wg-parameter-note'},'关闭 Skill 后不附加精简规范；选定的容量提示仍可以发送基础建议。'),
        skillMode!=='off'?c('p',{className:'wg-parameter-note'},
          '支持 {{file}}、{{limit}}、{{count}}、{{warningPercent}}、{{targetPercent}}、{{triggerPercent}}、{{targetUsagePercent}}、{{targetCount}}、{{requiredReduction}}、{{trigger}}。原始内置规范及物理删除权限不可通过提示词修改。'):null
      ):null
    ):null;
   const limitEditor=active?c('div',{className:'wg-card wg-editor-card'},
     c('h3',null,'单文件字符上限'),
     isRoot?renderLimitRow({label:'工作区默认单文件上限',value:workspaceLimit,onChange:setWorkspaceLimit,
       onSave:()=>saveLimit('workspace')}):
     active.type==='folder'?renderLimitRow({label:'目录单文件上限 · '+directoryPath,value:directoryLimit,
       onChange:setDirectoryLimit,onSave:()=>saveLimit('directory'),inherit:true,source:inheritedFrom}):
     renderLimitRow({label:'单文件上限 · '+filePath,value:fileLimit,
       onChange:setFileLimit,onSave:()=>saveLimit('file'),inherit:true,source:inheritedFrom})
   ):null;
   return c('main',{className:'wg-root'},c('div',{className:'wg-shell'},
    c('header',{className:'wg-header'},
      c('div',null,c('h1',null,'Workspace Governance'),c('p',{className:'wg-header-subtitle'},'Markdown 文档容量与 Agent 原位维护'))
    ),
    c('section',{className:'wg-workspaces'},
      c('select',{value:id,onChange:e=>setId(e.target.value),'aria-label':'选择工作区'},
        c('option',{value:''},'选择工作区'),...workspaces.map(x=>c('option',{key:x.id,value:x.id},x.name+' · '+x.root))),
      c('span',{className:'wg-native-label',title:nativeRoot||'当前无明确项目工作区'},
       nativeRoot?(current&&canonicalRoot(current.root)===canonicalRoot(nativeRoot)?'已跟随项目工作区':'手动查看其他工作区'):'未检测到活动项目'),
      c(Button,{onClick:()=>setManualAdd(value=>!value)},manualAdd?'收起':'手动添加'),
      c(Button,{onClick:removeWorkspace,disabled:busy||!id,title:'停止监控并禁止自动重新注册；保留工作区阈值与文件'},'停止跟踪'),
      c(Button,{onClick:()=>action(()=>refresh(true)),disabled:busy||!id},'重新扫描')
    ),
    manualAdd?c('section',{className:'wg-workspaces wg-manual'},
      c('input',{value:pathDraft,onChange:e=>setPathDraft(e.target.value),placeholder:'工作区绝对目录路径','aria-label':'工作区路径'}),
      c(Button,{onClick:addWorkspace,disabled:busy},'注册工作区')):null,
    notice?c('div',{className:'wg-notice',role:'status'},notice):null,
    trackingPaused?c('div',{className:'wg-notice wg-paused-notice',role:'status'},
      c('span',null,'当前 DSH 工作区已停止跟踪。插件不会自动重新注册或扫描该目录。'),
      nativeRoot?c(Button,{onClick:resumeNativeWorkspace,disabled:busy},'恢复跟踪'):null):null,
    c('nav',{className:'wg-tabs','aria-label':'文档容量分类'},
      ...[['tree','目录'],['warning','预警'],['overflow','超限'],['overrides','专项'],['logs','日志']].map(([value,label])=>
        c('button',{key:value,className:tab===value?'active':'',onClick:()=>{setTab(value);setExpanded({'':true});setMapFrameRequest(0);setPreview(null);setSelected('');}},label))
    ),
    tab==='logs'?logPanel:c('div',{className:'wg-columns'},
      c('aside',{className:'wg-card wg-mindmap-card'},
        c('div',{className:'wg-card-top'},c('h2',null,tab==='tree'?'▤ Markdown':tab==='warning'?'预警文档':tab==='overflow'?'超限文档':'专项文档'),usableScan?.truncated?c('span',{className:'wg-tree-warning'},'扫描不完整'):null),
        !usableScan?c('div',{className:'wg-empty-docs'},'正在扫描工作区…'):
          usableScan.scanned===0?c('div',{className:'wg-empty-docs'},'此工作区暂无 Markdown 文档'):
          mapLayout.matches===0?c('div',{className:'wg-empty-docs'},tab==='overrides'?'暂无单独设置上限的目录或 Markdown 文件':'当前筛选无匹配 Markdown'):
          c(MindMap,{key:id+'|'+tab,layout:mapLayout,selected:relative,frameRequest:mapFrameRequest,
            referenceWidth:referenceLayout.width,
            onSelect:path=>setSelected(path),
            onToggle:(path,open)=>setExpanded(old=>({...old,[path]:!open})),
            onExpandAll:()=>{
              setExpanded(directoryExpansionMap(usableScan.tree,true));
              setMapFrameRequest(value=>value+1);
            },
            onCollapseAll:()=>setExpanded(directoryExpansionMap(usableScan.tree,false))})
      ),
      c('section',{className:'wg-details'},
        !usableScan?c('div',{className:'wg-card wg-empty'},id?'正在扫描工作区…':'请先注册工作区'):
        !active?c('div',{className:'wg-card wg-empty'},tab==='overrides'?'暂无单独设置上限的目录或 Markdown 文件':'当前分类暂无匹配文档'):
        c('div',{className:'wg-detail-layout'},
          c('div',{className:'wg-card wg-capacity-card'},
            c('div',{className:'wg-card-top'},
              c('h3',null,active.type==='file'?'文件容量':'目录文档容量'),
              capacity.label?c('span',{className:'wg-state '+capacity.kind,role:'status'},capacity.label):null),
            c('div',{className:'wg-capacity-snapshot'},
              c('strong',null,(active.chars||0).toLocaleString(),
                displayLimit===null?null:c('span',null,' / ',displayLimit.toLocaleString())),
              c('small',null,active.type==='file'?'已扫描字符 / 单文件上限':
                capacity.hasBudget?'后代 Markdown 字符总数 / 目录累计预算':'后代 Markdown 字符总数')),
            usageRate===null?null:c('div',{className:'wg-capacity-meter'},
              c('div',{className:'wg-progress',role:'progressbar','aria-label':'字符预算使用率',
                'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':Math.min(100,Math.max(0,usageRate))},
                c('div',{className:'wg-progress-fill '+capacity.kind,style:{width:Math.min(100,Math.max(0,usageRate))+'%'}})),
              c('div',{className:'wg-capacity-percent '+capacity.kind},
                c('span',null,'容量使用率'),c('strong',null,usageRate.toFixed(1)+'%'))),
            usageRate!==null&&usageRate>100?c('p',{className:'wg-capacity-excess'},
              '超出 '+(active.chars-displayLimit).toLocaleString()+' 字符。插件只进行提示，不限制写入。'):
              capacity.description?c('p',{className:'wg-capacity-message '+capacity.kind},capacity.description):null,
            active.type==='folder'?c('div',{className:'wg-capacity-meta'},
              c('span',null,'包含 ',(active.files||0).toLocaleString(),' 份 Markdown'),
              c('span',null,'目录单文件规则 ',isRoot?(current?.policy?.defaultFileLimit??2400).toLocaleString():
                (rule.fileLimit===undefined?'继承自'+inheritedFrom:Number(rule.fileLimit).toLocaleString()))):null,
            active.type==='file'?c('div',{className:'wg-capacity-meta'},c('span',null,'限额来源：'+sourceLabel)):null,
            tab==='overrides'?c('p',{className:'wg-parameter-note'},'仅筛选显式设置单文件上限的目录和文件；其上级目录仅用于导航。'):null,
            canReviewDuplicates?c('div',{className:'wg-capacity-action'},
              c(Button,{onClick:()=>getPreview(active),disabled:busy},'检查 '+active.duplicates+' 处重复段落')):null
          ),
          limitEditor,
          preview&&preview.path===active.path?c('div',{className:'wg-card wg-preview-card'},
            c('h3',null,'压缩差异审查'),
            c('p',null,'候选精简字符：'+preview.proposal.reducedCodepoints),
            ...preview.proposal.removed.map((item,i)=>c('div',{className:'wg-preview',key:i},
              c('small',null,'第 '+item.line+' 行'),c('p',null,item.text))),
            c(Button,{onClick:applySuggestion,disabled:busy||preview.protected||!preview.proposal.removed.length},'确认压缩'),
            lastApply?c(Button,{onClick:restoreSuggestion,disabled:busy},'撤销压缩'):null
          ):null
        )
      )    ),
     maintenancePanel,
     detectionPanel,
     skillPanel   ));
  }
  function apply(ctx){
   ctx.effect(()=>{
    const style=document.createElement('style');style.dataset.dshWorkspaceGovernance='v1';
    style.textContent=[
      '.wg-root{height:100%;overflow:auto;background:#f6f8fb;color:#233141;font:14px/1.55 system-ui,sans-serif;padding:24px;box-sizing:border-box}',
      '.wg-root *{box-sizing:border-box}.wg-shell{max-width:1600px;margin:0 auto}.wg-header,.wg-workspaces,.wg-card-top{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.wg-header h1{font-size:27px;line-height:1.25;margin:3px 0;font-weight:700}.wg-header p{margin:5px 0 18px;color:#657182}',
      '.wg-workspaces{justify-content:flex-start;flex-wrap:wrap;margin:8px 0 14px}.wg-workspaces select{flex:1;min-width:220px}.wg-workspaces input{flex:1;min-width:220px}.wg-manual{margin-top:-8px}.wg-native-label{font-size:12px;color:#6b8292;white-space:nowrap}.wg-empty-docs{padding:22px 10px;text-align:center;color:#8392a1;font-size:12px}',
      '.wg-root input,.wg-root select{border:1px solid #d9e0e8;border-radius:9px;background:#fff;padding:10px 12px;color:#243247;min-height:40px;font:inherit;min-width:0}',
      '.wg-button{border:1px solid #d8e0e7;background:#fff;color:#344357;font:inherit;min-height:38px;padding:7px 13px;border-radius:9px;cursor:pointer;white-space:nowrap}.wg-button:hover{background:#eef2f7}.wg-button:disabled{opacity:.45;cursor:not-allowed}',
      '.wg-tabs{display:flex;gap:8px;margin:0 0 14px;border-bottom:1px solid #dce3ea}.wg-tabs button{padding:11px 14px;cursor:pointer;border:0;border-bottom:2px solid transparent;background:transparent;color:#718092;font:inherit}.wg-tabs button.active{color:#314d65;font-weight:700;border-bottom-color:#52758e}',
      '.wg-columns{display:grid;grid-template-columns:minmax(220px,34%) minmax(320px,1fr);align-items:start;gap:14px}.wg-card{background:#fff;border:1px solid #e0e6ed;border-radius:16px;padding:18px;margin-bottom:14px;min-width:0}',
      '.wg-card h2{font-size:18px;margin:0 0 12px}.wg-card h3{font-size:15px;margin:0 0 15px}.wg-card-top{margin-bottom:15px}.wg-card-top h2,.wg-card-top h3{margin:0}.wg-card-top span{font-size:12px;color:#8794a3}',
      '.wg-parameter-note{font-size:12px;color:#7e8b99;line-height:1.6;margin:12px 0 0}',
      '.wg-remediation-queue{border-top:1px solid #e9eef3;padding-top:14px;display:grid;gap:8px}.wg-remediation-queue>strong{font-size:13px;font-weight:650}.wg-remediation-queue>p{margin:0}.wg-remediation-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;border:1px solid #e5ebf1;border-radius:10px;background:#f9fbfd;min-width:0}.wg-remediation-item>div:first-child{min-width:0;overflow-wrap:anywhere}.wg-remediation-item strong{font-size:12px;font-weight:600}.wg-remediation-item small{display:block;font-size:11px;color:#6c7b8b;margin-top:3px}.wg-remediation-delivery{font-size:11px;color:#657789;white-space:nowrap}@media(max-width:760px){.wg-remediation-item{flex-direction:column;align-items:stretch}.wg-remediation-actions{justify-content:flex-start}}',
      '.wg-progress{height:8px;background:#e9eef2;border-radius:50px;overflow:hidden;flex:1;min-width:0}.wg-progress-fill{height:100%;border-radius:50px;transition:width .22s ease,background .22s ease}.wg-progress-fill.normal{background:#72a99b}.wg-progress-fill.warning{background:#d2a052}.wg-progress-fill.overlimit{background:#c86f6b}',
      '.wg-notice{padding:9px 12px;background:#e9f1f7;color:#355a71;border-radius:9px;margin:8px 0}.wg-preview{border:1px solid #e1e6eb;border-radius:9px;padding:12px;margin:8px 0;overflow-wrap:anywhere}.wg-preview small{color:#8b97a5;font-size:12px}',
      '.wg-limit-row{display:flex;align-items:end;gap:12px;padding:12px 0;border-bottom:1px solid #eef0f2}.wg-limit-row:last-child{border-bottom:0}.wg-limit-row label{flex:1;display:flex;flex-direction:column;gap:7px;color:#59636e;font-size:12px;min-width:0}.wg-limit-row input{width:100%}.wg-limit-row button{flex-shrink:0}.wg-editor-card h3{margin:0 0 6px}',
      '.wg-trigger-settings{display:grid;gap:13px}.wg-trigger-settings h3{margin:0 0 4px}.wg-trigger-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px;border-top:1px solid #eef0f2;padding-top:11px}.wg-trigger-row:first-of-type{border-top:0}.wg-trigger-row>div{flex:1}.wg-trigger-row strong{font-size:13px}.wg-trigger-row p{font-size:12px;color:#7c8790;margin:2px 0 0}.wg-trigger-row label{display:flex;gap:10px;align-items:center;flex:1;font-size:13px}.wg-trigger-row input{max-width:100px;min-height:36px}.wg-trigger-row .wg-button{margin-left:auto}.wg-tabs{justify-content:flex-start}.wg-tabs button{min-width:76px}',
      '.wg-mode-options{display:grid;gap:0;border-top:1px solid #eef0f2}.wg-mode-option{display:flex;align-items:center;gap:14px;padding:12px 1px;cursor:pointer;border-bottom:1px solid #eef0f2}.wg-mode-option:last-child{border-bottom:0}.wg-mode-option input[type=radio]{flex-shrink:0;accent-color:#1e293b;width:18px;height:18px;cursor:pointer}.wg-mode-option span{display:flex;flex-direction:column;gap:3px}.wg-mode-option strong{font-size:13px}.wg-mode-option small{font-size:12px;color:#7c8790}.wg-mode-option:has(input:disabled){opacity:.55;cursor:not-allowed}',
      '.wg-collapse-header{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;border:0;background:none;color:inherit;padding:0;text-align:left;cursor:pointer;font:inherit}.wg-collapse-header>span:first-child{display:flex;flex-direction:column;gap:2px}.wg-collapse-header strong{font-size:17px;font-weight:650}.wg-collapse-header small{font-size:12px;color:#79818a}.wg-collapse-chevron{font-size:18px;color:#7d8994}.wg-advisory-area>.wg-trigger-settings,.wg-skill-body{padding-top:15px}.wg-skill-card{margin-top:0}.wg-detection-card .wg-remediation-queue{margin-top:15px}.wg-skill-editors{display:grid;gap:13px;margin-top:17px;padding-top:15px;border-top:1px solid #edf0f4}.wg-skill-editors label{display:grid;gap:8px;font-size:12px;color:#566575;font-weight:600}.wg-root textarea{width:100%;min-height:130px;resize:vertical;border:1px solid #d9e0e8;border-radius:11px;padding:11px 12px;color:#243247;background:#fff;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}.wg-root textarea:focus-visible{outline:2px solid #4679b0;outline-offset:2px}.wg-skill-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:nowrap}.wg-skill-actions .wg-button{white-space:nowrap;flex-shrink:0}.wg-skill-prompt-content{display:grid;gap:10px}.wg-embedded-info{padding:12px 14px;background:#f5f6f8;border-radius:10px}.wg-embedded-info strong{font-size:13px}.wg-embedded-info p{font-size:12px;color:#7c8790;margin:4px 0 0}.wg-prompt-toggle{display:flex;justify-content:space-between;gap:10px;width:100%;border:0;padding:4px 0;background:transparent;text-align:left;color:#3b4755;cursor:pointer;font:inherit;font-size:13px;font-weight:600}.wg-prompt-label{margin:8px 0}.wg-mode-options{margin-top:4px}',
      '.wg-mindmap-card{background:#fff!important;border:1px solid #e2e4e9!important;border-radius:20px!important;padding:14px!important;box-shadow:0 6px 20px #203b5910,0 1px 3px #203b5910!important;max-height:none!important;min-height:0!important;height:100%!important;display:flex;flex-direction:column;overflow:hidden;margin-bottom:0!important}.wg-mindmap-card .wg-card-top{padding:0!important;margin:0 0 8px!important}.wg-columns{grid-template-columns:repeat(2,minmax(0,1fr))!important;align-items:stretch!important;gap:16px!important}.wg-map-shell{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;border:1px solid #eceff5;border-radius:13px;background:linear-gradient(180deg,#fcfdff,#f8faff)}.wg-map-shell:fullscreen,.wg-map-shell.wg-map-fullscreen{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;z-index:2147483000!important;background:#fff!important}.wg-map-shell:fullscreen .wg-map-viewport,.wg-map-shell.wg-map-fullscreen .wg-map-viewport{height:100%;min-height:0;flex:1}.wg-map-controls{position:absolute;right:10px;bottom:10px;z-index:5;display:flex;align-items:center;gap:2px;padding:3px;border:1px solid #e2e8f0;border-radius:9px;background:rgba(255,255,255,.95);box-shadow:0 2px 8px #28456616}.wg-map-controls button{display:flex;align-items:center;justify-content:center;width:26px;height:26px;min-width:26px;border:0;border-radius:6px;background:transparent;color:#41566d;cursor:pointer;font:600 15px system-ui,sans-serif}.wg-map-controls button:hover{background:#eef3fa}.wg-map-viewport{position:relative;flex:1;min-height:260px;overflow:hidden;cursor:grab;touch-action:none;user-select:none;background-image:radial-gradient(#dbe4f4 .65px,transparent .65px);background-size:22px 22px}.wg-map-viewport:active{cursor:grabbing}.wg-map-stage{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}.wg-map-edges{position:absolute;top:0;left:0;fill:none;stroke:#7098e3;stroke-width:1.6;stroke-linecap:round;shape-rendering:geometricPrecision;pointer-events:none}.wg-map-item{position:absolute}.wg-map-node{position:relative;display:flex;align-items:center;gap:5px;width:100%;height:100%;border-radius:8px;outline:0;background:#fff;border:1px solid #cfdaf2;text-rendering:optimizeLegibility;color:#293a50;overflow:hidden;box-shadow:0 2px 5px #1e3a5c18;padding:0 9px;cursor:pointer;user-select:none;text-align:left;font:600 12px/1.2 system-ui,sans-serif}.wg-map-node:hover{border-color:#517dff;box-shadow:0 2px 8px #497ef027}.wg-map-node.selected{outline:2px solid #3971ff;outline-offset:2px}.wg-map-root{background:#fff!important;color:#293a50!important;border-color:#cfdaf2!important;font-size:13px;justify-content:center}.wg-map-folder{background:#f7f9fc;border-color:#dfe6ef}.wg-map-label{position:relative;z-index:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.wg-map-percent{position:relative;z-index:1;font-size:10px;flex-shrink:0;font-variant-numeric:tabular-nums}.wg-map-folder-count{position:relative;z-index:1;color:#8190a3;background:#e8edf4;border-radius:5px;min-width:18px;padding:2px 4px;text-align:center;font:600 10px/1.1 system-ui,sans-serif;flex-shrink:0}.wg-map-file-fill{position:absolute;z-index:0;top:0;bottom:0;left:0;border-radius:7px 0 0 7px;pointer-events:none;transition:width .2s ease}.wg-map-file-fill.normal{background:#ccebdc}.wg-map-file-fill.warning{background:#f8e0a5}.wg-map-file-fill.overlimit{background:#f5c4c1}.wg-map-file-fill.unverified{background:#e7ebf0}.wg-map-file.warning{border-color:#d8b46d}.wg-map-file.overlimit{border-color:#d97a74}.wg-map-file.unverified{border-style:dashed}.wg-root .wg-map-node:focus-visible,.wg-root .wg-map-controls button:focus-visible{outline:3px solid #346eff;outline-offset:3px}',
      '@media(max-width:920px){.wg-columns{grid-template-columns:1fr!important}.wg-mindmap-card{height:420px!important;min-height:320px!important}}',
      '@media(max-width:560px){.wg-mindmap-card{padding:12px!important}.wg-map-controls{right:6px;bottom:6px}}',
      '.wg-root button:focus-visible,.wg-root input:focus-visible,.wg-root select:focus-visible{outline:2px solid #4679b0;outline-offset:2px}',
      '.wg-log-card{padding:20px 22px;min-width:0}.wg-log-count{font-size:12px;color:#8a93a0}.wg-log-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px}.wg-log-summary>div{border:1px solid #e6eaef;border-radius:12px;background:#fafbfd;padding:12px;display:flex;flex-direction:column;gap:6px;min-width:0}.wg-log-summary small{font-size:12px;color:#8290a0}.wg-log-summary strong{font-size:19px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.wg-log-list{display:grid;gap:10px;margin-top:15px}.wg-log-event{border:1px solid #e2e7ee;background:#fff;border-radius:12px;padding:13px 15px;display:grid;gap:8px;min-width:0}.wg-log-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.wg-log-status{font-size:12px;color:#395a72}.wg-log-status.verified,.wg-log-status.compressed{color:#317c63}.wg-log-status.blocked,.wg-log-status.warning,.wg-log-status.conflict{color:#b56b35}.wg-log-status.review{color:#a66458}.wg-log-heading time{font-size:11px;color:#8493a3}.wg-log-path{font-size:13px;font-weight:650;overflow-wrap:anywhere}.wg-log-metrics{display:flex;align-items:center;gap:15px;flex-wrap:wrap;font-size:12px;font-variant-numeric:tabular-nums}.wg-log-metrics strong.reduced{color:#317c63}.wg-log-metrics strong.increased{color:#bb6744}.wg-log-unmeasured{font-size:12px;color:#8b96a4}.wg-log-detail{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:110px;overflow:auto;font-size:12px;color:#647385}.wg-log-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.wg-log-actions .wg-button{min-height:30px;padding:5px 10px;font-size:12px}',
      '@media(max-width:560px){.wg-log-card{padding:14px}.wg-log-summary{grid-template-columns:1fr}.wg-log-metrics{gap:8px}}',
      '.wg-capacity-card{padding:20px 22px}.wg-state{display:inline-flex;align-items:center;border-radius:20px;padding:3px 10px;font-size:11px;font-weight:650;background:#edf2f5;color:#587080;white-space:nowrap}.wg-card-top .wg-state.normal{background:#e9f2ec;color:#497361}.wg-card-top .wg-state.warning{background:#fbf0df;color:#987035}.wg-card-top .wg-state.overlimit{background:#faece8;color:#a75e4f}.wg-card-top .wg-state.unverified,.wg-card-top .wg-state.idle{background:#edf0f4;color:#657586}',
      '.wg-capacity-snapshot{display:flex;flex-direction:column;gap:4px;padding:3px 0 14px}.wg-capacity-snapshot strong{font-size:30px;font-weight:650;line-height:1.4;letter-spacing:-.035em;font-variant-numeric:tabular-nums}.wg-capacity-snapshot strong span{color:#83919f;font-weight:450}.wg-capacity-snapshot small{font-size:12px;color:#8291a0}.wg-capacity-meter{display:flex;align-items:center;gap:14px;margin-bottom:16px}.wg-capacity-percent{font-size:13px;font-weight:650;min-width:50px;text-align:right;font-variant-numeric:tabular-nums}.wg-capacity-percent.normal{color:#528c7e}.wg-capacity-percent.warning{color:#a77a35}.wg-capacity-percent.overlimit{color:#ae605d}.wg-capacity-message{font-size:12px;line-height:1.65;margin:0 0 12px;color:#677888}.wg-capacity-message.warning{color:#977339}.wg-capacity-message.overlimit{color:#a3665a}.wg-capacity-excess{margin:0 0 12px;color:#b56059;font-size:12px;font-weight:650}.wg-capacity-meta{display:flex;flex-wrap:wrap;gap:8px 20px;padding-top:12px;border-top:1px solid #eef1f4;color:#718192;font-size:12px}.wg-capacity-action{margin-top:14px;display:flex;justify-content:flex-end}',
      '.wg-maintenance-card{padding:18px 22px}.wg-maintenance-toggle{display:flex;align-items:center;gap:9px;width:100%;padding:13px 2px 1px;border:0;border-top:1px solid #edf0f4;background:none;color:#405269;cursor:pointer;text-align:left;font:inherit;font-size:12px}.wg-maintenance-chevron{font-size:17px;color:#8a9aaa}.wg-maintenance-list{padding:12px 0 0}.wg-maintenance-event{border-bottom:1px solid #edf1f4;padding:9px 0}.wg-maintenance-event>div{display:flex;justify-content:space-between;gap:12px}.wg-maintenance-event strong{font-size:12px}.wg-maintenance-event time,.wg-maintenance-event small{font-size:11px;color:#8694a1}.wg-maintenance-event p{font-size:12px;color:#5a6878;margin:4px 0}',
      '@media(max-width:920px){.wg-columns{grid-template-columns:1fr}}',
      '@media(max-width:560px){.wg-root{padding:12px}.wg-tabs{overflow:auto}.wg-tabs button{white-space:nowrap}.wg-capacity-snapshot strong{font-size:26px}.wg-card-top{align-items:flex-start}.wg-capacity-meta{gap:6px 14px}}',
      '.wg-root{background:#fafafa;color:#181b20;padding:18px 22px;font-size:14px}.wg-shell{max-width:1480px}.wg-header{margin-bottom:22px;align-items:flex-start}.wg-header h1{font-size:28px;letter-spacing:-.035em;margin:0 0 3px;font-weight:700}.wg-header-subtitle{font-size:14px;color:#777f88;margin:0}',
      '.wg-columns{grid-template-columns:minmax(230px,1fr) minmax(355px,1fr);gap:28px;align-items:start}.wg-mindmap-card h2{font-size:21px;font-weight:650;margin:0;letter-spacing:-.02em}',
      '.wg-card{border:1px solid #e2e3e5;border-radius:20px;box-shadow:none;background:#fff}.wg-detail-layout{min-width:0}.wg-detail-layout>.wg-card{margin-bottom:0}.wg-capacity-card{min-height:360px;padding:23px 24px}.wg-card-top{margin-bottom:23px}.wg-capacity-card .wg-card-top h3{font-size:17px;font-weight:650;margin:0}.wg-state{font-size:12px}.wg-state.overlimit{background:#fbe6e5!important;color:#cd3e38!important}.wg-capacity-snapshot{padding:0 0 20px}.wg-capacity-snapshot strong{font-size:32px;color:#191b1e;letter-spacing:-.04em}.wg-capacity-snapshot strong span{color:#81909b}.wg-capacity-snapshot small{font-size:13px;color:#737d86}',
      '.wg-capacity-meter{display:flex;flex-direction:column;align-items:stretch;gap:11px;margin-bottom:18px}.wg-progress{flex:none;width:100%;height:10px;background:#eef0f1}.wg-capacity-percent{display:flex;justify-content:space-between;align-items:center;text-align:left;width:100%;font-size:13px;color:#454d54}.wg-capacity-percent span{color:#7a8187;font-weight:450}.wg-capacity-percent strong{font-size:15px;font-weight:600}.wg-capacity-excess{font-size:13px;color:#cf4641;font-weight:500;line-height:1.6;margin-top:8px}.wg-capacity-message{margin-top:8px}.wg-capacity-meta{margin-top:15px}.wg-editor-card{margin-top:14px}',
      '.wg-maintenance-card{margin-top:19px;padding:21px 22px;border-radius:21px}.wg-maintenance-toggle{margin-top:17px;padding-top:17px;font-size:14px;color:#323941}.wg-maintenance-event p{font-size:12px}.wg-root .wg-tabs{margin-bottom:20px}',
      '@media(max-width:920px){.wg-columns{grid-template-columns:1fr}.wg-capacity-card{min-height:280px}.wg-header h1{font-size:24px}}',
      '@media(max-width:560px){.wg-root{padding:14px}.wg-columns{gap:16px}.wg-capacity-card{padding:18px}.wg-capacity-snapshot strong{font-size:26px}.wg-card-top{align-items:center}.wg-maintenance-card{padding:16px}}'
    ].join('\n');document.head.appendChild(style);return()=>style.remove();
   },'workspace governance styles');
   ctx.inject(['slots','sessions','workspaces'],scope=>{
    scope.slots.inject('main',()=>scope.slots.register({name:'main',key:'workspace-governance'},props=>c(Page,{...props,services:scope})));
    scope.slots.inject('sidebar.panellist',()=>scope.slots.register(
      {name:'sidebar.panellist',id:'workspace-governance',order:77,label:'文档治理'},
      ()=>c('span',{style:{fontSize:18,lineHeight:1},'aria-hidden':true},'▦')
    ));
   });
  }
  return {apply,inject:['slots','sessions','workspaces'],nativeWorkspaceRoot,ensureNativeWorkspace,capacityStatus,mindMapTopology,mindMapFrame,mindMapRootView,mindMapVisibleNodes,directoryExpansionMap,MindMap};
 }
});
