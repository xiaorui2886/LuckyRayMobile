import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compositeBarColor, parseBarColor, systemBarUpdater} from '../src/services/systemBarAppearance.ts';
const read=(p:string)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('CSS source-over uses round-to-nearest and composites each nested scrim exactly once',()=>{
 const base=parseBarColor('rgb(241, 242, 245)')!,scrim=parseBarColor('rgba(29, 31, 40, 0.3)')!;
 assert.equal(compositeBarColor(base,[]),0xf1f2f5);
 assert.equal(compositeBarColor(base,[{color:scrim,opacity:1}]),0xb1b3b8);
 assert.equal(compositeBarColor(base,[{color:scrim,opacity:.5}]),0xd1d2d6);
 assert.equal(compositeBarColor(base,[{color:scrim,opacity:1},{color:scrim,opacity:1}]),0x85868c);
 assert.equal(compositeBarColor(parseBarColor('rgb(10, 10, 12)')!,[{color:parseBarColor('rgba(3, 3, 5, .64)')!,opacity:1}]),0x060608);
});
test('rejected/in-flight bridge colors cannot reorder reopen or theme changes',async()=>{
 const calls:any[]=[];const done:{resolve:()=>void;reject:()=>void}[]=[];
 const updater=systemBarUpdater((...args)=>new Promise<void>((resolve,reject)=>{calls.push(args);done.push({resolve,reject:()=>reject(Error('native unavailable'))})}));
 updater.request(false,true,0xb1b3b8,0xf1f2f5);
 updater.request(false,false,0xf1f2f5,0xf1f2f5);
 updater.request(true,true,0x060608,0x0a0a0c);
 assert.equal(calls.length,1);done[0].reject();await tick();
 assert.deepEqual(calls[1],[true,true,0x060608,0x0a0a0c]);
 updater.dispose();done[1].resolve();await tick();updater.request(false,false);assert.equal(calls.length,2);
});
test('same appearance bridge applies opaque precomposited RGB without a second native dim or inset changes',()=>{
 const kotlin=read('scripts/android-src/DeviceBridge.kt'),rust=read('src-tauri/src/device.rs'),command=read('src-tauri/src/lib.rs');
 assert(kotlin.includes('statusRgb in 0..0xffffff) opaque(statusRgb) else fallbackStatus'));
 assert(kotlin.includes('navigationRgb in 0..0xffffff) opaque(navigationRgb) else base'));
 assert(kotlin.includes('.roundToInt()'));assert(!kotlin.includes('setPadding('));
 assert(rust.includes('"(ZZII)V", &[dark.into(), dimmed.into(), status_rgb.into(), navigation_rgb.into()]'));
 assert(command.includes('status_rgb: Option<i32>, navigation_rgb: Option<i32>'));
 const css=read('src/presentation/still01/defaultTheme.css');
 assert(css.includes('linear-gradient(to bottom,rgba(var(--st-chrome-rgb),1),rgba(var(--st-chrome-rgb),.72)'));
 const main=read('scripts/android-src/MainActivity.kt');assert(main.includes('val bottom = maxOf(safe.bottom, ime.bottom)'));assert(main.includes('view.setPadding(safe.left, safe.top, safe.right, bottom)'));
});
