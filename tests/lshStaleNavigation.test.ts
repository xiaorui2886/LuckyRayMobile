import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { NavigationController } from '../src/navigation.ts';
import { OverlayStack } from '../src/services/overlayStack.ts';

// Execute the actual shell callbacks against the real navigation authority,
// retaining the old render's route object to exercise the queued-event race.
const source = readFileSync(new URL('../src/still/StillShell.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const currentRootRoute =');
const end = source.indexOf('  const rootSwipe = useHorizontalSwipe', start);
assert.ok(start >= 0 && end > start);
const callbacks = ts.transpileModule(source.slice(start, end) + '\nreturn {navigateRootSwipe,navigateLshSwipe};', {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;
function setup() {
  const navigation = new NavigationController({tab:'ai'});
  const overlays = new OverlayStack();
  const backOwner = () => {};
  const factory = new Function('navigation','stack','rootTab','top','editingText','lshIme','overlayStack','navigating','rootSwipeTarget','open', callbacks);
  const bound = factory(navigation, navigation.snapshot(), 'ai', undefined, false, false, overlays, {current:false},
    (_root:string, direction:string) => direction === 'left' ? 'knowledge' : 'library',
    (tab:any) => navigation.switchRoot(tab));
  return { navigation, overlays, backOwner, ...bound };
}
test('queued LSH swipe cannot overwrite a newer tab before render cleanup', () => {
  const r=setup(); r.overlays.push(r.backOwner); r.navigation.switchRoot('settings');
  r.navigateLshSwipe('left',r.backOwner); assert.equal(r.navigation.current().tab,'settings');
});
test('queued LSH swipe cannot pop a newly opened detail', () => {
  const r=setup(); r.overlays.push(r.backOwner); r.navigation.pushDetail({tab:'ai',detail:'run'});
  const detail=r.navigation.current(); r.navigateLshSwipe('right',r.backOwner);
  assert.equal(r.navigation.current(),detail); assert.equal(r.navigation.snapshot().length,2);
});
test('leave and return to same tab invalidates old render identity', () => {
  const r=setup(); r.overlays.push(r.backOwner); r.navigation.switchRoot('settings'); r.navigation.switchRoot('ai');
  const returned=r.navigation.current(); r.navigateLshSwipe('left',r.backOwner);
  assert.equal(r.navigation.current(),returned);
});
test('ordinary root callback also rejects old navigation identity', () => {
  const r=setup(); r.navigation.switchRoot('settings'); r.navigateRootSwipe('left');
  assert.equal(r.navigation.current().tab,'settings');
});
test('current root and sole LSH back owner allow exactly one transition', () => {
  const r=setup(); r.overlays.push(r.backOwner); r.navigateLshSwipe('left',r.backOwner);
  assert.equal(r.navigation.current().tab,'knowledge'); r.navigateLshSwipe('right',r.backOwner);
  assert.equal(r.navigation.current().tab,'knowledge');
});
test('a second modal still blocks the otherwise current LSH callback', () => {
  const r=setup(); r.overlays.push(r.backOwner); r.overlays.push(()=>{}); r.navigateLshSwipe('left',r.backOwner);
  assert.equal(r.navigation.current().tab,'ai');
});
