import test from 'node:test';
import assert from 'node:assert/strict';
import {wikiCompletionAt,wikiCompletionAnchor,wikiCompletionInsertion,wikiResourceChoices,mergeWikiChoices} from '../src/presentation/still01/editor/wikiCompletion.ts';
const note={id:'n',title:'New title',target:'folder/New.md'};
test('target edit preserves explicit alias and heading, never subsequent prose',()=>{
 const body='prefix [[folder/Old.md#Section|Display name]] suffix [[another]]';
 const at=body.indexOf('Old')+2, match=wikiCompletionAt(body,at)!;
 assert.equal(wikiCompletionAnchor(match),at);
 assert.equal(wikiCompletionInsertion(note,match),'[[folder/New.md#Section|Display name]]');
 assert.equal(body.slice(0,match.from)+wikiCompletionInsertion(note,match)+body.slice(match.to),'prefix [[folder/New.md#Section|Display name]] suffix [[another]]');
 assert.equal(wikiCompletionAt(body,body.indexOf('Display')+2),null);
});
test('attachment edits preserve embed and image size alias',()=>{
 const body='![[attachments/phot.jpg|240]] trailing';
 const match=wikiCompletionAt(body,body.indexOf('.jpg'))!;
 assert.equal(wikiCompletionInsertion({id:'r',title:'photo.jpg',target:'attachments/photo.jpg'},match),'![[attachments/photo.jpg|240]]');
 assert.equal(body.slice(match.to),' trailing');
});
test('empty closed token supports candidates; separate tokens cannot be consumed',()=>{
 assert.equal(wikiCompletionAnchor(wikiCompletionAt('[[]]',2)!),2);
 assert.equal(wikiCompletionAt('[[a [[b]]',3),null);
});
test('attachment candidates survive a deleted character and never expose internal placeholders',()=>{
 const resources=[{resourceId:'a',target:'attachments/photo.jpg',status:'resolved'},{resourceId:'a2',target:'attachments/photo.jpg',status:'resolved'},
 {resourceId:'pending',target:'luckyray-attachment:operation',status:'resolved'},{resourceId:'bad',target:'/secret.png',status:'resolved'},
 {resourceId:'missing',target:'attachments/not-known.jpg',status:'missing'}];
 assert.deepEqual(wikiResourceChoices(resources,'attachments/phto.jpg').map(x=>x.id),['a']);
 assert.deepEqual(wikiResourceChoices(resources,'').map(x=>x.id),['a']);
});
test('ordinary wikilink choices combine notes and attachments without duplicates or starvation',()=>{
 const notes=Array.from({length:12},(_,i)=>({id:'n'+i,title:'note'+i,target:'note'+i+'.md'}));
 const attachment={id:'a',title:'photo.jpg',target:'attachments/photo.jpg'};
 const result=mergeWikiChoices(notes,[attachment,attachment]);
 assert.equal(result.length,12);assert.equal(result[1].target,attachment.target);
 assert.equal(result.filter(r=>r.target===attachment.target).length,1);
});
