import type {Camera} from './core/graphCamera.ts';
/** Compare values, not React object identity: unrelated renders cannot restore an old viewport. */
export function graphCameraSignature(camera?:Camera):string {return camera?`${camera.scale}:${camera.panX}:${camera.panY}`:'';}
/** Activation is part of the solver mutation revision, including reverse seek and playback stop. */
export function graphActivationTransition(previous:string,ids:readonly number[],alpha:number,revision:number){
 const key=ids.join(',');return {key,changed:key!==previous,alpha:key!==previous?Math.max(alpha,.4):alpha,revision:revision+(key!==previous?1:0)};
}
