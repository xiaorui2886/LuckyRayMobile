import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { GraphSeed, GraphViewState } from './core/graphTypes';
import { fitGraphCamera, wheelCamera, wheelZoomPoint, type Camera } from './core/graphCamera';
import { filteredGraph, normalizeGraphView, graphForceParameters, isMissingGraphNode, graphNodeRadiusForLinks } from './core/graphSemantics';
import { graphSeedPositions, graphScreenRadius } from './core/graphSpatial';
import { graphLabelDetail, graphLabelFocusAlpha, updateGraphLabels, type GraphLabelState } from './core/graphPresentation';
import { packGraphPhysicsState, type GraphPhysicsNode, type GraphPhysicsStepRequest, type GraphPhysicsStepResponse } from './core/graphPhysics';
import { buildGraphPlaybackPlan, graphPlaybackNodeVisual, graphPlaybackEdgeProgress, graphPlaybackEdgeKey, type GraphPlaybackPlan } from './core/graphPlayback';
import { graphNodeFill, graphEdgePaint, graphArrowTriangle, graphPlaybackCameraTarget } from './core/graphRenderer';
import {sampleGraphPanVelocity,releaseGraphPanVelocity,stepGraphCameraMotion,type GraphCameraMotion} from './mobileGraphCameraMotion';
import { graphCameraSignature, graphActivationTransition } from './mobileGraphLifecycle';
import { activateGraphPlaybackBodies, dragGraphPlaybackBody, graphVisualEdgeEndpoint, graphPointerMoved, graphPositionIsFinite, mergeGraphWorkerPositions, type MobileGraphPosition } from './mobileGraphInteraction';
export type { MobileGraphPosition } from './mobileGraphInteraction';
import { pinchCamera, graphPoint, graphPixelRatio, graphDraggedPosition, GRAPH_TOUCH_HOLD_MS, type TouchPoint } from './mobileGraphGestures';

export type MobileGraphCanvasHandle = {reset():void;fit():void;zoomBy(factor:number):void;capture():Promise<Blob>;captureLayout():MobileGraphPosition[]};
export type MobileGraphCanvasProps = {
 seed:GraphSeed;settings:GraphViewState;selectedKey?:string|null;scopeKeys?:Set<string>|null;
 positions?:MobileGraphPosition[];onPositionsChange?(positions:MobileGraphPosition[]):void;
 camera?:Camera;paused?:boolean;reducedMotion?:boolean;playback?:{playing:boolean;progress?:number};
 onSelect(key:string|null):void;onOpen(key:string):void;onCameraChange?(camera:Camera,settled?:boolean):void;
 onPlaybackProgress?(progress:number):void;onReady?():void;
};
type Runtime = {reset():void;update():void;fit():void;zoomBy(factor:number):void;capture():Promise<Blob>;captureLayout():MobileGraphPosition[]};
/** The shared desktop solver runs only in a worker. All data stays on this device. */
export const MobileGraphCanvas = forwardRef<MobileGraphCanvasHandle,MobileGraphCanvasProps>(function MobileGraphCanvas(props,ref) {
 const canvasRef=useRef<HTMLCanvasElement>(null), latest=useRef(props), runtime=useRef<Runtime|null>(null);
 latest.current=props;
 const [warning,setWarning]=useState('');
 useImperativeHandle(ref,()=>({reset:()=>runtime.current?.reset(),fit:()=>runtime.current?.fit(),zoomBy:f=>runtime.current?.zoomBy(f),capture:()=>runtime.current?.capture()??Promise.reject(new Error('图谱尚未就绪')),captureLayout:()=>runtime.current?.captureLayout()??[]}),[]);
 useEffect(()=>{runtime.current?.update();},[props.seed,props.settings,props.selectedKey,props.scopeKeys,props.paused,props.playback?.playing,props.playback?.progress,props.camera,props.reducedMotion]);
 useEffect(()=>{
  const element=canvasRef.current;if(!element)return;const canvas:HTMLCanvasElement=element;
  const ctx=canvas.getContext('2d');if(!ctx){setWarning('当前 WebView 不支持画布，请更新系统 WebView。');return;}
  let disposed=false,raf=0,width=1,height=1,dpr=1,dirty=true,alpha=1,generation=0,mutation=0,revision=0,requestId=0,busy=false,sendTopology=true;
  const initialCamera=normalizeGraphView(latest.current.camera);let camera:Camera={scale:initialCamera.scale,panX:initialCamera.panX,panY:initialCamera.panY},explicitCamera=!!latest.current.camera;
  let settings=normalizeGraphView(latest.current.settings),scene=filteredGraph(latest.current.seed,settings),nodes:GraphPhysicsNode[]=[],byId=new Map<number,GraphPhysicsNode>();
  let oldSeed:GraphSeed|null=null,oldPhysics='',oldActive='',solverActive='',externalCamera=graphCameraSignature(latest.current.camera),worker:Worker|null=null,dragId:number|null=null,hoverId:number|null=null;
  let timeline:GraphPlaybackPlan|null=null,playing=false,elapsed=0,lastFrame=0,lastProgress=0,finished=false,cameraFollow=true,lastSeek:number|undefined;
  const playbackActive=new Set<number>();let playbackTarget:Camera|null=null,layoutNeedsPersist=false,wasPaused=false;
  const restoredPositions=new Map((latest.current.positions??[]).filter(graphPositionIsFinite).map(p=>[p.key,p]));
  const labelMemory=new Map<number,GraphLabelState>(),metrics=new Map<string,number>();
  const pointers=new Map<number,TouchPoint>();let gesture:{start:TouchPoint;last:TouchPoint;key:string|null;moved:boolean;held:boolean}|null=null;
  let hoverPoint:TouchPoint|null=null;
  let holdTimer:ReturnType<typeof setTimeout>|null=null,dragOffset:TouchPoint={x:0,y:0};
  const clearHold=()=>{if(holdTimer!==null){clearTimeout(holdTimer);holdTimer=null;}};
  let cameraMotion:GraphCameraMotion|null=null,motionAt=0,panSample:{velocity:{panX:number;panY:number};lastAt:number}|null=null;
  const stopCameraMotion=()=>{cameraMotion=null;motionAt=0;};
  const wake=()=>{dirty=true;if(!raf&&!disposed&&!document.hidden&&!latest.current.paused)raf=requestAnimationFrame(frame);};
  const persistCamera=(settled=true)=>{latest.current.onCameraChange?.({...camera},settled);};
  const captureLayout=()=> (oldSeed?.nodes??[]).flatMap(n=>{const body=byId.get(n.id);return body?[{key:n.key,x:body.x,y:body.y,vx:body.vx,vy:body.vy}]:[];});
  const persistLayout=()=>{if(!oldSeed?.nodes.length)return;latest.current.onPositionsChange?.(captureLayout());layoutNeedsPersist=false;};
  const notifyCamera=(settled=true)=>{stopCameraMotion();cameraFollow=false;persistCamera(settled);wake();};
  const reduced=()=>!!latest.current.reducedMotion||canvas.closest('.st-app')?.getAttribute('data-reduced')==='true'||(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
  const cancelGesture=()=>{clearHold();stopCameraMotion();panSample=null;const ids=[...pointers.keys()];pointers.clear();gesture=null;dragId=null;hoverId=null;hoverPoint=null;mutation++;for(const id of ids)try{if(canvas.hasPointerCapture?.(id))canvas.releasePointerCapture(id);}catch{/* Released by WebView already. */}};
  let palette={background:'#101216',foreground:'#e7e9ee',accent:'#9caeff',edge:'#737b89',dimmed:'#515866'};
  const readPalette=()=>{const style=getComputedStyle(canvas),resolve=(name:string,fallback:string)=>{const value=style.getPropertyValue(name).trim();if(!value)return fallback;ctx.fillStyle=fallback;ctx.fillStyle=value;return String(ctx.fillStyle);};palette={background:resolve('--mg-graph-background','#101216'),foreground:resolve('--mg-graph-foreground','#e7e9ee'),accent:resolve('--mg-graph-accent',resolve('--st-accent','#9caeff')),edge:resolve('--mg-graph-edge',resolve('--st-secondary','#737b89')),dimmed:resolve('--mg-graph-dimmed',resolve('--st-line','#515866'))};};
  readPalette();
  const selectScene=()=>{const selected=latest.current.seed.nodes.find(n=>n.key===latest.current.selectedKey)?.id??null;scene=filteredGraph(latest.current.seed,settings,{nodeColor:palette.foreground,accent:palette.accent,scopeKeys:latest.current.scopeKeys,selectedId:selected,hoveredId:hoverId,draggingId:dragId});};
  const moveCamera=(target:Camera,immediate=false)=>{cameraFollow=false;explicitCamera=true;if(immediate||reduced()){camera={...target};notifyCamera();}else{cameraMotion={target,velocity:{panX:0,panY:0},anchor:null};motionAt=0;wake();}};
  const fit=(immediate=false)=>{const fitted=fitGraphCamera(scene.renderedNodes.map(n=>byId.get(n.id)).filter((n):n is GraphPhysicsNode=>!!n),width,height);if(fitted)moveCamera(fitted,immediate);};
  const zoomBy=(factor:number)=>{if(!(factor>0&&Number.isFinite(factor)))return;moveCamera(wheelCamera(camera,cameraMotion?.target??camera,{x:width/2,y:height/2},-Math.log(factor)/.0025));};
  function update(){
   const p=latest.current;settings=normalizeGraphView(p.settings);selectScene();
   if(p.paused&&!wasPaused){persistCamera();persistLayout();cancelGesture();selectScene();lastFrame=0;if(raf)cancelAnimationFrame(raf);raf=0;}
   wasPaused=!!p.paused;
   if(graphCameraSignature(p.camera)!==externalCamera&&p.camera){externalCamera=graphCameraSignature(p.camera);if(graphCameraSignature(p.camera)!==graphCameraSignature(camera))stopCameraMotion();const normalized=normalizeGraphView(p.camera);camera={scale:normalized.scale,panX:normalized.panX,panY:normalized.panY};explicitCamera=true;}
   const activeKey=scene.renderedNodes.map(n=>n.id).join(',');if(activeKey!==oldActive){oldActive=activeKey;alpha=Math.max(alpha,.3);mutation++;timeline=null;playbackActive.clear();}
   const forceKey=JSON.stringify(graphForceParameters(settings));
   if(oldSeed!==p.seed){
    persistLayout();cancelGesture();selectScene();
    const sameTopology=oldSeed?.nodes.length===p.seed.nodes.length&&oldSeed.nodes.every((n,i)=>n.key===p.seed.nodes[i]?.key&&n.id===p.seed.nodes[i]?.id)&&JSON.stringify(oldSeed.edges)===JSON.stringify(p.seed.edges);
    const positions=new Map((oldSeed?.nodes??[]).map(n=>[n.key,byId.get(n.id)]));
    const initial=graphSeedPositions(p.seed.nodes,p.seed.edges,width,height);
    nodes=scene.nodes.map(n=>{const prior=positions.get(n.key)??restoredPositions.get(n.key),pos=initial.get(n.id)!;return{id:n.id,x:prior?.x??pos.x,y:prior?.y??pos.y,vx:prior?.vx??0,vy:prior?.vy??0,r:n.r*settings.nodeSize/6};});
    byId=new Map(nodes.map(n=>[n.id,n]));oldSeed=p.seed;generation++;revision++;sendTopology=true;alpha=sameTopology?alpha:Math.max(alpha,.22);layoutNeedsPersist=true;labelMemory.clear();metrics.clear();timeline=null;playbackActive.clear();
    if(!explicitCamera)fit(true);
   }
   if(forceKey!==oldPhysics){oldPhysics=forceKey;alpha=1;mutation++;}
   let radiusChanged=false;for(const n of scene.nodes){const body=byId.get(n.id);if(body&&body.r!==n.r*settings.nodeSize/6){body.r=n.r*settings.nodeSize/6;radiusChanged=true;}}
   if(radiusChanged){revision++;sendTopology=true;alpha=1;}
   if(p.playback?.playing&&(!playing||!timeline)){stopCameraMotion();panSample=null;timeline=buildGraphPlaybackPlan({nodes:scene.renderedNodes.map(n=>({...n,...byId.get(n.id)!})),edges:scene.renderedEdges.map(e=>({a:e.a.id,b:e.b.id})),startedAt:performance.now()});elapsed=0;lastFrame=0;finished=false;playbackActive.clear();playbackTarget={...camera};cameraFollow=!reduced();alpha=1;}
   if(playing&&!p.playback?.playing){persistCamera();alpha=1;mutation++;}
   playing=!!p.playback?.playing;
   if(!playing){timeline=null;finished=false;playbackActive.clear();playbackTarget=null;}
   if(timeline&&p.playback?.progress!==undefined&&p.playback.progress!==lastSeek){const next=Math.max(0,Math.min(1,p.playback.progress))*timeline.totalDuration;if(next<elapsed){playbackActive.clear();generation++;}elapsed=next;finished=false;lastFrame=0;}
   lastSeek=p.playback?.progress;wake();
  }
  function workerFailure(){if(disposed)return;worker?.terminate();worker=null;busy=false;setWarning('本机图谱布局暂不可用；已保留全部节点，可缩放、拖动和打开。重新打开图谱可重试。');wake();}
  try{worker=new Worker(new URL('./core/graphPhysics.worker.ts',import.meta.url),{type:'module'});worker.onerror=workerFailure;worker.onmessage=(event:MessageEvent<GraphPhysicsStepResponse>)=>{
   const result=event.data;if(disposed||!busy||result.type!=='step-result'||result.requestId!==requestId)return;busy=false;
   if(result.generation===generation&&result.topologyRevision===revision&&result.mutationRevision===mutation&&mergeGraphWorkerPositions(nodes,result.state,dragId)){alpha=dragId===null?result.alpha:Math.max(.3,result.alpha);layoutNeedsPersist=true;if(alpha<.001)persistLayout();}
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
   if(timeline&&!finished){elapsed=reduced()?timeline.totalDuration:elapsed+(lastFrame?Math.min(64,now-lastFrame):0);const progress=Math.min(1,elapsed/timeline.totalDuration);if(now-lastProgress>100||progress===1){lastProgress=now;latest.current.onPlaybackProgress?.(progress);}if(progress===1){finished=true;}dirty=true;}
   if(timeline&&!reduced()&&activateGraphPlaybackBodies(timeline,elapsed,scene.renderedNodes,byId,playbackActive)){alpha=Math.max(alpha,.4);mutation++;layoutNeedsPersist=true;}
   if(timeline&&!finished&&cameraFollow&&!reduced()){playbackTarget=graphPlaybackCameraTarget(timeline,elapsed,scene.renderedNodes.map(n=>byId.get(n.id)!).filter(Boolean),width,height,1,playbackTarget??camera);if(playbackTarget)cameraMotion={target:playbackTarget,velocity:{panX:0,panY:0},anchor:null};}
   if(cameraMotion){const result=stepGraphCameraMotion(camera,cameraMotion,motionAt?now-motionAt:16,reduced());camera=result.camera;cameraMotion=result.active?result.motion:null;motionAt=result.active?now:0;dirty=true;persistCamera(!result.active&&!(timeline&&!finished&&cameraFollow&&!reduced()));}
   lastFrame=now;if(timeline&&finished&&dirty)persistCamera();
   if(hoverPoint&&hoverId!==null&&!pointers.size){const id=liveHit(hoverPoint)?.id??null;if(id!==hoverId){hoverId=id;selectScene();dirty=true;}}
   if(dirty){draw();dirty=false;}requestStep();if(alpha<.001&&layoutNeedsPersist)persistLayout();
   if((timeline&&!finished)||cameraMotion)if(!raf)raf=requestAnimationFrame(frame);
  }
  function draw(){
   if(!ctx)return;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.globalAlpha=1;
   const {background,foreground,accent}=palette;
   ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
   const visual=new Map<number,{x:number;y:number;r:number;alpha:number;progress:number}>();
   const liveDegree=new Map<number,number>();if(timeline)for(const edge of scene.renderedEdges){const plan=timeline.edges.get(graphPlaybackEdgeKey(edge.a.id,edge.b.id));const progress=plan?graphPlaybackEdgeProgress(plan,elapsed):0;liveDegree.set(edge.a.id,(liveDegree.get(edge.a.id)||0)+progress);liveDegree.set(edge.b.id,(liveDegree.get(edge.b.id)||0)+progress);}
   for(const n of scene.renderedNodes){const body=byId.get(n.id);if(!body)continue;const plan=timeline?.nodes.get(n.id);const v=plan?graphPlaybackNodeVisual(plan,elapsed,body):{...body,scale:1,alpha:1,progress:1};if(!v)continue;visual.set(n.id,{x:v.x*camera.scale+camera.panX,y:v.y*camera.scale+camera.panY,r:graphScreenRadius(timeline?graphNodeRadiusForLinks(liveDegree.get(n.id)||0,isMissingGraphNode(n))*settings.nodeSize/6:body.r,camera.scale)*v.scale,alpha:v.alpha,progress:v.progress});}
   for(const e of scene.renderedEdges){const a=visual.get(e.a.id),b=visual.get(e.b.id);if(!a||!b)continue;const plan=timeline?.edges.get(graphPlaybackEdgeKey(e.a.id,e.b.id));const progress=plan?graphPlaybackEdgeProgress(plan,elapsed):1;if(progress<=0)continue;
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);if(length<1)continue;
    const paint=graphEdgePaint({kind:e.kind,scale:camera.scale,edgeWidth:settings.edgeWidth,relatedToFocus:e.relatedToFocus,dimmed:e.dimmed,missingEndpoint:isMissingGraphNode(e.a)||isMissingGraphNode(e.b),treeEdge:plan?.treeEdge??false,progress,fromAlpha:a.alpha,toAlpha:b.alpha});
    ctx.globalAlpha=paint.alpha;ctx.strokeStyle=e.relatedToFocus?accent:e.dimmed?palette.dimmed:palette.edge;ctx.lineWidth=paint.width*camera.scale;ctx.beginPath();const from=plan?.treeEdge&&plan.fromId===e.b.id?b:a,to=from===a?b:a;ctx.moveTo(from.x,from.y);const endpoint=graphVisualEdgeEndpoint(from,to);ctx.lineTo(endpoint.x,endpoint.y);ctx.stroke();
    if(settings.showArrows&&paint.arrows&&e.direction!=='undirected'){
     const arrow=(from:typeof a,to:typeof b)=>{const triangle=graphArrowTriangle(from.x/camera.scale,from.y/camera.scale,to.x/camera.scale,to.y/camera.scale,to.r/camera.scale,camera.scale);if(!triangle)return;ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();triangle.forEach((p,i)=>i?ctx.lineTo(p.x*camera.scale,p.y*camera.scale):ctx.moveTo(p.x*camera.scale,p.y*camera.scale));ctx.closePath();ctx.fill();};
     if(e.direction==='forward'||e.direction==='bidirectional')arrow(a,b);if(e.direction==='reverse'||e.direction==='bidirectional')arrow(b,a);
    }
   }
   const candidates=[];const labelDetail=graphLabelDetail(camera.scale,settings.labelReveal);const revealAlpha=(progress:number)=>{const t=Math.max(0,Math.min(1,(progress-.48)/(.9-.48)));return t*t*(3-2*t);};
   for(const n of [...scene.renderedNodes].sort((a,b)=>Number(a.id===scene.activeFocusId)-Number(b.id===scene.activeFocusId))){const v=visual.get(n.id);if(!v)continue;const focused=n.id===scene.activeFocusId;ctx.globalAlpha=v.alpha;ctx.fillStyle=graphNodeFill({color:n.color,background,accent,focused,dimmed:n.dimmed,neighbor:scene.connectedIds.has(n.id),document:n.type==='note'});if(timeline&&v.progress<.99){ctx.save();ctx.shadowColor='rgba(0,0,0,.24)';ctx.shadowBlur=Math.max(1.5,v.r*.8)*(1-v.progress*.45);ctx.shadowOffsetY=Math.max(.5,(1-v.progress)*2.4);}
    ctx.beginPath();ctx.arc(v.x,v.y,v.r,0,Math.PI*2);ctx.fill();if(timeline&&v.progress<.99)ctx.restore();
    if(settings.showLabels)candidates.push({id:n.id,text:n.label,x:v.x,y:v.y,radius:v.r,priority:focused?3:scene.connectedIds.has(n.id)?2:0,degree:n.links,alpha:graphLabelFocusAlpha(labelDetail.alpha,focused,scene.connectedIds.has(n.id),scene.activeFocusId!==null)*revealAlpha(v.progress),fontSize:focused?Math.max(12,labelDetail.fontSize):labelDetail.fontSize});
   }
   ctx.font='12px system-ui, sans-serif';const labels=updateGraphLabels(candidates,width,height,text=>{let value=metrics.get(text);if(value===undefined){value=ctx.measureText(text).width;if(metrics.size>=5000)metrics.clear();metrics.set(text,value);}return value;},labelMemory,performance.now());
   ctx.textAlign='left';ctx.textBaseline='top';for(const label of labels.labels){ctx.globalAlpha=label.alpha;ctx.fillStyle=label.priority===3?accent:foreground;ctx.font=`${label.fontSize??12}px system-ui, sans-serif`;ctx.fillText(label.text,label.left+4,label.top+2);}
   ctx.globalAlpha=1;
  }
  const point=(event:MouseEvent):TouchPoint=>{const r=canvas.getBoundingClientRect();return{x:event.clientX-r.left,y:event.clientY-r.top};};
  // Re-evaluate world geometry, not the last painted hit cache: a physics reply
  // can move a node away from a stationary pointer between input events.
  const liveHit=(p:TouchPoint,touchTarget=false)=>{let closest:{key:string;id:number}|null=null,best=Infinity;for(const n of scene.renderedNodes){const body=byId.get(n.id);if(!body)continue;const plan=timeline?.nodes.get(n.id),v=plan?graphPlaybackNodeVisual(plan,elapsed,body):{...body,scale:1};if(!v)continue;const radius=graphScreenRadius(body.r,camera.scale)*v.scale;const distance=Math.hypot(v.x*camera.scale+camera.panX-p.x,v.y*camera.scale+camera.panY-p.y);if(distance<=Math.max(touchTarget?18:0,radius+(touchTarget?7:4))&&distance<best){closest=n;best=distance;}}return closest;};
  function down(e:PointerEvent){
   if(latest.current.paused||(e.button!==0&&e.button!==1))return;
   e.preventDefault();stopCameraMotion();cameraFollow=false;hoverPoint=null;hoverId=null;
   const p=point(e);pointers.set(e.pointerId,p);try{canvas.setPointerCapture(e.pointerId);}catch{/* Older WebViews may not support capture. */}
   clearHold();
   if(pointers.size===1){
    const node=e.button===1?null:liveHit(p,e.pointerType==='touch'),body=node&&byId.get(node.id);
    gesture={start:p,last:p,key:node?.key??null,moved:e.button===1,held:false};
    panSample=e.pointerType==='touch'&&!node?{velocity:{panX:0,panY:0},lastAt:performance.now()}:null;
    dragId=body?.id??null;mutation++;
    if(body){const world=graphPoint(camera,p);dragOffset={x:body.x-world.x,y:body.y-world.y};alpha=Math.max(alpha,.3);
     if(e.pointerType==='touch')holdTimer=setTimeout(()=>{holdTimer=null;if(disposed||!gesture||gesture.moved||pointers.size!==1)return;gesture.held=true;latest.current.onSelect(node!.key);wake();},GRAPH_TOUCH_HOLD_MS);
    }
   }else{panSample=null;dragId=null;mutation++;if(gesture){gesture.moved=true;gesture.held=true;}}
   selectScene();wake();
  }
  function move(e:PointerEvent){
   const p=point(e);
   if(!pointers.has(e.pointerId)){if(e.pointerType==='mouse'&&e.buttons===0){hoverPoint=p;const id=liveHit(p)?.id??null;if(id!==hoverId){hoverId=id;selectScene();wake();}}return;}
   e.preventDefault();const previous=[...pointers.values()];pointers.set(e.pointerId,p);const current=[...pointers.values()];
   if(current.length>=2){camera=pinchCamera(camera,[previous[0],previous[1]],[current[0],current[1]]);explicitCamera=true;notifyCamera(false);}
   else if(gesture){
    const wasMoved=gesture.moved;
    if(graphPointerMoved(gesture.start,p)){gesture.moved=true;clearHold();}
    if(dragId!==null){const n=byId.get(dragId);if(n){const next=graphDraggedPosition(camera,p,dragOffset);dragGraphPlaybackBody(timeline,n.id,elapsed,next,n);Object.assign(n,next,{vx:0,vy:0});alpha=Math.max(alpha,.3);layoutNeedsPersist=true;}}
    else if(gesture.moved){const from=wasMoved?gesture.last:gesture.start;if(panSample){const now=performance.now();panSample.velocity=sampleGraphPanVelocity(panSample.velocity,p.x-from.x,p.y-from.y,now-panSample.lastAt);panSample.lastAt=now;}camera={...camera,panX:camera.panX+p.x-from.x,panY:camera.panY+p.y-from.y};explicitCamera=true;notifyCamera(false);}
    gesture.last=p;
   }
   wake();
  }
  function up(e:PointerEvent){
   if(!pointers.has(e.pointerId))return;
   const cancelled=e.type!=='pointerup';
   // Native WebViews may deliver the final displacement only with pointerup.
   if(!cancelled&&gesture&&(point(e).x!==gesture.last.x||point(e).y!==gesture.last.y))move(e);
   clearHold();const wasMulti=pointers.size>1,ended=gesture,wasDragging=dragId!==null;pointers.delete(e.pointerId);
   if(!cancelled&&!wasMulti&&!pointers.size&&!wasDragging&&ended?.moved&&panSample){const velocity=releaseGraphPanVelocity(panSample.velocity,e.pointerType,reduced());if(Math.hypot(velocity.panX,velocity.panY)>0){cameraMotion={target:{...camera},velocity,anchor:null};motionAt=0;}}
   else if(cancelled)stopCameraMotion();
   panSample=null;dragId=null;hoverId=null;hoverPoint=null;mutation++;
   if(pointers.size===1){const p=[...pointers.values()][0];gesture={start:p,last:p,key:null,moved:true,held:true};}else gesture=null;
   // Delete ownership before releasePointerCapture, which may synchronously
   // dispatch lostpointercapture. A cancellation must never be treated as a tap.
   try{if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);}catch{/* Already released. */}
   persistCamera();persistLayout();selectScene();wake();
   if(!cancelled&&!wasMulti&&!pointers.size&&ended&&!ended.moved&&!ended.held){latest.current.onSelect(ended.key);if(ended.key)latest.current.onOpen(ended.key);}
  }
  const suppressMiddle=(e:MouseEvent)=>{if(e.button===1)e.preventDefault();};
  function contextMenu(e:MouseEvent){e.preventDefault();if(latest.current.paused)return;const node=liveHit(point(e));cancelGesture();latest.current.onSelect(node?.key??null);selectScene();wake();}
  function wheel(e:WheelEvent){e.preventDefault();if(latest.current.paused)return;const p=point(e),node=liveHit(p),body=node?byId.get(node.id):null;hoverPoint=p;hoverId=node?.id??null;selectScene();const anchor=wheelZoomPoint(camera,p,body);const target=wheelCamera(camera,cameraMotion?.target??camera,anchor,e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?height:1));cameraMotion={target,velocity:{panX:0,panY:0},anchor};motionAt=0;cameraFollow=false;explicitCamera=true;wake();}
  function keydown(e:KeyboardEvent){if(latest.current.paused)return;if(e.key==='Escape'){e.preventDefault();cancelGesture();latest.current.onSelect(null);selectScene();wake();}else if(e.key==='+'||e.key==='='){e.preventDefault();zoomBy(1.25);}else if(e.key==='-'){e.preventDefault();zoomBy(.8);}else if(e.key==='0'){e.preventDefault();fit();}else if(e.key==='Enter'&&latest.current.selectedKey){e.preventDefault();latest.current.onOpen(latest.current.selectedKey);}else if(e.key.startsWith('Arrow')){e.preventDefault();camera={...camera,panX:camera.panX+(e.key==='ArrowLeft'?40:e.key==='ArrowRight'?-40:0),panY:camera.panY+(e.key==='ArrowUp'?40:e.key==='ArrowDown'?-40:0)};notifyCamera();}}
  function resize(){if(disposed)return;stopCameraMotion();const rect=canvas.getBoundingClientRect();const w=Math.max(1,rect.width),h=Math.max(1,rect.height);if(width>1&&height>1){camera={...camera,panX:camera.panX+(w-width)/2,panY:camera.panY+(h-height)/2};persistCamera();}width=w;height=h;dpr=graphPixelRatio(window.devicePixelRatio,width,height);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);alpha=Math.max(alpha,.15);mutation++;wake();}
  function visibility(){if(document.hidden){persistCamera();persistLayout();if(raf)cancelAnimationFrame(raf);raf=0;lastFrame=0;cancelGesture();selectScene();}else wake();}
  const leave=()=>{if(!pointers.size){hoverPoint=null;if(hoverId===null)return;hoverId=null;selectScene();wake();}};canvas.addEventListener('pointerleave',leave);
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('lostpointercapture',up);canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('keydown',keydown);canvas.addEventListener('contextmenu',contextMenu);canvas.addEventListener('auxclick',suppressMiddle);canvas.addEventListener('mousedown',suppressMiddle);
  document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',resize);
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resize):null;observer?.observe(canvas);
  const themeObserver=typeof MutationObserver!=='undefined'?new MutationObserver(()=>{readPalette();selectScene();wake();}):null;for(const element of [document.documentElement,canvas.closest('.st-app')])if(element)themeObserver?.observe(element,{attributes:true,attributeFilter:['class','style','data-theme','data-mode','data-reduced']});
  const reset=()=>{cancelGesture();const initial=graphSeedPositions(latest.current.seed.nodes,latest.current.seed.edges,width,height);for(const node of nodes){const p=initial.get(node.id);if(p)Object.assign(node,p,{vx:0,vy:0});}generation++;mutation++;alpha=1;timeline=null;playbackActive.clear();selectScene();fit();update();};
  runtime.current={update,reset,fit,zoomBy,captureLayout,capture:()=>new Promise((resolve,reject)=>{draw();canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图谱导出失败')),'image/png');})};
  resize();update();latest.current.onReady?.();
  return()=>{persistCamera();persistLayout();disposed=true;cancelGesture();runtime.current=null;worker?.terminate();if(raf)cancelAnimationFrame(raf);observer?.disconnect();themeObserver?.disconnect();window.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',visibility);canvas.removeEventListener('pointerleave',leave);canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('lostpointercapture',up);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('keydown',keydown);canvas.removeEventListener('contextmenu',contextMenu);canvas.removeEventListener('auxclick',suppressMiddle);canvas.removeEventListener('mousedown',suppressMiddle);};
 },[]);
 return <div className="mg-canvas"><canvas ref={canvasRef} tabIndex={0} aria-label="本地图谱。拖动平移，双指缩放，拖动节点，点按打开，长按或右键选择节点操作；点按空白取消选择。键盘方向键平移，加减缩放，0 适应画面。" style={{width:'100%',height:'100%',display:'block',touchAction:'none'}} />{warning&&<div className="mg-canvas-warning" role="status">{warning}</div>}</div>;
});
