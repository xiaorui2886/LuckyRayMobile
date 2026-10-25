import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assetSequenceNeighbor,assetSwipeDirection} from '../src/still/kit/assetSequence.ts';
import {mediaTime,boundedSeek,PLAYBACK_RATES} from '../src/still/kit/inlineVideoControls.ts';
import {NavigationController} from '../src/navigation.ts';
const items=['c','a','b'].map(id=>({route:`desktop:owner:${id}`,title:id,thumbnail:'',kind:'image'}));
test('sequence follows filtered sort snapshot, not IDs; boundaries never wrap',()=>{
 assert.equal(assetSequenceNeighbor(items,items[0].route,1)?.title,'a');
 assert.equal(assetSequenceNeighbor(items,items[1].route,-1)?.title,'c');
 assert.equal(assetSequenceNeighbor(items,items[0].route,-1),undefined);
 assert.equal(assetSequenceNeighbor(items,items[2].route,1),undefined);
 assert.equal(assetSequenceNeighbor(items,'absent',1),undefined);
});
test('sequence refuses source or desktop changes',()=>{
 for(const route of ['local:a','desktop:other:a'])assert.equal(assetSequenceNeighbor([items[0],{...items[1],route}],items[0].route,1),undefined);
});
test('only short, unambiguous horizontal swipes advance',()=>{
 assert.equal(assetSwipeDirection(-80,8,450),1); assert.equal(assetSwipeDirection(80,8,450),-1);
 for(const [x,y,t]of [[20,0,100],[80,70,100],[90,0,901],[0,100,100]])assert.equal(assetSwipeDirection(x,y,t),0);
});
test('rapid neighbor replacements keep list back navigation bounded',()=>{
 const nav=new NavigationController();nav.switchRoot('library');nav.pushDetail({tab:'library',detail:items[0].route});
 nav.pushDetail({tab:'library',detail:items[1].route});nav.pushDetail({tab:'library',detail:items[2].route});
 assert.equal(nav.current().detail,items[2].route);nav.goBack();assert.deepEqual(nav.current(),{tab:'library'});
});
test('media seek and timestamps reject invalid values',()=>{
 assert.equal(mediaTime(3661.9),'1:01:01');assert.equal(mediaTime(NaN),'0:00');assert.equal(mediaTime(-3),'0:00');
 assert.equal(boundedSeek(120,90),90);assert.equal(boundedSeek(-3,90),0);assert.equal(boundedSeek(Infinity,90),0);assert.equal(boundedSeek(3,NaN),0);
 assert.ok(PLAYBACK_RATES.includes(1));assert.equal(PLAYBACK_RATES.at(-1),2);
});
const read=(name:string)=>readFileSync(new URL('../src/still/'+name,import.meta.url),'utf8');
test('presentation contract: no empty native control flash and fullscreen stays in viewer',()=>{
 const player=read('InlineAssetVideo.tsx'),asset=read('StillAsset.tsx'),css=read('assetDetail.css');
 assert.doesNotMatch(player,/<video[^>]*\bcontrols(?:\s|=)/);assert.match(player,/playsInline preload="metadata"/);
 assert.match(asset,/pendingVideo=\{/);assert.match(css,/\.st-inline-video video\{[^}]*opacity:0/);
 for(const name of ['播放进度','播放速度','退出全屏','静音'])assert.ok(player.includes(name));
 assert.ok(player.includes('overlayStack.push(close)'));assert.ok(player.includes('requestFullscreen'));
 assert.match(css,/\.st-asset-view \.st-asset-area\.is-video-fullscreen\{position:absolute;inset:0/);
 assert.ok(asset.includes('event.isPrimary === false'));
 assert.ok(asset.includes('suppressTrailingSwipeClick(event.currentTarget.ownerDocument)'));
 assert.ok(asset.indexOf('suppressTrailingSwipeClick(event.currentTarget.ownerDocument)') < asset.indexOf('event.preventDefault(); go(direction)'));
 assert.ok(asset.includes('event.pointerType === "mouse"'));assert.ok(asset.includes('[data-media-zoomed="true"]'));
 assert.ok(player.includes('api.contentMediaSource(owner, id, undefined, undefined, library)'));assert.ok(player.includes('api.localAssetMediaSource(id)'));
});
