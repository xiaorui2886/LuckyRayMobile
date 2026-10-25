#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ "${GITHUB_ACTIONS:-}" == true && "${CI_GRAPH_QA_REVIEWED:-}" == yes ]] || { echo 'Disposable reviewed CI only' >&2; exit 2; }
: "${ANDROID_HOME:?}" "${JAVA_HOME:?}" "${RUNNER_TEMP:?}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export CARGO_TARGET_DIR="$(node scripts/configure-android-build.mjs --cargo-target-dir "$RUNNER_TEMP/graph-cargo")"
node --test scripts/graph-qa/seed-expressions.test.mjs
cli=node_modules/@tauri-apps/cli/tauri.js
cargo fetch --manifest-path src-tauri/Cargo.toml --locked --target x86_64-linux-android
node "$cli" android init --ci --skip-targets-install
bash scripts/apply-android-patches.sh
node "$cli" android build --apk --debug --target x86_64 --ci -- --locked
mapfile -d '' apks < <(find src-tauri/gen/android/app/build/outputs/apk -type f -name '*debug.apk' -print0)
[[ ${#apks[@]} == 1 ]] || { echo 'Exactly one debug APK required' >&2; exit 3; }
apk="${apks[0]}"
aapt="$ANDROID_HOME/build-tools/36.0.0/aapt"
"$aapt" dump badging "$apk" > "$RUNNER_TEMP/graph-apk-badging.txt"
grep -q "package: name='com.luckyray.mobile'" "$RUNNER_TEMP/graph-apk-badging.txt"
grep -q "native-code:.*'x86_64'" "$RUNNER_TEMP/graph-apk-badging.txt"
grep -q application-debuggable "$RUNNER_TEMP/graph-apk-badging.txt"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$apk"
mkdir -p "$RUNNER_TEMP/graph-qa"
cp "$apk" "$RUNNER_TEMP/graph-qa/app-debug.apk"
sha256sum "$RUNNER_TEMP/graph-qa/app-debug.apk" > "$RUNNER_TEMP/graph-qa/apk.sha256"
git diff --exit-code -- pnpm-lock.yaml src-tauri/Cargo.lock
