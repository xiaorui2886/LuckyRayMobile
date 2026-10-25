import test from 'node:test';
import assert from 'node:assert/strict';
import {localBacklinksFor} from '../src/still/kit/localBacklinks.ts';
const catalog=[{noteId:'note-a',title:'Alpha',folder:'Projects',historicalNames:['Old Alpha']},{noteId:'note-b',title:'Beta',folder:''}];
test('local backlink display resolves stable IDs, aliases and qualified paths once per source',()=>{
 const rows=[{noteId:'note-b',title:'Beta',content:'before\n[[Projects/Alpha]] and [[Old Alpha]]\nafter'},{noteId:'note-c',title:'Gamma',content:'[[note-a#Heading]]'},{noteId:'note-a',title:'Alpha',content:'[[Alpha]]'}];
 const found=localBacklinksFor('note-a',rows,catalog);
 assert.deepEqual(found.map(n=>n.noteId),['note-b','note-c']);assert.equal(found[0].excerpt,'[[Projects/Alpha]] and [[Old Alpha]]');
});
test('ambiguous titles, other targets, code and invalid claims are not asserted as backlinks',()=>{
 const notes=[...catalog,{noteId:'note-x',title:'Alpha',folder:'Elsewhere'}];
 const rows=[{noteId:'note-b',title:'Beta',content:'[[Alpha]] `[[note-a]]`\n```\n[[Projects/Alpha]]\n```\n[[../Alpha]]'}];
 assert.deepEqual(localBacklinksFor('note-a',rows,notes),[]);
});

import {noteFolderTree} from '../src/still/kit/noteFolderTree.ts';
test('folder index retains empty folders and implicit ancestors without unsafe paths',()=>{
 const tree=noteFolderTree(['Empty','Research/Ideas/2026','Research/Ideas','../Hidden','/Wrong','']);
 assert.deepEqual(tree.get(''),['Empty','Research']);assert.deepEqual(tree.get('Research'),['Research/Ideas']);assert.deepEqual(tree.get('Research/Ideas'),['Research/Ideas/2026']);
});

import {scanLocalBacklinks} from '../src/still/kit/localBacklinkScanner.ts';
import {localWikiReferences} from '../src/still/kit/localWiki.ts';
test('long incoming-link documents use local cancellable worker parsing',async()=>{
 const Original=globalThis.Worker;let posts=0,ended=0;
 class WorkerMock {onmessage:any;terminated=false;postMessage(job:any){posts++;queueMicrotask(()=>{if(!this.terminated)this.onmessage?.({data:{id:job.id,result:localWikiReferences(job.source)}})})} terminate(){if(!this.terminated)ended++;this.terminated=true}}
 globalThis.Worker=WorkerMock as any;
 try {const target={noteId:'target',title:'Target'};const row={noteId:'long',title:'Long',content:'paragraph '.repeat(1500)+'\n\n[[Target]]'};const scan=scanLocalBacklinks('target',[row],[target,row]);assert.equal((await scan.promise)[0].noteId,'long');assert.equal(posts,1);assert.equal(ended,1)}finally{globalThis.Worker=Original}
});
test('cancelled incoming-link scan cannot publish a completed final page',async()=>{
 const target={noteId:'target',title:'Target'},row={noteId:'other',title:'Other',content:'[[Target]]'};
 const scan=scanLocalBacklinks('target',[row],[target,row]);scan.cancel();await assert.rejects(scan.promise,/cancelled/);
});
test('unavailable long-document parser is an explicit retryable error, never empty results',async()=>{
 const Original=globalThis.Worker;globalThis.Worker=undefined as any;
 try{const row={noteId:'other',title:'Other',content:'text '.repeat(3000)+'[[Target]]'};await assert.rejects(scanLocalBacklinks('target',[row],[{noteId:'target',title:'Target'},row]).promise,/无法完成长笔记/)}finally{globalThis.Worker=Original}
});
