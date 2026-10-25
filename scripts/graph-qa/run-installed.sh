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
python3 scripts/graph-qa/deadline.py 15 adb shell df /data > "$GRAPH_QA_EVIDENCE/data-space-before-install.txt"
echo GRAPH_QA_DATA_SPACE_BEGIN
cat "$GRAPH_QA_EVIDENCE/data-space-before-install.txt"
echo GRAPH_QA_DATA_SPACE_END
python3 scripts/graph-qa/preinstall-stability.py before-install
python3 scripts/graph-qa/install-system-state.py before-install
echo GRAPH_QA_PHASE_START_apk_install
# Official adb no-streaming mode separates transport and Package Manager install.
# Fresh AVD first install only: no retry or verification/permission bypass.
printf '%s\n' 'transport=no-streaming; retries=0' > "$GRAPH_QA_EVIDENCE/apk-install-mode.txt"
cat "$GRAPH_QA_EVIDENCE/apk-install-mode.txt"
echo GRAPH_QA_APK_METADATA_BEGIN
cat "$GRAPH_QA_EVIDENCE/apk-metadata.json"
echo GRAPH_QA_APK_METADATA_END
install_status=0
python3 scripts/graph-qa/deadline.py 300 adb install --no-streaming "$apk" || install_status=$?
if [[ "$install_status" != 0 ]]; then
  python3 scripts/graph-qa/install-system-state.py install-failure || true
  {
    echo "install-exit=$install_status"
    python3 scripts/graph-qa/deadline.py 15 adb shell service check package || true
    python3 scripts/graph-qa/deadline.py 15 adb shell df /data || true
    python3 scripts/graph-qa/deadline.py 15 adb shell cat /proc/meminfo | grep -E '^(MemTotal|MemAvailable):' || true
  } > "$GRAPH_QA_EVIDENCE/install-failure-state.txt" 2>&1
  echo GRAPH_QA_INSTALL_FAILURE_BEGIN
  cat "$GRAPH_QA_EVIDENCE/install-failure-state.txt"
  echo GRAPH_QA_INSTALL_FAILURE_END
  exit "$install_status"
fi
python3 scripts/graph-qa/install-system-state.py after-install
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
GRAPH_QA_TEST_PHASE=initial node scripts/graph-qa/installed-app.mjs
# New process and CDP connection: verify existing notes/session, never reseed or clear.
test -s "$GRAPH_QA_EVIDENCE/functional-reopen-baseline.json"
echo GRAPH_QA_PHASE_START_native_process_death
old_pid=$(adb shell pidof -s com.luckyray.mobile | tr -d '\r')
[[ "$old_pid" =~ ^[0-9]+$ ]] || { echo 'Process death needs an observed running app PID' >&2; exit 3; }
adb shell am force-stop com.luckyray.mobile
gone_status=0
remaining_pid=$(adb shell pidof -s com.luckyray.mobile 2>/dev/null) || gone_status=$?
[[ "$gone_status" == 1 && -z "$remaining_pid" ]] || { echo 'Force-stop did not prove original process absent' >&2; exit 3; }
adb shell am start -n "$activity"
new_pid='';restart_started=$SECONDS
while (( SECONDS-restart_started < 60 )); do
  query_status=0
  new_pid=$(adb shell pidof -s com.luckyray.mobile 2>/dev/null | tr -d '\r') || query_status=$?
  [[ "$query_status" == 0 || "$query_status" == 1 ]] || exit 3
  [[ "$new_pid" =~ ^[0-9]+$ ]] && break
  sleep 1
done
[[ "$new_pid" =~ ^[0-9]+$ && "$new_pid" != "$old_pid" ]] || { echo 'A distinct relaunched app PID was not established' >&2; exit 3; }
python3 - "$old_pid" "$new_pid" "$GRAPH_QA_EVIDENCE/process-death-pids.json" <<'PY_PIDS'
import json,pathlib,sys
result={'oldPid':sys.argv[1],'absentAfterForceStop':True,'newPid':sys.argv[2],'reseed':False,'pmClearAfterStop':False}
pathlib.Path(sys.argv[3]).write_text(json.dumps(result,indent=2));print('GRAPH_QA_PROCESS_DEATH '+json.dumps(result))
PY_PIDS
GRAPH_QA_TEST_PHASE=resume node scripts/graph-qa/installed-app.mjs
echo GRAPH_QA_PHASE_PASS_native_process_death
echo GRAPH_QA_PHASE_PASS_webview_checks
adb shell dumpsys gfxinfo com.luckyray.mobile framestats > "$GRAPH_QA_EVIDENCE/frames.txt"
adb shell dumpsys meminfo com.luckyray.mobile > "$GRAPH_QA_EVIDENCE/memory.txt"
