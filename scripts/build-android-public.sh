#!/usr/bin/env bash
# Build a development APK only. No install, publishing, or release signing.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK directory}"
: "${JAVA_HOME:?Set JAVA_HOME to JDK 17}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.2.12479018}"
export CARGO_TARGET_DIR="$(node scripts/configure-android-build.mjs --cargo-target-dir "${CARGO_TARGET_DIR:-src-tauri/target}")"
cli=node_modules/@tauri-apps/cli/tauri.js
test -f "$cli"
test -d "$NDK_HOME"
# Fail if dependency resolution requires changing the committed Rust lockfile.
cargo fetch --manifest-path src-tauri/Cargo.toml --locked --target aarch64-linux-android
node "$cli" android init --ci --skip-targets-install
bash scripts/apply-android-patches.sh
node "$cli" android build --apk --debug --target aarch64 --ci -- --locked
