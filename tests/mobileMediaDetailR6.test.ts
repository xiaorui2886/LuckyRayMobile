import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openInlineMediaLease, type MediaGrant } from "../src/still/kit/inlineMediaLease.ts";
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides: Partial<Parameters<typeof openInlineMediaLease>[0]> = {}) {
  const urls: string[] = [], released: string[] = [], failures: unknown[] = [];
  let streamed = 0, cancelled = 0;
  const close = openInlineMediaLease({
    cached: async () => ({url:"private-cache", token:"cache-token"}),
    stream: async () => { streamed++; return {url:"private-stream", token:"stream-token"}; },
    ready: value => urls.push(value), failed: error => failures.push(error),
    release: async value => { released.push(value); }, cancel: async () => {cancelled++;}, ...overrides,
  });
  return {close, urls, released, failures, streamed:()=>streamed, cancelled:()=>cancelled};
}
test("cached playback uses one lease and closes idempotently", async () => {
  const h=harness(); await tick(); assert.deepEqual(h.urls,["private-cache"]); assert.equal(h.streamed(),0);
  h.close(); h.close(); assert.deepEqual(h.released,["cache-token"]); assert.equal(h.cancelled(),1);
});
test("uncached desktop playback uses existing Range authority", async () => {
  const h=harness({cached:async()=>{throw new Error("CONTENT_NOT_CACHED");}}); await tick();
  assert.deepEqual(h.urls,["private-stream"]); assert.equal(h.streamed(),1); h.close(); assert.deepEqual(h.released,["stream-token"]);
});
test("permission or owner failure does not fall through to streaming", async () => {
  for (const code of ["CONTENT_FORBIDDEN","CONTENT_SOURCE_CHANGED","CONTENT_REVOKED","CONTENT_VERSION_CHANGED"]) {
    const h=harness({cached:async()=>{throw new Error(code);}}); await tick();
    assert.equal(h.streamed(),0); assert.equal(h.failures.length,1); assert.deepEqual(h.urls,[]); h.close();
  }
});
test("leaving during grant acquisition releases the late grant without displaying it", async () => {
  let resolve!: (grant:MediaGrant)=>void;
  const h=harness({cached:()=>new Promise(r=>{resolve=r;})}); h.close();
  resolve({url:"stale",token:"late-token"}); await tick();
  assert.deepEqual(h.urls,[]); assert.deepEqual(h.released,["late-token"]);
});
test("leaving during cache miss never starts a new stream", async () => {
  let reject!: (error:Error)=>void;
  const h=harness({cached:()=>new Promise((_r,j)=>{reject=j;})}); h.close();
  reject(new Error("CONTENT_NOT_CACHED")); await tick(); assert.equal(h.streamed(),0); assert.equal(h.failures.length,0);
});
test("late streamed grant is released on owner change", async () => {
  let resolve!: (grant:MediaGrant)=>void;
  const h=harness({cached:async()=>{throw new Error("CONTENT_NOT_CACHED");},stream:()=>new Promise(r=>{resolve=r;})});
  await tick(); h.close(); resolve({url:"old-owner",token:"old-owner-token"}); await tick();
  assert.deepEqual(h.urls,[]); assert.deepEqual(h.released,["old-owner-token"]);
});
const asset=readFileSync(new URL("../src/still/StillAsset.tsx",import.meta.url),"utf8");
const player=readFileSync(new URL("../src/still/InlineAssetVideo.tsx",import.meta.url),"utf8");
const tile=readFileSync(new URL("../src/still/kit/mediaTile.tsx",import.meta.url),"utf8");
test("captionless cards preserve accessible names and selection gestures",()=>{
  assert.ok(tile.includes('aria-label={`${title}，${meta}`}'));
  assert.ok(!tile.includes('<strong>{title}</strong>')); assert.ok(!tile.includes('<small>{meta}</small>'));
  assert.ok(tile.includes('{...press.handlers}')); assert.ok(tile.includes('aria-pressed={selecting ? selected : undefined}'));
});
test("detail uses inline controls and keeps destructive confirmation local",()=>{
  assert.ok(player.includes('playsInline preload="metadata"'));
  assert.ok(player.includes('aria-label="播放进度"'));
  assert.ok(player.includes('element?.pause()')); assert.ok(player.includes('element?.removeAttribute("src")'));
  assert.ok(!asset.includes('className="st-asset-caption"'));
  assert.ok(asset.includes('<AssetHeader title={asset.name} back={back} />'));
  assert.ok(asset.includes('<Sheet title="删除这条素材？"'));
  assert.ok(asset.includes('手机暂不支持删除电脑素材'));
  assert.ok(asset.includes('org.subscribe(setOrgSnapshot)'));
  assert.ok(asset.includes('favoritePending.current = true')); 
  assert.ok(asset.includes('aria-pressed={active}'));
});
test("image chrome overlays the full stage while video controls keep their space",()=>{
  const css=readFileSync(new URL("../src/still/assetDetail.css",import.meta.url),"utf8");
  assert.match(css,/\.st-asset-view\.is-image \.st-asset-area \{ position:absolute; inset:0; height:100%;/);
  assert.match(css,/\.st-asset-view\.is-image \.st-asset-actions \{ position:absolute;/);
  assert.match(css,/object-fit:contain/);
  assert.match(css,/data-mode=dark/);
  assert.match(css,/var\(--st-safe-bottom\)/);
  assert.ok(!css.includes('.st-asset-view .st-asset-actions { position:absolute'));
});
test("local inline video uses validated Range lease, never a raw WebView asset URL",()=>{
  const inline=player;
  assert.ok(inline.includes('api.localAssetMediaSource(id)'));
  assert.ok(!inline.includes('convertFileSrc('));
  const rust=readFileSync(new URL('../src-tauri/src/content.rs',import.meta.url),'utf8');
  const helper=rust.slice(rust.indexOf('fn local_video_source'),rust.indexOf('/// Range-capable inline'));
  for(const guard of ['db.asset_get(', 'check_integrity(', 'source.parent()!=Some(root.as_path())', 'MEDIA_TYPE_UNSUPPORTED']) assert.ok(helper.includes(guard));
  assert.equal((rust.match(/local_video_source\(&state, &asset_id\)/g)||[]).length,2);
});
