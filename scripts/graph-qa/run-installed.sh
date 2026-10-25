#!/usr/bin/env bash
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI_GRAPH_QA_REVIEWED:-}" == yes && "${ANDROID_SERIAL:-}" == emulator-5554 ]] || exit 2
: "${RUNNER_TEMP:?}"
cd "$(dirname "$0")/../.."
export GRAPH_QA_EVIDENCE="$RUNNER_TEMP/graph-qa/evidence"
mkdir -p "$GRAPH_QA_EVIDENCE"
apk="$RUNNER_TEMP/graph-qa/app-debug.apk"
test -f "$apk"
# Brand-new AVD only; production application ID retained to exercise real JNI bridges.
echo GRAPH_QA_PHASE_START_apk_install
python3 scripts/graph-qa/deadline.py 300 adb install "$apk"
echo GRAPH_QA_PHASE_PASS_apk_install
# All subsequent adb commands are individually bounded, including diagnostics.
adb() { python3 scripts/graph-qa/deadline.py 30 "${ANDROID_HOME:?}/platform-tools/adb" "$@"; }
echo GRAPH_QA_PHASE_START_app_launch
adb shell dumpsys package com.luckyray.mobile | grep -q DEBUGGABLE
adb shell pm clear com.luckyray.mobile
activity=$(adb shell cmd package resolve-activity --brief com.luckyray.mobile | tr -d '\r' | tail -1)
[[ "$activity" == com.luckyray.mobile/* ]] || exit 3
adb shell svc wifi disable
phone_state=$(adb shell service check phone | tr -d '\r')
if [[ "$phone_state" == *'not found'* ]]; then
  echo 'GRAPH_QA_NETWORK no phone service on this image; cellular disable not applicable'
  printf '%s\n' 'phone-service=absent; cellular-disable=not-applicable' > "$GRAPH_QA_EVIDENCE/network-setup.txt"
else
  adb shell svc data disable
  printf '%s\n' 'phone-service=present; cellular-disable=success' > "$GRAPH_QA_EVIDENCE/network-setup.txt"
fi
printf 'wifi_on=' >> "$GRAPH_QA_EVIDENCE/network-setup.txt"
adb shell settings get global wifi_on >> "$GRAPH_QA_EVIDENCE/network-setup.txt"
printf 'mobile_data=' >> "$GRAPH_QA_EVIDENCE/network-setup.txt"
adb shell settings get global mobile_data >> "$GRAPH_QA_EVIDENCE/network-setup.txt"
cat "$GRAPH_QA_EVIDENCE/network-setup.txt"
adb shell am start -n "$activity"
echo GRAPH_QA_PHASE_PASS_app_launch
adb shell dumpsys webviewupdate > "$GRAPH_QA_EVIDENCE/webview.txt"
adb shell getprop ro.build.version.sdk > "$GRAPH_QA_EVIDENCE/api.txt"
adb shell getprop ro.product.cpu.abi > "$GRAPH_QA_EVIDENCE/abi.txt"
echo GRAPH_QA_RUNTIME_BEGIN
printf 'API: '; cat "$GRAPH_QA_EVIDENCE/api.txt"
printf 'ABI: '; cat "$GRAPH_QA_EVIDENCE/abi.txt"
cat "$GRAPH_QA_EVIDENCE/webview.txt"
echo GRAPH_QA_RUNTIME_END
cp "$RUNNER_TEMP/graph-qa/apk.sha256" "$GRAPH_QA_EVIDENCE/apk-sha256.txt"
echo GRAPH_QA_PHASE_START_webview_checks
node scripts/graph-qa/installed-app.mjs
echo GRAPH_QA_PHASE_PASS_webview_checks
adb shell dumpsys gfxinfo com.luckyray.mobile framestats > "$GRAPH_QA_EVIDENCE/frames.txt"
adb shell dumpsys meminfo com.luckyray.mobile > "$GRAPH_QA_EVIDENCE/memory.txt"
