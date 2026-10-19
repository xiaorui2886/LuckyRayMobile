import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import * as AndroidBuild from '../scripts/configure-android-build.mjs';
const { configureAndroidBuild } = AndroidBuild;

function removeFixture(root: string) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'cleanup stays in the fixture temp parent');
  assert.ok(root.includes('luckyray build '), 'cleanup targets this test fixture');
  rmSync(root, { recursive: true, force: true });
}

test('fresh and stale Android projects receive the current checkout task and valid SDK properties', () => {
  const root = mkdtempSync(join(tmpdir(), 'luckyray build '));
  try {
    const android = join(root, 'src-tauri/gen/android');
    const buildTask = join(android, 'buildSrc/src/main/java/com/luckyray/mobile/kotlin/BuildTask.kt');
    mkdirSync(join(android, 'buildSrc/src/main/java/com/luckyray/mobile/kotlin'), { recursive: true });
    mkdirSync(join(root, 'scripts/android-src'), { recursive: true });
    const template = join(import.meta.dirname, '../scripts/android-src/BuildTask.kt');
    copyFileSync(template, join(root, 'scripts/android-src/BuildTask.kt'));
    const sdk = join(root, 'Android SDK');
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    for (const oldTask of ['val executable = """node"""', 'val executable = """npm"""', 'val executable = "D:/deleted/private-wrapper.cmd"']) {
      writeFileSync(buildTask, oldTask);
      writeFileSync(join(android, 'local.properties'), '# local settings\nsdk.dir=D:\\wrong\\sdk\ncustom.setting=keep\n');
      configureAndroidBuild(root, { ANDROID_HOME: sdk });
      assert.equal(readFileSync(buildTask, 'utf8'), readFileSync(template, 'utf8'));
      const properties = readFileSync(join(android, 'local.properties'), 'utf8');
      assert.equal(properties, `# local settings\ncustom.setting=keep\nsdk.dir=${sdk.replaceAll('\\', '/').replaceAll(':', '\\:')}\n`);
      configureAndroidBuild(root, { ANDROID_SDK_ROOT: sdk });
      assert.equal(readFileSync(join(android, 'local.properties'), 'utf8'), properties, 'second generation is idempotent');
    }
    rmSync(join(android, 'local.properties'));
    configureAndroidBuild(root, { ANDROID_HOME: sdk });
    assert.match(readFileSync(join(android, 'local.properties'), 'utf8'), /^sdk\.dir=/);
  } finally { removeFixture(root); }
});

test('formal build resolver uses its own checkout even when invoked from another directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'luckyray build cli '));
  try {
    const repo = resolve(import.meta.dirname, '..');
    const script = join(repo, 'scripts/configure-android-build.mjs');
    const cache = join(root, 'cache parent with spaces');
    for (const args of [[], [cache], ['relative-cache']]) {
      const actual = execFileSync(process.execPath, [script, '--cargo-target-dir', ...args], { cwd: root, encoding: 'utf8' }).trim();
      assert.equal(actual, AndroidBuild.androidCargoTargetDirectory(repo, args[0]));
      assert.notEqual(actual, resolve(root, 'relative-cache'));
    }
  } finally { removeFixture(root); }
});

test('missing or invalid SDK fails before replacing generated build configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'luckyray build invalid '));
  try {
    assert.throws(() => configureAndroidBuild(root, {}), /Set ANDROID_HOME/);
    assert.throws(() => configureAndroidBuild(root, { ANDROID_HOME: join(root, 'missing') }), /containing platform-tools/);
  } finally { removeFixture(root); }
});

test('Android Cargo cache is repeatable per checkout without reusing another checkout generator', () => {
  const root = mkdtempSync(join(tmpdir(), 'luckyray build cache '));
  try {
    const first = join(root, 'current checkout');
    const second = join(root, 'other checkout');
    const shared = join(root, 'shared cache');
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(shared);
    const oldOutput = join(shared, 'old-generator-output');
    writeFileSync(oldOutput, 'rerun-if-changed=other/generated/TauriActivity.kt');
    const current = AndroidBuild.androidCargoTargetDirectory(first, shared);
    const other = AndroidBuild.androidCargoTargetDirectory(second, shared);
    assert.notEqual(current, resolve(shared), 'never use the unscoped shared target');
    assert.notEqual(current, other, 'each output directory has a separate official Cargo generator');
    assert.equal(current, AndroidBuild.androidCargoTargetDirectory(join(first, '.'), shared));
    assert.ok(current.startsWith(resolve(shared) + sep));
    assert.equal(readFileSync(oldOutput, 'utf8'), 'rerun-if-changed=other/generated/TauriActivity.kt', 'no shared-cache cleanup or mutation');
    assert.ok(AndroidBuild.androidCargoTargetDirectory(first).startsWith(join(first, 'src-tauri', 'target')));
  } finally { removeFixture(root); }
});
