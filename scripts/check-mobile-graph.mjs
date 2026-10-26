// Offline-safe graph regression entry. Browser/device tests remain separate.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const run = args => execFileSync(process.execPath, args, {cwd, stdio:'inherit'});
const core = ['Camera','Physics','Playback','Presentation','Provenance','Renderer','Semantics'].map(name => `tests/graph-core/graph${name}.contract.test.ts`);
const interaction = ['CameraMotion','Gestures','Interaction','Lifecycle'].map(name => `tests/graphCanvas/mobileGraph${name}.test.mjs`);
run(['--experimental-strip-types','--test',...core,...interaction,'tests/mobileGraphData.test.ts','tests/mobileGraphDesktopParity.test.ts','tests/mobileGraphSources.test.ts','tests/graphAndroidExportProvider.test.ts','tests/knowledgeVaultCatalog.test.ts','tests/feedbackCancellation.test.ts']);
if (process.argv.includes('--dom')) {
  if (!process.env.LR_DOM_TEST_TOOLS) throw Error('Provide the existing pinned jsdom 26.1.0 directory via LR_DOM_TEST_TOOLS.');
  for (const file of ['tests/mobileGraphUi.dom.test.mjs','tests/graphSettings/mobileGraphSettings.dom.test.mjs','tests/graphSettings/noteGraphSourceHandoff.dom.test.mjs','tests/graphCanvas/mobileGraphInteraction.dom.test.mjs','tests/graphCanvas/mobileGraphLifecycle.dom.test.mjs']) run([file]);
} else console.log('Graph DOM NOT_RUN; use --dom with LR_DOM_TEST_TOOLS.');
console.log('Browser, Android build and physical-device QA are NOT_RUN by this script.');
