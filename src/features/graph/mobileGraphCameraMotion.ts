/** Touch adaptation of the accepted desktop graph pan motion (41e21490). */
import {stepCamera,type Camera,type ZoomPoint} from './core/graphCamera.ts';
export type GraphPanVelocity={panX:number;panY:number};
export type GraphCameraMotion={target:Camera;velocity:GraphPanVelocity;anchor:ZoomPoint|null};
const STOP_SPEED=.002;
const FRICTION=-Math.log(.9)/(1000/60);
export function sampleGraphPanVelocity(previous:GraphPanVelocity,dx:number,dy:number,elapsed:number):GraphPanVelocity{
 const dt=Math.max(1,elapsed),blend=elapsed>100?1:1-Math.exp(-dt/16);
 // Discard opposite-axis momentum for a deliberate reversal, but smooth 1–2 px touch noise.
 const x=elapsed>100||previous.panX*dx<0&&Math.abs(dx)>2?0:previous.panX,y=elapsed>100||previous.panY*dy<0&&Math.abs(dy)>2?0:previous.panY;
 return{panX:x+(dx/dt-x)*blend,panY:y+(dy/dt-y)*blend};
}
export function releaseGraphPanVelocity(velocity:GraphPanVelocity,pointerType:string,reducedMotion:boolean,sampleAge=0):GraphPanVelocity {
 const speed=Math.hypot(velocity.panX,velocity.panY);if(pointerType!=='touch'||reducedMotion||sampleAge>100||speed<STOP_SPEED)return{panX:0,panY:0};const scale=Math.min(1,1.35/speed);return{panX:velocity.panX*scale,panY:velocity.panY*scale};
}
export function stepGraphCameraMotion(camera:Camera,motion:GraphCameraMotion,elapsed:number,reducedMotion:boolean){
 const dt=Math.min(48,Math.max(1,elapsed)),target={...motion.target};let velocity={...motion.velocity};
 if(!reducedMotion&&Math.hypot(velocity.panX,velocity.panY)>=STOP_SPEED){
  const friction=Math.exp(-FRICTION*dt),distance=(1-friction)/FRICTION;
  target.panX+=velocity.panX*distance;target.panY+=velocity.panY*distance;
  velocity={panX:velocity.panX*friction,panY:velocity.panY*friction};
  const active=Math.hypot(velocity.panX,velocity.panY)>=STOP_SPEED;
  if(!active)velocity={panX:0,panY:0};
  return{camera:{...target},motion:{target,velocity,anchor:motion.anchor},active};
 }
 velocity={panX:0,panY:0};const result=stepCamera(camera,target,motion.anchor,dt,reducedMotion);
 return{camera:result.camera,motion:{target,velocity,anchor:motion.anchor},active:result.moving};
}
