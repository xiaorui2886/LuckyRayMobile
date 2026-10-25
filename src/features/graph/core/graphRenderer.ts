/** Desktop GraphPage 200433932c46 renderer-only math, no DOM or host dependencies. */
import type {Camera} from './graphCamera.ts';
import {graphPlaybackNodeVisual,type GraphPlaybackPlan} from './graphPlayback.ts';
import {graphEdgeDetail} from './graphSpatial.ts';
import {GRAPH_EDGE_WIDTHS} from './graphSemantics.ts';
import type {GraphEdgeKind} from './graphTypes.ts';
export function mixGraphHexColors(foreground:string,background:string,weight:number){const f=foreground.trim().replace(/^#/,''),b=background.trim().replace(/^#/,'');if(!/^[0-9a-f]{6}$/i.test(f)||!/^[0-9a-f]{6}$/i.test(b))return foreground;const w=Math.max(0,Math.min(1,weight));return '#'+[0,2,4].map(i=>Math.round(parseInt(f.slice(i,i+2),16)*w+parseInt(b.slice(i,i+2),16)*(1-w)).toString(16).padStart(2,'0')).join('');}
export function graphNodeFill(input:{color:string;background:string;accent:string;focused:boolean;dimmed:boolean;neighbor:boolean;document:boolean}) {
 return input.focused?mixGraphHexColors(input.accent,input.background,.95):mixGraphHexColors(input.color,input.background,input.dimmed?(input.document?.16:.12):input.neighbor?(input.document?.9:.8):input.document?.88:.72);
}
export function graphEdgePaint(input:{kind:GraphEdgeKind;scale:number;edgeWidth:number;relatedToFocus:boolean;dimmed:boolean;missingEndpoint:boolean;treeEdge:boolean;progress:number;fromAlpha:number;toAlpha:number}) {
 const detail=graphEdgeDetail(input.scale),base=GRAPH_EDGE_WIDTHS[input.kind];return {
 width:input.edgeWidth*(input.relatedToFocus?base+.42:input.dimmed?.56:base)*detail.width/input.scale,
 alpha:(input.treeEdge?Math.min(input.fromAlpha,input.toAlpha,input.progress):input.progress)*(input.relatedToFocus?.8:input.dimmed?.14:detail.alpha*(input.missingEndpoint?.65:1)),
 arrows:!input.dimmed&&!input.missingEndpoint&&(!input.treeEdge||input.progress>=.98)};
}
export function graphArrowTriangle(x1:number,y1:number,x2:number,y2:number,targetRadius:number,scale:number):Array<{x:number;y:number}>|null {
 const dx=x2-x1,dy=y2-y1,d=Math.hypot(dx,dy);if(d<1)return null;const nx=dx/d,ny=dy/d,zoom=Math.max(.1,scale),len=Math.max(3.4,Math.min(12,5.8/zoom)),gap=Math.max(.7,Math.min(1.6,1.2/zoom));if(d<=targetRadius+gap+len+2)return null;
 const tx=x2-nx*(targetRadius+gap),ty=y2-ny*(targetRadius+gap),base=Math.atan2(ny,nx),angle=Math.PI/6;
 return [{x:tx,y:ty},{x:tx-len*Math.cos(base-angle),y:ty-len*Math.sin(base-angle)},{x:tx-len*Math.cos(base+angle),y:ty-len*Math.sin(base+angle)}];
}
export function graphPlaybackCameraTarget(timeline:GraphPlaybackPlan,elapsed:number,nodes:ReadonlyArray<{id:number;x:number;y:number;r:number;hidden?:boolean}>,width:number,height:number,nodeSizeMultiplier:number,current:Camera):Camera|null {
 if(!width||!height)return null;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,count=0;
 for(const node of nodes){if(node.hidden)continue;const plan=timeline.nodes.get(node.id);if(!plan)continue;const visual=graphPlaybackNodeVisual(plan,elapsed,node);if(!visual)continue;
 const radius=node.r*nodeSizeMultiplier*visual.scale+14;minX=Math.min(minX,visual.x-radius);minY=Math.min(minY,visual.y-radius);maxX=Math.max(maxX,visual.x+radius);maxY=Math.max(maxY,visual.y+radius);count++;}
 if(!count)return null;const padding=Math.max(52,Math.min(112,Math.min(width,height)*.14));const fit=Math.min(Math.max(80,width-padding*2)/Math.max(36,maxX-minX),Math.max(80,height-padding*2)/Math.max(36,maxY-minY));
 const desired=Math.max(.28,Math.min(1.65,count<=2?Math.min(1.65,fit):fit));const blend=.14;
 return {scale:current.scale+(desired-current.scale)*blend,panX:current.panX+(width/2-(minX+maxX)/2*desired-current.panX)*blend,panY:current.panY+(height/2-(minY+maxY)/2*desired-current.panY)*blend};
}
