import { GRAPH_MAX_SCALE, GRAPH_MIN_SCALE, type Camera } from './core/graphCamera.ts';
export type TouchPoint = {x:number;y:number};
export function pinchCamera(camera:Camera, before:readonly [TouchPoint,TouchPoint], after:readonly [TouchPoint,TouchPoint]):Camera {
 const midpoint=(p:readonly [TouchPoint,TouchPoint])=>({x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2});
 const a=midpoint(before),b=midpoint(after),distance=(p:readonly [TouchPoint,TouchPoint])=>Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
 const scale=Math.max(GRAPH_MIN_SCALE,Math.min(GRAPH_MAX_SCALE,camera.scale*distance(after)/Math.max(1,distance(before))));
 return {scale,panX:b.x-(a.x-camera.panX)*scale/camera.scale,panY:b.y-(a.y-camera.panY)*scale/camera.scale};
}
export function graphPoint(camera:Camera,p:TouchPoint):TouchPoint {return{x:(p.x-camera.panX)/camera.scale,y:(p.y-camera.panY)/camera.scale};}
export function graphPixelRatio(ratio:number,width:number,height:number):number {
 // A 4 MP ceiling avoids allocating huge backing surfaces on high-DPR phones.
 return Math.max(.5,Math.min(Number.isFinite(ratio)?ratio:1,2,Math.sqrt(4_000_000/Math.max(1,width*height))));
}
