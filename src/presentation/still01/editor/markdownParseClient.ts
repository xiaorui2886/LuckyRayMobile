import type {NoteResource} from '../../../services/noteResourceSession';
/** Dense short notes parse synchronously; longer notes stay off the input
 * thread, including when a module Worker needs a classic compatibility retry. */
export const SYNC_MARKDOWN_LIMIT=12_000;
export const ASYNC_MARKDOWN_LIMIT=250_000;
export type MarkdownParseKind='preview'|'images'|'wiki';
type Request={id:number;source:string;resources:NoteResource[]};
/** One worker, one running job, one replaceable newest request per owner.
 * Everything remains local. No document data is sent to a remote service. */
export class MarkdownParseClient<T> {
 private worker:Worker|null=null;private timer:ReturnType<typeof setTimeout>|undefined;private deadline:ReturnType<typeof setTimeout>|undefined;
 private pending:Request|null=null;private active:Request|null=null;private running=false;private revision=0;private dead=false;
 private transport:'module'|'classic'|'unavailable'='module';
 private kind:MarkdownParseKind;private result:(value:T,id:number)=>void;private unavailable:()=>void;
 constructor(kind:MarkdownParseKind,result:(value:T,id:number)=>void,unavailable:()=>void){this.kind=kind;this.result=result;this.unavailable=unavailable}
 request(source:string,resources:NoteResource[],immediate=false):number{
  const id=++this.revision;this.pending={id,source,resources};clearTimeout(this.timer);
  this.timer=setTimeout(()=>this.flush(),immediate?0:160);return id;
 }
 private fail=()=>{
  if(this.dead)return;
  this.worker?.terminate();this.worker=null;this.running=false;clearTimeout(this.deadline);
  // Keep only the newest source. A failure from an old request never replaces
  // a newer document, and an obsolete worker cannot deliver into the new one.
  if(!this.pending&&this.active?.id===this.revision)this.pending=this.active;
  this.active=null;
  this.transport=this.transport==='module'&&typeof Worker!=='undefined'?'classic':'unavailable';
  clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush(),160);
 };
 private flush(){
  if(this.dead||this.running||!this.pending)return;
  if(this.transport==='unavailable'||typeof Worker==='undefined'){
   this.transport='unavailable';this.pending=null;this.unavailable();return;
  }
  if(!this.worker){try{
   // Vite emits a self-contained IIFE worker in production. Classic fallback
   // also covers Android WebViews that reject module workers on app origins.
   this.worker=this.transport==='module'
    ?new Worker(new URL('./markdownPreview.worker.ts',import.meta.url),{type:'module'})
    :new Worker(new URL('./markdownPreview.worker.ts',import.meta.url),{type:'classic'});
   const owner=this.worker;
   this.worker.onmessage=e=>{if(this.worker!==owner)return;clearTimeout(this.deadline);this.running=false;if(this.dead)return;const {id,result,error}=e.data||{};if(error){this.fail();return}this.active=null;if(id===this.revision)this.result(result,id);this.flush()};
   this.worker.onerror=()=>{if(this.worker===owner)this.fail()};this.worker.onmessageerror=()=>{if(this.worker===owner)this.fail()};
  }catch{this.fail();return}}
  const job=this.pending;this.pending=null;this.active=job;this.running=true;this.deadline=setTimeout(this.fail,15_000);
  try{this.worker.postMessage({...job,kind:this.kind})}catch{this.fail()}
 }
 cancel(){this.revision++;this.pending=null;this.active=null;this.running=false;clearTimeout(this.timer);clearTimeout(this.deadline);this.worker?.terminate();this.worker=null}
 destroy(){this.dead=true;this.cancel()}
}
