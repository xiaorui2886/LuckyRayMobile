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
provider_status=5
provider_started=$SECONDS
for attempt in 1 2 3; do
  echo "GRAPH_QA_PROVIDER_PROBE attempt=$attempt elapsedSeconds=$((SECONDS-provider_started))"
  # Read-only startup readiness: <=3 attempts, each capped24s, <=2 sleeps4s.
  probe_status=0
  python3 "$driver_dir/deadline.py" 24 "${ANDROID_HOME:?}/platform-tools/adb" shell dumpsys -t 20 webviewupdate > "$out/preflight-webview.txt" 2>&1 || probe_status=$?
  provider_status=0
  python3 "$driver_dir/webview-baseline.py" "$out/preflight-webview.txt" "$out/webview-baseline.json" || provider_status=$?
  printf 'attempt=%s probeExit=%s classificationExit=%s elapsedSeconds=%s\n' "$attempt" "$probe_status" "$provider_status" "$((SECONDS-provider_started))" >> "$out/provider-probe-attempts.txt"
  [[ "$provider_status" == 0 ]] && break
  [[ "$provider_status" == 4 ]] && break # Actual below83 never retried/accepted.
  [[ "$attempt" == 3 ]] || sleep 4
done
echo GRAPH_QA_PREFLIGHT_BEGIN
cat "$out/preflight.json"
head -c 8000 "$out/preflight-webview.txt"
echo GRAPH_QA_PREFLIGHT_END

if [[ "$provider_status" != 0 ]]; then
  echo "Actual WebView provider unavailable or unsupported; app tests NOT_RUN (classification exit $provider_status)."
  exit "$provider_status"
fi
echo GRAPH_QA_PHASE_PASS_preflight_identity
