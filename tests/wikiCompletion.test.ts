import test from 'node:test';import assert from 'node:assert/strict';
import {wikiCompletionAt, wikiInsertion,sameWikiCompletion} from '../src/presentation/still01/editor/wikiCompletion.ts';
test('open/closed token exact ranges with caret in middle',()=>{
 assert.deepEqual(wikiCompletionAt('hello [[笔',9),{from:6,to:9,query:'笔',token:'[[笔'});
 assert.deepEqual(wikiCompletionAt('[[]]',2),{from:0,to:4,query:'',token:'[[]]'});
 assert.deepEqual(wikiCompletionAt('[[笔记]]',3),{from:0,to:6,query:'笔',token:'[[笔记]]'});
});
for(const doc of ['`[[no`','```md\n[[no\n```','\\[[no','[[x|no','[[x#no','[label [[no]]](https://example.com)'])test('suppresses invalid/code/embed/alias context '+doc,()=>{
 const at=doc.includes('no')?doc.indexOf('no')+2:doc.length;assert.equal(wikiCompletionAt(doc,at),null);
});
test('stable local ID with label; unsafe syntax rejected',()=>{
 assert.equal(wikiInsertion({id:'note-a',title:'标题',target:'note-a'}),'[[note-a|标题]]');
 assert.equal(wikiInsertion({id:'a',title:'正文',target:'folder/正文.md'}),'[[folder/正文.md|正文]]');
 assert.equal(wikiInsertion({id:'a',title:'x',target:'a]]\nsecret'}),null);
});
test('changed token/range rejected and large docs bounded',()=>{
 assert.equal(sameWikiCompletion(wikiCompletionAt('[[a',3),wikiCompletionAt('[[b',3)),false);
 assert.equal(wikiCompletionAt('x'.repeat(250001)+'[[',250003),null);
});

test('attachment completion keeps embed syntax and source range',()=>{
 assert.deepEqual(wikiCompletionAt('![[im',5),{from:0,to:5,query:'im',token:'![[im',embed:true});
 assert.equal(wikiInsertion({id:'image',title:'photo.png',target:'attachments/photo.png'},true),'![[attachments/photo.png]]');
 assert.equal(wikiCompletionAt('\\![[no',6),null);
});
