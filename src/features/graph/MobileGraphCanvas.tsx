import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { GraphSeed, GraphViewState } from './core/graphTypes';
import { fitGraphCamera, wheelCamera, type Camera } from './core/graphCamera';
import { filteredGraph, normalizeGraphView, graphForceParameters, isMissingGraphNode, graphNodeRadiusForLinks } from './core/graphSemantics';
import { graphSeedPositions, graphScreenRadius } from './core/graphSpatial';
import { graphLabelDetail, graphLabelFocusAlpha, updateGraphLabels, type GraphLabelState } from './core/graphPresentation';
import { packGraphPhysicsState, updateGraphPhysicsState, type GraphPhysicsNode, type GraphPhysicsStepRequest, type GraphPhysicsStepResponse } from './core/graphPhysics';
import { buildGraphPlaybackPlan, graphPlaybackNodeVisual, graphPlaybackEdgeProgress, graphPlaybackEdgeKey, type GraphPlaybackPlan } from './core/graphPlayback';
import { graphNodeFill, graphEdgePaint, graphArrowTriangle, graphPlaybackCameraTarget } from './core/graphRenderer';
import { graphCameraSignature, graphActivationTransition } from './mobileGraphLifecycle';
import { pinchCamera, graphPoint, graphPixelRatio, type TouchPoint } from './mobileGraphGestures';

export type MobileGraphCanvasHandle = {reset():void;fit():void;zoomBy(factor:number):void;capture():Promise<Blob>};
export type MobileGraphCanvasProps = {
 seed:GraphSeed;settings:GraphViewState;selectedKey?:string|null;scopeKeys?:Set<string>|null;
 camera?:Camera;paused?:boolean;reducedMotion?:boolean;playback?:{playing:boolean;progress?:number};
 onSelect(key:string|null):void;onOpen(key:string):void;onCameraChange?(camera:Camera):void;
 onPlaybackProgress?(progress:number):void;onReady?():void;
};
type Runtime = {reset():void;update():void;fit():void;zoomBy(factor:number):void;capture():Promise<Blob>};
/** The shared desktop solver runs only in a worker. All data stays on this device. */
export const MobileGraphCanvas = forwardRef<MobileGraphCanvasHandle,MobileGraphCanvasProps>(function MobileGraphCanvas(props,ref) {
 const canvasRef=useRef<HTMLCanvasElement>(null), latest=useRef(props), runtime=useRef<Runtime|null>(null);
 latest.current=props;
 const [warning,setWarning]=useState('');
 useImperativeHandle(ref,()=>({reset:()=>runtime.current?.reset(),fit:()=>runtime.current?.fit(),zoomBy:f=>runtime.current?.zoomBy(f),capture:()=>runtime.current?.capture()??Promise.reject(new Error('图谱尚未就绪'))}),[]);
 useEffect(()=>{runtime.current?.update();},[props.seed,props.settings,props.selectedKey,props.scopeKeys,props.paused,props.playback?.playing,props.playback?.progress,props.camera,props.reducedMotion]);
 useEffect(()=>{
  const element=canvasRef.current;if(!element)return;const canvas:HTMLCanvasElement=element;
  const ctx=canvas.getContext('2d');if(!ctx){setWarning('当前 WebView 不支持画布，请更新系统 WebView。');return;}
  let disposed=false,raf=0,width=1,height=1,dpr=1,dirty=true,alpha=1,generation=0,mutation=0,revision=0,requestId=0,busy=false,sendTopology=true;
  const initialCamera=normalizeGraphView(latest.current.camera);let camera:Camera={scale:initialCamera.scale,panX:initialCamera.panX,panY:initialCamera.panY},explicitCamera=!!latest.current.camera;
  let settings=normalizeGraphView(latest.current.settings),scene=filteredGraph(latest.current.seed,settings),nodes:GraphPhysicsNode[]=[],byId=new Map<number,GraphPhysicsNode>();
  let oldSeed:GraphSeed|null=null,oldPhysics='',oldActive='',solverActive='',externalCamera=graphCameraSignature(latest.current.camera),worker:Worker|null=null,dragId:number|null=null,hoverId:number|null=null;
  let timeline:GraphPlaybackPlan|null=null,playing=false,elapsed=0,lastFrame=0,lastProgress=0,finished=false,cameraFollow=true,lastSeek:number|undefined;
  const labelMemory=new Map<number,GraphLabelState>(),metrics=new Map<string,number>();
  const pointers=new Map<number,TouchPoint>();let gesture:{start:TouchPoint;last:TouchPoint;key:string|null;moved:boolean}|null=null,lastTap:{key:string;time:number}|null=null;
  let hits:Array<{key:string;id:number;x:number;y:number;r:number}>=[];
  const wake=()=>{dirty=true;if(!raf&&!disposed&&!document.hidden&&!latest.current.paused)raf=requestAnimationFrame(frame);};
  const persistCamera=()=>{latest.current.onCameraChange?.({...camera});};
  const notifyCamera=()=>{cameraFollow=false;persistCamera();wake();};
  const reduced=()=>!!latest.current.reducedMotion||canvas.closest('.st-app')?.getAttribute('data-reduced')==='true'||(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  const cancelGesture=()=>{const ids=[...pointers.keys()];pointers.clear();gesture=null;lastTap=null;dragId=null;hoverId=null;mutation++;for(const id of ids)try{if(canvas.hasPointerCapture?.(id))canvas.releasePointerCapture(id);}catch{/* Released by WebView already. */}};
  const selectScene=()=>{const selected=latest.current.seed.nodes.find(n=>n.key===latest.current.selectedKey)?.id??null;scene=filteredGraph(latest.current.seed,settings,{nodeColor:getComputedStyle(canvas).getPropertyValue('--mg-graph-foreground').trim()||'#e7e9ee',scopeKeys:latest.current.scopeKeys,selectedId:selected,hoveredId:hoverId,draggingId:dragId});};
  const fit=()=>{const fitted=fitGraphCamera(scene.renderedNodes.map(n=>byId.get(n.id)).filter((n):n is GraphPhysicsNode=>!!n),width,height);if(fitted){camera=fitted;explicitCamera=true;notifyCamera();}};
  const zoomBy=(factor:number)=>{if(!(factor>0&&Number.isFinite(factor)))return;camera=wheelCamera(camera,camera,{x:width/2,y:height/2},-Math.log(factor)/.0025);explicitCamera=true;notifyCamera();};
  function update(){
   const p=latest.current;settings=normalizeGraphView(p.settings);selectScene();
   if(p.paused){cancelGesture();selectScene();lastFrame=0;if(raf)cancelAnimationFrame(raf);raf=0;}
   if(graphCameraSignature(p.camera)!==externalCamera&&p.camera){externalCamera=graphCameraSignature(p.camera);const normalized=normalizeGraphView(p.camera);camera={scale:normalized.scale,panX:normalized.panX,panY:normalized.panY};explicitCamera=true;}
   const activeKey=scene.renderedNodes.map(n=>n.id).join(',');if(activeKey!==oldActive){oldActive=activeKey;alpha=1;mutation++;timeline=null;}
   const forceKey=JSON.stringify(graphForceParameters(settings));
   if(oldSeed!==p.seed){
    cancelGesture();selectScene();
    const positions=new Map((oldSeed?.nodes??[]).map(n=>[n.key,byId.get(n.id)]));
    const initial=graphSeedPositions(p.seed.nodes,p.seed.edges,width,height);
    nodes=scene.nodes.map(n=>{const prior=positions.get(n.key),pos=initial.get(n.id)!;return{id:n.id,x:prior?.x??pos.x,y:prior?.y??pos.y,vx:prior?.vx??0,vy:prior?.vy??0,r:n.r*settings.nodeSize/6};});
    byId=new Map(nodes.map(n=>[n.id,n]));oldSeed=p.seed;generation++;revision++;sendTopology=true;alpha=1;labelMemory.clear();metrics.clear();timeline=null;
    if(!explicitCamera)fit();
   }
   if(forceKey!==oldPhysics){oldPhysics=forceKey;alpha=1;mutation++;}
   let radiusChanged=false;for(const n of scene.nodes){const body=byId.get(n.id);if(body&&body.r!==n.r*settings.nodeSize/6){body.r=n.r*settings.nodeSize/6;radiusChanged=true;}}
   if(radiusChanged){revision++;sendTopology=true;alpha=1;}
   if(p.playback?.playing&&(!playing||!timeline)){timeline=buildGraphPlaybackPlan({nodes:scene.renderedNodes.map(n=>({...n,...byId.get(n.id)!})),edges:scene.renderedEdges.map(e=>({a:e.a.id,b:e.b.id})),startedAt:performance.now()});elapsed=0;finished=false;cameraFollow=!reduced();alpha=1;}
   if(playing&&!p.playback?.playing){persistCamera();alpha=1;mutation++;}
   playing=!!p.playback?.playing;
   if(!playing){timeline=null;finished=false;}
   if(timeline&&p.playback?.progress!==undefined&&p.playback.progress!==lastSeek)elapsed=Math.max(0,Math.min(1,p.playback.progress))*timeline.totalDuration;
   lastSeek=p.playback?.progress;wake();
  }
  function workerFailure(){if(disposed)return;worker?.terminate();worker=null;busy=false;setWarning('本机图谱布局线程不可用；已保留全部节点，可缩放、拖动和打开。请更新系统 WebView 后重试。');wake();}
  try{worker=new Worker(new URL('./core/graphPhysics.worker.ts',import.meta.url),{type:'module'});worker.onerror=workerFailure;worker.onmessage=(event:MessageEvent<GraphPhysicsStepResponse>)=>{
   busy=false;const result=event.data;if(disposed)return;
   if(result.generation===generation&&result.topologyRevision===revision&&result.mutationRevision===mutation){updateGraphPhysicsState(nodes,result.state);alpha=result.alpha;}
   wake();
  };}catch{workerFailure();}
  function requestStep(){
   const active=scene.renderedNodes.filter(n=>!timeline||(timeline.nodes.get(n.id)?.startAt??Infinity)<=elapsed).map(n=>n.id);
   const activation=graphActivationTransition(solverActive,active,alpha,mutation);solverActive=activation.key;alpha=activation.alpha;mutation=activation.revision;
   if(!worker||busy||alpha<.001||!nodes.length)return;
   const request:GraphPhysicsStepRequest={type:'step',requestId:++requestId,generation,mutationRevision:mutation,topologyRevision:revision,
    topology:sendTopology?{revision,nodeIds:Int32Array.from(nodes.map(n=>n.id)),radii:Float64Array.from(nodes.map(n=>n.r)),edgePairs:Int32Array.from(latest.current.seed.edges.flat())}:null,
    state:packGraphPhysicsState(nodes),activeNodeIds:Int32Array.from(active),parameters:{...graphForceParameters(settings,!!timeline),alpha,draggedNodeId:dragId,width,height}};
   busy=true;sendTopology=false;try{worker.postMessage(request,[request.state.buffer]);}catch{workerFailure();}
  }
  function frame(now:number){
   raf=0;if(disposed||document.hidden||latest.current.paused){lastFrame=0;return;}
   if(timeline&&!finished){elapsed+=lastFrame?Math.min(64,now-lastFrame):0;const progress=Math.min(1,elapsed/timeline.totalDuration);if(now-lastProgress>100||progress===1){lastProgress=now;latest.current.onPlaybackProgress?.(progress);}if(progress===1){finished=true;}dirty=true;}
   lastFrame=now;if(timeline&&cameraFollow&&!reduced()){const target=graphPlaybackCameraTarget(timeline,elapsed,scene.renderedNodes.map(n=>byId.get(n.id)!).filter(Boolean),width,height,1,camera);if(target)camera=target;}if(timeline&&finished&&dirty)persistCamera();if(dirty){draw();dirty=false;}requestStep();
   if(timeline&&!finished)raf=requestAnimationFrame(frame);
  }
  function draw(){
   if(!ctx)return;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.globalAlpha=1;
   const style=getComputedStyle(canvas);const background=style.getPropertyValue('--mg-graph-background').trim()||'#101216';const foreground=style.getPropertyValue('--mg-graph-foreground').trim()||'#e7e9ee';
   ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
   const visual=new Map<number,{x:number;y:number;r:number;alpha:number;progress:number}>();hits=[];
   const liveDegree=new Map<number,number>();if(timeline)for(const edge of scene.renderedEdges){const plan=timeline.edges.get(graphPlaybackEdgeKey(edge.a.id,edge.b.id));const progress=plan?graphPlaybackEdgeProgress(plan,elapsed):0;liveDegree.set(edge.a.id,(liveDegree.get(edge.a.id)||0)+progress);liveDegree.set(edge.b.id,(liveDegree.get(edge.b.id)||0)+progress);}
   for(const n of scene.renderedNodes){const body=byId.get(n.id);if(!body)continue;const plan=timeline?.nodes.get(n.id);const v=plan?graphPlaybackNodeVisual(plan,elapsed,body):{...body,scale:1,alpha:1,progress:1};if(!v)continue;visual.set(n.id,{x:v.x*camera.scale+camera.panX,y:v.y*camera.scale+camera.panY,r:graphScreenRadius(timeline?graphNodeRadiusForLinks(liveDegree.get(n.id)||0,isMissingGraphNode(n))*settings.nodeSize/6:body.r,camera.scale)*v.scale,alpha:v.alpha,progress:v.progress});}
   for(const e of scene.renderedEdges){const a=visual.get(e.a.id),b=visual.get(e.b.id);if(!a||!b)continue;const plan=timeline?.edges.get(graphPlaybackEdgeKey(e.a.id,e.b.id));const progress=plan?graphPlaybackEdgeProgress(plan,elapsed):1;if(progress<=0)continue;
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);if(length<1)continue;
    const paint=graphEdgePaint({kind:e.kind,scale:camera.scale,edgeWidth:settings.edgeWidth,relatedToFocus:e.relatedToFocus,dimmed:e.dimmed,missingEndpoint:isMissingGraphNode(e.a)||isMissingGraphNode(e.b),treeEdge:plan?.treeEdge??false,progress,fromAlpha:a.alpha,toAlpha:b.alpha});
    ctx.globalAlpha=paint.alpha;ctx.strokeStyle=e.relatedToFocus?'#a2b5ff':'#737b89';ctx.lineWidth=paint.width*camera.scale;ctx.beginPath();const from=plan?.treeEdge&&plan.fromId===e.b.id?b:a,to=from===a?b:a;ctx.moveTo(from.x,from.y);ctx.lineTo(from.x+(to.x-from.x)*progress,from.y+(to.y-from.y)*progress);ctx.stroke();
    if(settings.showArrows&&paint.arrows&&e.direction!=='undirected'){
     const arrow=(from:typeof a,to:typeof b)=>{const triangle=graphArrowTriangle(from.x/camera.scale,from.y/camera.scale,to.x/camera.scale,to.y/camera.scale,to.r/camera.scale,camera.scale);if(!triangle)return;ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();triangle.forEach((p,i)=>i?ctx.lineTo(p.x*camera.scale,p.y*camera.scale):ctx.moveTo(p.x*camera.scale,p.y*camera.scale));ctx.closePath();ctx.fill();};
     if(e.direction==='forward'||e.direction==='bidirectional')arrow(a,b);if(e.direction==='reverse'||e.direction==='bidirectional')arrow(b,a);
    }
   }
   const candidates=[];const labelDetail=graphLabelDetail(camera.scale,settings.labelReveal);const revealAlpha=(progress:number)=>{const t=Math.max(0,Math.min(1,(progress-.48)/(.9-.48)));return t*t*(3-2*t);};
   for(const n of [...scene.renderedNodes].sort((a,b)=>Number(a.id===scene.activeFocusId)-Number(b.id===scene.activeFocusId))){const v=visual.get(n.id);if(!v)continue;const focused=n.id===scene.activeFocusId;ctx.globalAlpha=v.alpha;ctx.fillStyle=graphNodeFill({color:n.color,background,accent:'#9caeff',focused,dimmed:n.dimmed,neighbor:scene.connectedIds.has(n.id),document:n.type==='note'});ctx.beginPath();ctx.arc(v.x,v.y,v.r,0,Math.PI*2);ctx.fill();
    if(focused){ctx.globalAlpha=v.alpha;ctx.strokeStyle='#9caeff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(v.x,v.y,v.r+4,0,Math.PI*2);ctx.stroke();}
    if(v.x>=-24&&v.x<=width+24&&v.y>=-24&&v.y<=height+24)hits.push({key:n.key,id:n.id,x:v.x,y:v.y,r:Math.max(18,v.r+7)});
    if(settings.showLabels)candidates.push({id:n.id,text:n.label,x:v.x,y:v.y,radius:v.r,priority:focused?2:scene.connectedIds.has(n.id)?1:0,degree:n.links,alpha:graphLabelFocusAlpha(labelDetail.alpha,focused,scene.connectedIds.has(n.id),scene.activeFocusId!==null)*revealAlpha(v.progress),fontSize:labelDetail.fontSize});
   }
   ctx.font='12px system-ui, sans-serif';const labels=updateGraphLabels(candidates,width,height,text=>{let value=metrics.get(text);if(value===undefined){value=ctx.measureText(text).width;metrics.set(text,value);}return value;},labelMemory,performance.now());
   ctx.fillStyle=foreground;ctx.textAlign='center';ctx.textBaseline='top';for(const label of labels.labels){ctx.globalAlpha=label.alpha;ctx.font=`${label.fontSize??12}px system-ui, sans-serif`;ctx.fillText(label.text,label.x,label.top);}
   ctx.globalAlpha=1;
  }
  const point=(event:PointerEvent|WheelEvent):TouchPoint=>{const r=canvas.getBoundingClientRect();return{x:event.clientX-r.left,y:event.clientY-r.top};};
  const hit=(p:TouchPoint)=>{let closest:typeof hits[number]|null=null,best=Infinity;for(const node of hits){const distance=Math.hypot(node.x-p.x,node.y-p.y);if(distance<=node.r&&distance<best){closest=node;best=distance;}}return closest;};
  function down(e:PointerEvent){if(latest.current.paused||e.button!==0)return;e.preventDefault();const p=point(e);pointers.set(e.pointerId,p);try{canvas.setPointerCapture(e.pointerId);}catch{/* Some older WebViews lack capture. */}
   if(pointers.size===1){const node=hit(p);gesture={start:p,last:p,key:node?.key??null,moved:false};dragId=node?.id??null;mutation++;hoverId=null;selectScene();}else{dragId=null;mutation++;if(gesture)gesture.moved=true;}wake();}
  function move(e:PointerEvent){const p=point(e);if(!pointers.has(e.pointerId)){if(e.pointerType==='mouse'){const id=hit(p)?.id??null;if(id!==hoverId){hoverId=id;selectScene();wake();}}return;}
   e.preventDefault();const previous=[...pointers.values()];pointers.set(e.pointerId,p);const current=[...pointers.values()];
   if(current.length>=2){camera=pinchCamera(camera,[previous[0],previous[1]],[current[0],current[1]]);explicitCamera=true;notifyCamera();}
   else if(gesture){if(Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)>5)gesture.moved=true;if(gesture.moved){if(dragId!==null){const n=byId.get(dragId);if(n){Object.assign(n,graphPoint(camera,p),{vx:0,vy:0});mutation++;alpha=.4;}}else{camera={...camera,panX:camera.panX+p.x-gesture.last.x,panY:camera.panY+p.y-gesture.last.y};explicitCamera=true;notifyCamera();}}gesture.last=p;}wake();}
  function up(e:PointerEvent){if(!pointers.has(e.pointerId))return;const cancelled=e.type!=='pointerup';const wasMulti=pointers.size>1;pointers.delete(e.pointerId);
   if(!cancelled&&!wasMulti&&gesture&&!gesture.moved){const key=gesture.key;latest.current.onSelect(key);if(key&&lastTap?.key===key&&performance.now()-lastTap.time<350){latest.current.onOpen(key);lastTap=null;}else lastTap=key?{key,time:performance.now()}:null;}
   dragId=null;mutation++;if(pointers.size===1){const p=[...pointers.values()][0];gesture={start:p,last:p,key:null,moved:true};}else gesture=null;selectScene();wake();}
  function wheel(e:WheelEvent){e.preventDefault();camera=wheelCamera(camera,camera,point(e),e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?height:1));explicitCamera=true;notifyCamera();}
  function keydown(e:KeyboardEvent){if(e.key==='+'||e.key==='='){e.preventDefault();zoomBy(1.25);}else if(e.key==='-'){e.preventDefault();zoomBy(.8);}else if(e.key==='0'){e.preventDefault();fit();}else if(e.key==='Enter'&&latest.current.selectedKey){e.preventDefault();latest.current.onOpen(latest.current.selectedKey);}else if(e.key.startsWith('Arrow')){e.preventDefault();camera={...camera,panX:camera.panX+(e.key==='ArrowLeft'?40:e.key==='ArrowRight'?-40:0),panY:camera.panY+(e.key==='ArrowUp'?40:e.key==='ArrowDown'?-40:0)};notifyCamera();}}
  function resize(){const rect=canvas.getBoundingClientRect();const w=Math.max(1,rect.width),h=Math.max(1,rect.height);if(width>1&&height>1){camera={...camera,panX:camera.panX+(w-width)/2,panY:camera.panY+(h-height)/2};persistCamera();}width=w;height=h;dpr=graphPixelRatio(window.devicePixelRatio,width,height);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);alpha=Math.max(alpha,.15);mutation++;wake();}
  function visibility(){if(document.hidden){if(raf)cancelAnimationFrame(raf);raf=0;lastFrame=0;cancelGesture();selectScene();}else wake();}
  const leave=()=>{if(!pointers.size&&hoverId!==null){hoverId=null;selectScene();wake();}};canvas.addEventListener('pointerleave',leave);
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('lostpointercapture',up);canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('keydown',keydown);
  document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',resize);
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resize):null;observer?.observe(canvas);
  const themeObserver=typeof MutationObserver!=='undefined'?new MutationObserver(()=>{selectScene();wake();}):null;for(const element of [document.documentElement,canvas.closest('.st-app')])if(element)themeObserver?.observe(element,{attributes:true,attributeFilter:['class','style','data-theme','data-mode','data-reduced']});
  const reset=()=>{cancelGesture();const initial=graphSeedPositions(latest.current.seed.nodes,latest.current.seed.edges,width,height);for(const node of nodes){const p=initial.get(node.id);if(p)Object.assign(node,p,{vx:0,vy:0});}generation++;mutation++;alpha=1;timeline=null;selectScene();fit();update();};
  runtime.current={update,reset,fit,zoomBy,capture:()=>new Promise((resolve,reject)=>{draw();canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图谱导出失败')),'image/png');})};
  resize();update();latest.current.onReady?.();
  return()=>{disposed=true;runtime.current=null;worker?.terminate();if(raf)cancelAnimationFrame(raf);observer?.disconnect();themeObserver?.disconnect();window.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',visibility);canvas.removeEventListener('pointerleave',leave);canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('lostpointercapture',up);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('keydown',keydown);};
 },[]);
 return <div className="mg-canvas"><canvas ref={canvasRef} tabIndex={0} aria-label="本地图谱。拖动空白移动，双指缩放，点按选择节点，双击打开。键盘方向键平移，加减缩放，0 适应画面。" style={{width:'100%',height:'100%',display:'block',touchAction:'none'}} />{warning&&<div className="mg-canvas-warning" role="status">{warning}</div>}</div>;
});
