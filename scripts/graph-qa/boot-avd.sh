#!/usr/bin/env bash
# Disposable GitHub runner only. Does not accept licenses or download components.
# Parent must notify/review before this is ever placed in or executed by public CI.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI_GRAPH_QA_REVIEWED:-}" == yes ]] || { echo 'Reviewed disposable GitHub CI required' >&2; exit 2; }
: "${ANDROID_HOME:?}"
: "${GRAPH_API:?29 or 35}"
[[ "$GRAPH_API" == 29 || "$GRAPH_API" == 35 ]] || exit 2
# CPU emulation fallback does not change permissions, OS security or sandbox settings.
: "${RUNNER_TEMP:?}"
mkdir -p "$RUNNER_TEMP/graph-qa/evidence"
if [[ -r /dev/kvm && -w /dev/kvm ]] && "$ANDROID_HOME/emulator/emulator" -accel-check >/dev/null 2>&1; then
  accel=on; export GRAPH_EMULATION_MODE=kvm; boot_limit=360
else
  accel=off; export GRAPH_EMULATION_MODE=software-functional-only; boot_limit=600
  echo 'Existing KVM unavailable: software CPU emulation, functional-only evidence (no performance claim).'
fi
printf '{"mode":"%s","accelArgument":"%s","bootLimitSeconds":%s,"performanceClaimsAllowed":false}\n' "$GRAPH_EMULATION_MODE" "$accel" "$boot_limit" > "$RUNNER_TEMP/graph-qa/evidence/emulation-mode.json"
image="system-images;android-${GRAPH_API};google_apis;x86_64"
[[ -d "$ANDROID_HOME/system-images/android-${GRAPH_API}/google_apis/x86_64" ]] || { echo "Preinstalled/licensed image required: $image" >&2; exit 3; }
name="lr_graph_qa_${GRAPH_API}_${GITHUB_RUN_ID:?}_${GITHUB_RUN_ATTEMPT:?}"
[[ "$name" =~ ^[a-zA-Z0-9_]+$ ]] || exit 2
printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd --name "$name" --package "$image" --device pixel_2
"$ANDROID_HOME/emulator/emulator" -avd "$name" -accel "$accel" -port 5554 -no-window -no-audio -no-snapshot -wipe-data -gpu swiftshader_indirect -no-boot-anim > "${RUNNER_TEMP:?}/graph-emulator.log" 2>&1 &
pid=$!
trap '"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 emu kill >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true' EXIT
export ANDROID_SERIAL=emulator-5554
export PATH="$ANDROID_HOME/platform-tools:$PATH"
booted=no
start=$SECONDS
while (( SECONDS - start < boot_limit )); do
  kill -0 "$pid" 2>/dev/null || { echo "Emulator exited during $GRAPH_EMULATION_MODE boot; unsupported configuration or startup failure, not test success" >&2; exit 3; }
  if [[ "$(timeout 8 adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == 1 ]]; then booted=yes; break; fi
  sleep 2
done
[[ "$booted" == yes ]] || { echo "$GRAPH_EMULATION_MODE boot deadline exceeded (${boot_limit}s); infrastructure blocked" >&2; exit 3; }
# Caller supplies a reviewed in-repository driver; no remote command strings.
: "${GRAPH_TEST_DRIVER:?Path to reviewed executable local driver}"
[[ -f "$GRAPH_TEST_DRIVER" && -x "$GRAPH_TEST_DRIVER" ]] || exit 2
"$GRAPH_TEST_DRIVER"
