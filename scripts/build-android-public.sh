#!/usr/bin/env bash
# Build an APK only. No install, publishing, or signing-key access.
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
build_flags=(--debug)
case "${1:---debug}" in
  --debug) ;;
  --release) build_flags=() ;;
  *) echo "Usage: $0 [--debug|--release]" >&2; exit 2 ;;
esac
test "$#" -le 1
# Fail if dependency resolution requires changing the committed Rust lockfile.
cargo fetch --manifest-path src-tauri/Cargo.toml --locked --target aarch64-linux-android
node "$cli" android init --ci --skip-targets-install
bash scripts/apply-android-patches.sh
node "$cli" android build --apk "${build_flags[@]}" --target aarch64 --ci -- --locked
