#!/usr/bin/env bash
# Fresh synthetic AVD feasibility only. Never installs or invokes the app.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI_GRAPH_QA_REVIEWED:-}" == yes && "${ANDROID_SERIAL:-}" == emulator-5554 && "${GRAPH_QA_PHASE:-}" == preflight ]] || exit 2
: "${RUNNER_TEMP:?}"
driver_dir="$(cd "$(dirname "$0")" && pwd)"
adb() { python3 "$driver_dir/deadline.py" 30 "${ANDROID_HOME:?}/platform-tools/adb" "$@"; }
echo GRAPH_QA_PHASE_START_preflight_identity
out="$RUNNER_TEMP/graph-qa/evidence"
mkdir -p "$out"
api=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
abi=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')
[[ "$api" == "$GRAPH_API" && "$abi" == x86_64 ]] || { echo 'AVD runtime identity mismatch' >&2; exit 3; }
[[ -z "$(adb shell pm list packages com.luckyray.mobile | tr -d '\r')" ]] || { echo 'Preflight must not contain app installation' >&2; exit 3; }
printf '{"status":"booted","purpose":"preflight-only-no-app-test","api":%s,"abi":"%s","mode":"%s"}\n' "$api" "$abi" "$GRAPH_EMULATION_MODE" > "$out/preflight.json"
adb shell dumpsys webviewupdate > "$out/preflight-webview.txt"
echo GRAPH_QA_PREFLIGHT_BEGIN
cat "$out/preflight.json"
head -c 8000 "$out/preflight-webview.txt"
echo GRAPH_QA_PREFLIGHT_END

echo GRAPH_QA_PHASE_PASS_preflight_identity
