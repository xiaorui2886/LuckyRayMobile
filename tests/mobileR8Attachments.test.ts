import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicationTarget, withLocalNoteAttachments } from '../src/services/localNoteAttachments.ts';
import { cachedResources } from '../src/services/noteProvenance.ts';
import { NoteResourceSession, type ResourceView } from '../src/services/noteResourceSession.ts';
const attachment = { opId:'op-a', name:'图.jpg', mimeType:'image/jpeg', version:'a'.repeat(64), publicationMarkdown:'![[attachments/图.jpg]]' };
const scope={instance:'desktop-a',vault:'vault-a',note:'note-a'};
test('publication aliases come from exact markdown receipt, not original basename',()=>{
 assert.equal(publicationTarget('![[attachments/图.jpg]]'),'attachments/图.jpg');
 assert.equal(publicationTarget('[[attachments/a.pdf]]'),'attachments/a.pdf');
 assert.equal(publicationTarget('![图](attachments/a%20b.png)'),'attachments/a%20b.png');
 assert.equal(publicationTarget('[文件](<attachments/a b.pdf>)'),'attachments/a b.pdf');
 for(const s of ['text ![[x.png]]','```\n![[x.png]]\n```','![[a.png]] ![[b.png]]','<script>bad</script>']) assert.equal(publicationTarget(s),null);
 const r=withLocalNoteAttachments([], [attachment]);
 assert.deepEqual(r.map(x=>x.target),['luckyray-attachment:op-a','attachments/图.jpg']);
 assert(!r.some(x=>x.target==='图.jpg'));
 assert(r.every(x=>x.localOnly&&x.localAttachmentId==='op-a'));
});
test('cached resources retain exact remote ownership and never alias by filename',()=>{
 const remote={resourceId:'remote-a',target:'attachments/图.jpg',status:'resolved',version:'a'.repeat(64),mimeType:'image/jpeg'};
 const note={cachedDocument:{resources:[remote]},localAttachments:[attachment]};
 const r=cachedResources(note);const final=r.find(x=>x.target===remote.target);
 assert.equal(final.resourceId,'remote-a');assert.equal(final.version,'a'.repeat(64));assert.equal(final.localAttachmentId,undefined);assert(!final.localOnly);
 assert.equal((remote as any).localAttachmentId,undefined);
 const changed=withLocalNoteAttachments([{...remote,version:'new-file-version'}],[attachment]).find(x=>x.target===remote.target)!;
 assert.equal(changed.localAttachmentId,undefined,'same name never proves same bytes');
 const denied=withLocalNoteAttachments([{...remote,status:'denied'}],[attachment]).find(x=>x.target===remote.target)!;
 assert.equal(denied.status,'denied');assert.equal(denied.localAttachmentId,undefined);
});
test('pending and completed attachments reopen offline from scoped native local bytes without remote download',async()=>{
 for(const target of ['luckyray-attachment:op-a','attachments/图.jpg']){
  const views:ResourceView[]=[];const calls:any[]=[];
  const resource=withLocalNoteAttachments([],[attachment]).find(r=>r.target===target)!;
  const session=new NoteResourceSession(scope,resource,{
   contentCachedResource:async()=>{throw Error('no cache')},
   contentNoteLocalAttachment:async(...args)=>{calls.push(args);return{path:'scoped-cache.jpg',mime:'image/jpeg'}},
   contentNoteResource:async()=>{throw Error('must not fetch local ID')},contentCancel:async()=>{},
  },v=>views.push(v),false);
  await session.start();assert.equal(views.at(-1)?.file?.path,'scoped-cache.jpg');assert.deepEqual(calls,[[...Object.values(scope),'op-a']]);session.retire();
 }
});
test('late local fallback cannot publish after cancel/retire or supersede a completed download',async()=>{
 for(const action of ['cancel','retire','download'] as const){
  let resolve!:(v:{path:string;mime:string})=>void;
  const pending=new Promise<{path:string;mime:string}>(r=>resolve=r);const views:ResourceView[]=[];
  const session=new NoteResourceSession(scope,{resourceId:'remote',target:'a.jpg',status:'resolved',mimeType:'image/jpeg',localAttachmentId:'op-a'}, {
   contentCachedResource:async()=>{throw Error()},contentNoteLocalAttachment:async()=>pending,
   contentNoteResource:async()=>({path:'new.jpg',mime:'image/jpeg'}),contentCancel:async()=>{},
  },v=>views.push(v));
  const start=session.start();await new Promise(r=>setTimeout(r,0));await session[action]();
  resolve({path:'late.jpg',mime:'image/jpeg'});await start;
  assert(!views.some(v=>v.file?.path==='late.jpg'));session.retire();
 }
});
test('remote download refreshes local upload fallback online and local-only IDs never go on wire',async()=>{
 let downloads=0;const views:ResourceView[]=[];
 const effects={contentCachedResource:async()=>{throw Error()},contentNoteLocalAttachment:async()=>({path:'own.jpg',mime:'image/jpeg'}),contentNoteResource:async()=>{downloads++;return{path:'fresh.jpg',mime:'image/jpeg'}},contentCancel:async()=>{}};
 const local=withLocalNoteAttachments([],[attachment])[0];const localSession=new NoteResourceSession(scope,local,effects,v=>views.push(v));await localSession.start();assert.equal(downloads,0);localSession.retire();
 const remote={...local,resourceId:'remote',localOnly:false};const session=new NoteResourceSession(scope,remote,effects,v=>views.push(v));await session.start();assert.equal(downloads,1);assert.equal(views.at(-1)?.file?.path,'fresh.jpg');session.retire();
});
test('native local attachment path scope and bounded verified cache contract is wired',()=>{
 const rust=readFileSync(new URL('../src-tauri/src/content/notes/uploads.rs',import.meta.url),'utf8');
 for(const check of ['content_local_attachment_file(&instance, &vault, &note, &op)','source.parent() != Some(root.as_path())','metadata.len() != size','file.take(size + 1)','Sha256::digest(&bytes)','content-resources','c.is_ascii_hexdigit()'])assert(rust.includes(check),check);
 const config=readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8');assert(!config.includes('content-drafts/**'));
});

test('more than 256 scoped attachments remain visible and conflicting receipt paths never guess bytes',()=>{
 const many=Array.from({length:257},(_,i)=>({...attachment,opId:`op-${i}`,publicationMarkdown:`![[attachments/${i}.jpg]]`}));
 const r=withLocalNoteAttachments([],many);
 assert(r.some(x=>x.target==='attachments/256.jpg'));
 const conflict=withLocalNoteAttachments([],[attachment,{...attachment,opId:'op-new',version:'b'.repeat(64)}]);
 assert(!conflict.some(x=>x.target==='attachments/图.jpg'));
 assert.equal(conflict.length,2);
 const same=withLocalNoteAttachments([],[attachment,{...attachment,opId:'op-same'}]);
 assert.equal(same.filter(x=>x.target==='attachments/图.jpg').length,1);
 const db=readFileSync(new URL('../src-tauri/src/content_db.rs',import.meta.url),'utf8');
 assert(!db.slice(db.indexOf('pub(crate) fn content_local_attachments'),db.indexOf('/// Native-only lookup.')).includes('LIMIT 256'));
});
test('authoritative remote resource downloads online then reopens cached offline; uncached offline never substitutes original', async()=>{
 const remote={resourceId:'desktop-resource',target:'attachments/图.jpg',status:'resolved',version:'123-987654321',mimeType:'image/jpeg'};
 const resource=withLocalNoteAttachments([remote],[attachment]).find(x=>x.target===remote.target)!;
 let cached:{path:string;mime:string}|undefined;let downloads=0;let originals=0;
 const effects={contentCachedResource:async()=>{if(!cached)throw Error('not cached');return cached;},
  contentNoteLocalAttachment:async()=>{originals++;return{path:'old-original.jpg',mime:'image/jpeg'};},
  contentNoteResource:async()=>{downloads++;cached={path:'current-desktop-version.jpg',mime:'image/jpeg'};return cached;},contentCancel:async()=>{}};
 const missingViews:ResourceView[]=[];
 const missing=new NoteResourceSession(scope,resource,effects,v=>missingViews.push(v),false);
 await missing.start();assert(!missingViews.at(-1)?.file);assert.equal(downloads,0);assert.equal(originals,0);missing.retire();
 const onlineViews:ResourceView[]=[];
 const online=new NoteResourceSession(scope,resource,effects,v=>onlineViews.push(v),true);
 await online.start();assert.equal(downloads,1);assert.equal(onlineViews.at(-1)?.file?.path,'current-desktop-version.jpg');online.retire();
 const offlineViews:ResourceView[]=[];
 const offline=new NoteResourceSession(scope,resource,effects,v=>offlineViews.push(v),false);
 await offline.start();assert.equal(offlineViews.at(-1)?.file?.path,'current-desktop-version.jpg');assert.equal(downloads,1);assert.equal(originals,0);offline.retire();
});
