import { normalizeNoteChrome } from './noteChromeAuthority.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read=(p:string)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const css=read('src/presentation/still01/defaultTheme.css');
function tokens(selector:string){const body=css.split(selector+' {')[1].split('}')[0];return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]]))}
function luminance(hex:string){const rgb=hex.replace('#','').match(/../g)!.map(n=>parseInt(n,16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722}
function contrast(a:string,b:string){const l=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (l[0]+.05)/(l[1]+.05)}
const light=tokens('.st-app'), dark=tokens('.st-app[data-mode=dark]');
test('production shell loads desktop-family colors after presentation imports',()=>{
 const shell=read('src/still/StillShell.tsx');
 const imports = [...shell.matchAll(/^import\s.*(?:from\s*)?["']([^"']+)["'];?$/gm)].map(m => m[1]);
 const themeIndex = imports.indexOf('../presentation/still01/defaultTheme.css');
 assert.ok(themeIndex >= 0);
 assert.deepEqual(imports.slice(themeIndex + 1), ['./kit/librarySurfaces.css'], 'only approved scoped library polish follows desktop palette');
 for (const path of imports.filter(p => p.includes('presentation/') && p !== '../presentation/still01/defaultTheme.css')) {
  assert.ok(imports.indexOf(path) < themeIndex, `${path} must precede default theme`);
 }
 assert.equal(dark['--st-canvas'],'#0a0a0c');assert.equal(dark['--st-sheet'],'#111114');assert.equal(dark['--st-surface'],'#1a1a1f');assert.equal(dark['--st-card'],'#151519');assert.equal(dark['--st-ink'],'#f0f0f2');assert.equal(dark['--st-accent'],'#7c8aff');
 assert.equal(light['--st-canvas'],'#f1f2f5');assert.equal(light['--st-ink'],'#18191f');
});
test('small semantic text and action labels meet 4.5:1 in both modes',()=>{
 for(const [mode,palette] of Object.entries({light,dark})){
  for(const fg of ['ink','secondary','muted','accent','danger','pending','success'])for(const bg of ['canvas','surface','sheet','card','selected']){
   const ratio=contrast(palette['--st-'+fg],palette['--st-'+bg]);
   assert.ok(ratio>=4.5,`${mode} ${fg}/${bg}: ${ratio.toFixed(2)}`);
  }
  assert.ok(contrast(palette['--st-on-action'],palette['--st-action'])>=4.5);
 }
});
test('focus and both reduced-motion preferences retain safe mobile geometry',()=>{
 assert.match(css,/button:focus-visible\s*\{[^}]*outline: 2px solid var\(--st-accent\)!important/);
 assert.match(css,/prefers-reduced-motion: reduce/);assert.match(css,/data-reduced=true/);
 assert.doesNotMatch(css,/--st-(?:page-x|nav-h|safe-bottom|safe-top):|\.st-editor-tools|\.st-note-title|\.st-cm-editor|@container|backdrop-filter|color-mix/);
});
test('color mode persistence and legacy preset palette stay byte-identical',()=>{
 const expected:Record<string,string> = {
  "src/services/appearance.ts": "47917ad1df72376d245214eb35580e263cd53de59a33ac2fbb9174223bef2241",
  "src/design/tokens.css": "5372941ed37518e55b383397fb151bce39b1102e5dcdf12ba39e75ec1e5c2e15",
  "src/app.css": "36f65079aa36984dd066fd3fdd4979fa6fed1fd83261411b6d922f5f7ff617df",
  "src/presentation/still01/Still.tsx": "0acc8d59d1ea8ad7262bdde4dceb12f93dd1f387e03b2b09c7a4e46f196ab707",
  "src/presentation/still01/still.css": "91110e7b5635b792f7858b6429a832a5793ba6a6e4e723cc5fb6d7d22089b894",
  "src/presentation/still01/editor/NoteActionIcon.tsx": "1b24ea429c6819652cda86a8e0a9b1cbe6d3b70329f2dbb5c233af0c1deb835c"
};
 for(const [path,hash] of Object.entries(expected)) {
  let source=read(path);
  if(path==='src/presentation/still01/Still.tsx') {
   // Normalize only this reviewed paper-scroll touch owner, not generic styles.
   const paperTouch = " {/* Touch arbitration stops at this scroll container, before the outer swipe owner. */}\n <main style={{touchAction:'pan-y'}} className={'st-note-paper'+(p.mode==='edit'?' is-editing':'')}>";
   assert.equal(source.split(paperTouch).length, 2, 'the actual scroll paper owns pan-y exactly once');
   source=source.replace(paperTouch, " <main className={'st-note-paper'+(p.mode==='edit'?' is-editing':'')}>");
   source=normalizeNoteChrome(source);
   const handoffStart=" <NoteBodyTransition mode={p.mode==='edit'&&editable?'edit':'read'} scope={p.editorScope} body={p.body} editor={p.bodyEditor??<textarea";
   assert.equal(source.split(handoffStart).length,2);
   assert.equal(source.split(' </div></NoteBodyTransition>').length,2);
   source=source.replace("import { NoteBodyTransition } from './editor/NoteBodyTransition';\n",'')
    .replace(handoffStart," {p.mode==='edit'&&editable?(p.bodyEditor??<textarea")
    .replace('spellCheck={false}/>}><div className=','spellCheck={false}/>):<div className=')
    .replace(' </div></NoteBodyTransition>',' </div>}')
    .replace('bodyEditor?:ReactNode;editorScope?:string}','bodyEditor?:ReactNode}');
  }
  if(path==='src/presentation/still01/still.css') {
   // Only the reviewed note-body parity repair is normalized. All theme,
   // toolbar, icon, gesture and unrelated CSS bytes remain under the old hash.
   assert.equal(source.split('.st-note-paper > h1').length,3);
   const gapRepair='/* Preserve CodeMirror virtual-document gap heights for long notes. */';
   assert.equal(source.split(gapRepair).length,2);
   source=source.replaceAll('.st-note-paper > h1','.st-note-paper h1').replace(gapRepair,'.st-note-editor.is-cm .cm-gap{display:none}');
  }
  assert.equal(createHash('sha256').update(source).digest('hex'),hash,path);
 }
});
test('native bars/player share the new canvas and scrim without changing inset logic',()=>{
 const bridge=read('scripts/android-src/DeviceBridge.kt'),player=read('scripts/android-src/MaterialsPlayerActivity.kt');
 assert.match(bridge,/Color.rgb\(10, 10, 12\) else Color.rgb\(241, 242, 245\)/);
 assert.match(bridge,/Color.rgb\(3, 3, 5\) else Color.rgb\(29, 31, 40\)/);
 assert.match(bridge,/if \(dark\) 0.64f else 0.30f/);
 assert.equal(player.split('"#0a0a0c" else "#f1f2f5"').length,3);
 assert.ok(player.includes('"#f0f0f2" else "#18191f"'));
 // Normalize only six exact reviewed appearance changes; keep the original
 // whole residual hash, including task-back and all non-appearance native code.
 let appearanceBaseline = bridge;
 const appearanceChanges: Array<[string,string]> = [
  [
    "import kotlin.math.roundToInt\n",
    ""
  ],
  [
    "fun setSystemBarAppearance(dark: Boolean, dimmed: Boolean, statusRgb: Int, navigationRgb: Int)",
    "fun setSystemBarAppearance(dark: Boolean, dimmed: Boolean)"
  ],
  [
    "(a * (1f - alpha) + b * alpha).roundToInt()",
    "(a * (1f - alpha) + b * alpha).toInt()"
  ],
  [
    "val fallbackStatus = Color.rgb",
    "val status = Color.rgb"
  ],
  [
    "            // Web CSS supplies the already-composited opaque color, including\n            // live fade opacity and nested sheets. NEVER dim this color again.\n            fun opaque(rgb: Int) = rgb or (0xff shl 24)\n            val status = if (statusRgb in 0..0xffffff) opaque(statusRgb) else fallbackStatus\n            val navigation = if (navigationRgb in 0..0xffffff) opaque(navigationRgb) else base\n",
    ""
  ],
  [
    "activity.window.navigationBarColor = navigation",
    "activity.window.navigationBarColor = base"
  ]
];
 for (const [approved, prior] of appearanceChanges) {
  assert.equal(appearanceBaseline.split(approved).length, 2, 'exactly one approved appearance fragment');
  appearanceBaseline = appearanceBaseline.replace(approved, prior);
 }
 // Normalize only the approved visual literals, then pin all native behavior.
 const normalizedBridge=appearanceBaseline.replace('Color.rgb(10, 10, 12) else Color.rgb(241, 242, 245)','Color.rgb(9, 9, 11) else Color.rgb(247, 247, 244)').replace('if (dark) Color.rgb(3, 3, 5) else Color.rgb(29, 31, 40)','if (dark) Color.BLACK else Color.rgb(19, 23, 21)').replace('if (dark) 0.64f else 0.30f','if (dark) 0.42f else 0.25f');
 const normalizedPlayer=player.replaceAll('"#0a0a0c" else "#f1f2f5"','"#111312" else "#FAFAF8"').replace('"#f0f0f2" else "#18191f"','"#E6E8E2" else "#262825"');
 assert.equal(createHash('sha256').update(normalizedBridge).digest('hex'),'e02ddd56f33ba1d612893edf90639fa3054419fa170ad45f5c69a18ccbfa3cfc');
 assert.equal(createHash('sha256').update(normalizedPlayer).digest('hex'),'5558a0c8d7e561d36cf98d3d0923a30774269d7a94dd40df51a4b2f79de1d758');
});
