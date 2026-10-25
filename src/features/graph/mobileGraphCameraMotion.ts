/** Exact desktop GraphPage 200433932c46 camera constants/update math (430–433,
 * 2239–2269, 2320–2335, 2773–2789), separated from pointer and DOM ownership. */
import {stepCamera,type Camera,type ZoomPoint} from './core/graphCamera.ts';
export type GraphPanVelocity={panX:number;panY:number};
export type GraphCameraMotion={target:Camera;velocity:GraphPanVelocity;anchor:ZoomPoint|null};
export function sampleGraphPanVelocity(previous:GraphPanVelocity,dx:number,dy:number,elapsed:number):GraphPanVelocity{return{panX:previous.panX*.4+dx/Math.max(1,elapsed)*.6,panY:previous.panY*.4+dy/Math.max(1,elapsed)*.6};}
export function releaseGraphPanVelocity(velocity:GraphPanVelocity,pointerType:string,reducedMotion:boolean):GraphPanVelocity {
 const speed=Math.hypot(velocity.panX,velocity.panY);if(pointerType!=='touch'||reducedMotion||speed<.018)return{panX:0,panY:0};const scale=Math.min(1,1.35/speed);return{panX:velocity.panX*scale,panY:velocity.panY*scale};
}
export function stepGraphCameraMotion(camera:Camera,motion:GraphCameraMotion,elapsed:number,reducedMotion:boolean){
 const dt=Math.min(48,Math.max(1,elapsed)),target={...motion.target};let velocity={...motion.velocity};
 if(!reducedMotion&&Math.hypot(velocity.panX,velocity.panY)>=.018){target.panX+=velocity.panX*dt;target.panY+=velocity.panY*dt;const friction=Math.exp(-.012*dt);velocity={panX:velocity.panX*friction,panY:velocity.panY*friction};}else velocity={panX:0,panY:0};
 const result=stepCamera(camera,target,motion.anchor,dt,reducedMotion);return{camera:result.camera,motion:{target,velocity,anchor:motion.anchor},active:result.moving||Math.hypot(velocity.panX,velocity.panY)>=.018};
}
