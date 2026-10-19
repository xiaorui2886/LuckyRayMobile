import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tauri 2.11.5's official Activity generator tracks its previous output file,
// not WRY_ANDROID_KOTLIN_FILES_OUT_DIR. A cross-checkout Cargo target can therefore
// be fresh while this checkout's Activity is absent. Scope the target instead of
// copying generated sources or invalidating somebody else's build cache.
export function androidCargoTargetDirectory(repoRoot, cacheRoot) {
  const canonical = realpathSync(repoRoot);
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return join(resolve(canonical, cacheRoot || 'src-tauri/target'), 'luckyray-android', key);
}

export function configureAndroidBuild(repoRoot, env = process.env) {
  const android = join(repoRoot, 'src-tauri/gen/android');
  const sdkPath = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (!sdkPath || !existsSync(join(sdkPath, 'platform-tools'))) {
    throw new Error('Set ANDROID_HOME or ANDROID_SDK_ROOT to an SDK containing platform-tools');
  }
  // Java .properties treats a single backslash as an escape, including \t.
  const sdk = sdkPath.replaceAll('\\', '/').replaceAll(':', '\\:');
  const properties = join(android, 'local.properties');
  const previous = existsSync(properties) ? readFileSync(properties, 'utf8') : '';
  const remaining = previous.split(/\r?\n/).filter(line => !/^\s*sdk\.dir\s*[:=]/.test(line));
  while (remaining.at(-1) === '') remaining.pop();
  writeFileSync(properties, [...remaining, `sdk.dir=${sdk}`, ''].join('\n'));
  copyFileSync(
    join(repoRoot, 'scripts/android-src/BuildTask.kt'),
    join(android, 'buildSrc/src/main/java/com/luckyray/mobile/kotlin/BuildTask.kt'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv[2] === '--cargo-target-dir') {
    console.log(androidCargoTargetDirectory(repoRoot, process.argv[3]));
  } else {
    configureAndroidBuild(repoRoot);
  }
}
