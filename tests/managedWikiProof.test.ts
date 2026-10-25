import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {managedWikiProof} from '../src/still/kit/managedWikiProof.ts';
import {localWikiReferences} from '../src/still/kit/localWiki.ts';
const proof=(content:string)=>managedWikiProof({sourceNoteId:'note-a',sourceSha256:createHash('sha256').update(content).digest('hex'),content});
test('AST proofs preserve UTF8 exact token ranges with Unicode, lists and GFM tables',()=>{
 const body='中文😀\r\n- [[@id/note-b#标题|别名]]\n\n| 列 |\n| --- |\n| [[Other]] |';
 const result=proof(body), bytes=Buffer.from(body);
 assert.deepEqual(result.spans.map(s=>s.token),['[[@id/note-b#标题|别名]]','[[Other]]']);
 for(const s of result.spans) assert.equal(bytes.subarray(s.startByte,s.endByte).toString(),s.token);
 assert.equal(result.spans[0].startByte,Buffer.byteLength('中文😀\r\n- '));
 assert.deepEqual(result.resourceIssues,[]);
 assert.deepEqual(Object.keys(result).sort(),['resourceIssues','sourceNoteId','sourceSha256','spans']);
});
test('proof parser is differential with reader AST, not a global token scanner',()=>{
 const body=['- ordinary bullet','`[[inline]]`','```md','[[fenced]]','```','    [[indented]]','<div>[[html]]</div>','','\\[[escaped]]','[ [[label]] ](https://example.test)','https://example.test/[[url]]','','[[real]]'].join('\n');
 const result=proof(body);
 assert.deepEqual(result.spans.map(s=>s.token),localWikiReferences(body).map(r=>body.slice(r.from,r.to)));
 assert.deepEqual(result.spans.map(s=>s.token),['[[real]]']);
 assert.deepEqual(result.resourceIssues,[]);
});
test('AST local resources and HTML resources are explicit blockers, literals are not',()=>{
 for(const body of ['![[image.png]]','![alt](photo.png)','[note](../note.md)','[note][n]\n\n[n]: relative.md','<img src="asset.png">','<style>body{background:url(local.png)}</style>']) assert.ok(proof(body).resourceIssues.length,body);
 for(const body of ['`![alt](photo.png)`','```\n<img src="a">\n```','![remote](https://example.test/a.png)','[web](https://example.test)','plain bullet\n- one']) assert.deepEqual(proof(body).resourceIssues,[],body);
});
test('transfer frontend passes parser proof only and native remains rewrite authority',()=>{
 const ui=readFileSync(new URL('../src/still/kit/UnifiedNotesView.tsx',import.meta.url),'utf8');
 const service=readFileSync(new URL('../src/services/managedVault.ts',import.meta.url),'utf8');
 assert.match(ui,/parseInputs\?\.map\(managedWikiProof\)/);
 assert.match(ui,/requiresConnection/);
 assert.match(service,/wikiProofs \? \{ wikiProofs \} : \{\}/);
});

test('inline HTML mixed runs are preserved and explicitly blocked, never rewritten as wiki',()=>{
 const result=proof('prefix <span>[[literal]]</span>');
 assert.deepEqual(result.spans,[]);
 assert.ok(result.resourceIssues.includes('mixed-html-wiki:0'));
});
