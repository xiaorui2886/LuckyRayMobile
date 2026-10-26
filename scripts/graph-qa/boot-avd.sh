#!/usr/bin/env bash
# Disposable GitHub runner only. Does not accept licenses or download components.
# Parent must notify/review before this is ever placed in or executed by public CI.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI_GRAPH_QA_REVIEWED:-}" == yes ]] || { echo 'Reviewed disposable GitHub CI required' >&2; exit 2; }
: "${ANDROID_HOME:?}"
: "${GRAPH_API:?29, 30 or 35}"
[[ "$GRAPH_API" == 29 || "$GRAPH_API" == 30 || "$GRAPH_API" == 35 ]] || exit 2
# CPU emulation fallback does not change permissions, OS security or sandbox settings.
: "${RUNNER_TEMP:?}"
mkdir -p "$RUNNER_TEMP/graph-qa/evidence"
{ uname -sm; bash --version | head -n 1; python3 --version
  if [[ "$(uname -s)" == Darwin ]]; then sw_vers; fi
} > "$RUNNER_TEMP/graph-qa/evidence/host-platform.txt"
cat "$RUNNER_TEMP/graph-qa/evidence/host-platform.txt"
# Read-only host capability metadata; no chmod, sudo, group or namespace changes.
"$ANDROID_HOME/emulator/emulator" -version > "$RUNNER_TEMP/graph-qa/evidence/emulator-version.txt" 2>&1 || true
accel_check_status=0
"$ANDROID_HOME/emulator/emulator" -accel-check > "$RUNNER_TEMP/graph-qa/evidence/emulator-accel-check.txt" 2>&1 || accel_check_status=$?
{ if [[ -e /dev/kvm ]]; then ls -l /dev/kvm; else echo '/dev/kvm absent'; fi
  [[ -r /dev/kvm ]] && echo 'kvm-readable=yes' || echo 'kvm-readable=no'
  [[ -w /dev/kvm ]] && echo 'kvm-writable=yes' || echo 'kvm-writable=no'
} > "$RUNNER_TEMP/graph-qa/evidence/kvm-metadata.txt"
echo GRAPH_QA_HOST_CAPABILITY_BEGIN
head -c 6000 "$RUNNER_TEMP/graph-qa/evidence/emulator-version.txt"
head -c 6000 "$RUNNER_TEMP/graph-qa/evidence/emulator-accel-check.txt"
cat "$RUNNER_TEMP/graph-qa/evidence/kvm-metadata.txt"
echo GRAPH_QA_HOST_CAPABILITY_END
if [[ "$(uname -s)" == Darwin ]]; then
  sysctl kern.hv_support > "$RUNNER_TEMP/graph-qa/evidence/hypervisor-metadata.txt" 2>&1 || true
  cat "$RUNNER_TEMP/graph-qa/evidence/hypervisor-metadata.txt"
  [[ "$accel_check_status" == 0 ]] && grep -q 'Hypervisor.Framework' "$RUNNER_TEMP/graph-qa/evidence/emulator-accel-check.txt" || { echo 'macOS Hypervisor.Framework unavailable; no permission changes attempted' >&2; exit 3; }
  accel=on; export GRAPH_EMULATION_MODE=hypervisor-framework; boot_limit=900
elif [[ -r /dev/kvm && -w /dev/kvm && "$accel_check_status" == 0 ]]; then
  accel=on; export GRAPH_EMULATION_MODE=kvm; boot_limit=900
else
  accel=off; export GRAPH_EMULATION_MODE=software-functional-only; boot_limit=900
  echo 'Existing KVM unavailable: software CPU emulation, functional-only evidence (no performance claim).'
fi
printf '{"mode":"%s","accelArgument":"%s","bootLimitSeconds":%s,"gpuArgument":"software","memoryMiB":3072,"partitionMiB":4096,"performanceClaimsAllowed":false}\n' "$GRAPH_EMULATION_MODE" "$accel" "$boot_limit" > "$RUNNER_TEMP/graph-qa/evidence/emulation-mode.json"
echo GRAPH_QA_EMULATION_MODE_BEGIN
cat "$RUNNER_TEMP/graph-qa/evidence/emulation-mode.json"
echo GRAPH_QA_EMULATION_MODE_END
image="system-images;android-${GRAPH_API};google_apis;x86_64"
[[ -d "$ANDROID_HOME/system-images/android-${GRAPH_API}/google_apis/x86_64" ]] || { echo "Preinstalled/licensed image required: $image" >&2; exit 3; }
phase="${GRAPH_QA_PHASE:-installed}"
[[ "$phase" == preflight || "$phase" == installed ]] || exit 2
name="lr_unified_qa_${GRAPH_API}_${GITHUB_RUN_ID:?}_${GITHUB_RUN_ATTEMPT:?}"
marker="$RUNNER_TEMP/graph-qa/evidence/empty-avd-preflight.json"
[[ "$name" =~ ^[a-zA-Z0-9_]+$ ]] || exit 2
# Android tools can disagree on legacy/default homes. Give both one explicit CI-only home.
export ANDROID_USER_HOME="$RUNNER_TEMP/graph-android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
mkdir -p "$ANDROID_AVD_HOME"
if [[ "$phase" == preflight ]]; then
  [[ ! -e "$marker" && ! -e "$ANDROID_AVD_HOME/$name.ini" ]] || { echo 'Refusing duplicate preflight or existing AVD'; exit 3; }
  echo GRAPH_QA_PHASE_START_avd_create
  printf 'no\n' | python3 "$(dirname "$0")/deadline.py" 120 "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd --name "$name" --package "$image" --device pixel_2 --path "$ANDROID_AVD_HOME/$name.avd"
  echo GRAPH_QA_PHASE_PASS_avd_create
else
  # Only the same run/attempt's successfully observed, app-empty profile is eligible.
  python3 - "$marker" "$name" "$GRAPH_API" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$ANDROID_AVD_HOME/$name.avd/config.ini" <<'PY_REUSE'
import json,sys,pathlib,hashlib
p,name,api,run,attempt,config=sys.argv[1:]
m=json.loads(pathlib.Path(p).read_text())
expected={'avd':name,'api':api,'runId':run,'attempt':attempt,'noApp':True,'preflightPassed':True,'normalShutdown':True,'configSha256':hashlib.sha256(pathlib.Path(config).read_bytes()).hexdigest()}
assert m==expected,'AVD preflight provenance mismatch; no fallback creation or wipe'
print('GRAPH_QA_SAME_EMPTY_AVD_REOPEN '+json.dumps(m))
PY_REUSE
fi
[[ -f "$ANDROID_AVD_HOME/$name.ini" && -f "$ANDROID_AVD_HOME/$name.avd/config.ini" ]] || { echo 'AVD creation did not publish expected isolated descriptor/config; refusing launch' >&2; exit 3; }
python3 "$(dirname "$0")/deadline.py" 30 "$ANDROID_HOME/emulator/emulator" -list-avds > "$RUNNER_TEMP/graph-qa/evidence/avd-discovery.txt"
cat "$RUNNER_TEMP/graph-qa/evidence/avd-discovery.txt"
grep -Fxq "$name" "$RUNNER_TEMP/graph-qa/evidence/avd-discovery.txt" || { echo 'Emulator cannot discover freshly-created isolated AVD; refusing launch' >&2; exit 3; }
if [[ "$phase" == preflight ]]; then
python3 - "$ANDROID_AVD_HOME/$name.avd/config.ini" "$RUNNER_TEMP/graph-qa/evidence/avd-resources.json" <<'PY_RESOURCES'
import pathlib,json,sys
allowed={'hw.ramSize','hw.cpu.ncore','disk.dataPartition.size','hw.lcd.width','hw.lcd.height','hw.lcd.density'}; values={}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    key,sep,value=line.partition('=')
    if sep and key.strip() in allowed:values[key.strip()]=value.strip()
original={key:values.get(key) for key in ['hw.cpu.ncore','hw.lcd.width','hw.lcd.height','hw.lcd.density']}
profile={'hw.cpu.ncore':'4','hw.lcd.width':'720','hw.lcd.height':'1280','hw.lcd.density':'320'}
config=pathlib.Path(sys.argv[1]);lines=config.read_text().splitlines();keys=set(profile)
lines=[line for line in lines if line.partition('=')[0].strip() not in keys]
lines.extend(key+'='+value for key,value in profile.items());config.write_text('\n'.join(lines)+'\n')
values['originalDisplayCpu']=original;values['functionalDisplayCpu']=profile;values['expectedCssWidth']=360
values['commandLineMemoryMiB']=3072
values['commandLinePartitionMiB']=4096
pathlib.Path(sys.argv[2]).write_text(json.dumps(values,indent=2))
print('GRAPH_QA_AVD_RESOURCES '+json.dumps(values))
PY_RESOURCES
fi
echo GRAPH_QA_PHASE_START_emulator_boot
wipe_args=()
[[ "$phase" != preflight ]] || wipe_args=(-wipe-data)
"$ANDROID_HOME/emulator/emulator" -avd "$name" -accel "$accel" -port 5554 -no-window -no-audio -no-snapshot "${wipe_args[@]}" -gpu software -memory 3072 -partition-size 4096 -no-boot-anim > "${RUNNER_TEMP:?}/graph-emulator.log" 2>&1 &
pid=$!
report_boot_failure() {
  # Only pre-install synthetic emulator startup diagnostics, no app logcat/environment.
  # Fixed allowlist distinguishes adb absent/offline, Android boot and boot animation stalls.
  local diagnostic_file="$RUNNER_TEMP/graph-qa/evidence/boot-state.txt"
  {
    printf 'emulator-process-alive='; if kill -0 "$pid" 2>/dev/null; then echo yes; else echo no; fi
    printf 'adb-state='; python3 "$(dirname "$0")/deadline.py" 8 adb -s emulator-5554 get-state 2>/dev/null || true
    for property in sys.boot_completed dev.bootcomplete init.svc.bootanim ro.build.version.sdk ro.product.cpu.abi; do
      printf '%s=' "$property"
      python3 "$(dirname "$0")/deadline.py" 8 adb -s emulator-5554 shell getprop "$property" 2>/dev/null | tr -d '\r' || true
      printf '\n'
    done
    python3 "$(dirname "$0")/deadline.py" 8 adb -s emulator-5554 shell cat /proc/meminfo 2>/dev/null | grep -E '^(MemTotal|MemAvailable):' || true
  } > "$diagnostic_file"
  echo GRAPH_QA_BOOT_STATE_BEGIN; cat "$diagnostic_file"; echo GRAPH_QA_BOOT_STATE_END
  python3 - "$RUNNER_TEMP/graph-emulator.log" "$RUNNER_TEMP/graph-qa/evidence/emulator-startup-diagnostic.txt" <<'PY_DIAGNOSTIC'
import pathlib,re,sys
source=pathlib.Path(sys.argv[1])
lines=source.read_text(errors='replace').splitlines() if source.exists() else ['Emulator startup log unavailable']
selected=[]
for line in lines:
    if re.search(r'error|fatal|panic|unsupported|invalid|accel|gpu|vulkan|library|qt|kvm|emulator version',line,re.I):
        if re.search(r'token|secret|password|authorization|credential|jwt|cookie',line,re.I): line='[credential-related startup line redacted]'
        selected.append(line[:1000])
text='\n'.join(selected[-60:]) or 'No classified startup diagnostic; process exit is confirmed but cause remains unknown.'
pathlib.Path(sys.argv[2]).write_text(text+'\n')
print('GRAPH_QA_EMULATOR_DIAGNOSTIC_BEGIN\n'+text+'\nGRAPH_QA_EMULATOR_DIAGNOSTIC_END')
PY_DIAGNOSTIC
}
cleanup() {
  echo GRAPH_QA_PHASE_START_emulator_cleanup
  python3 "$(dirname "$0")/deadline.py" 8 "$ANDROID_HOME/platform-tools/adb" -s emulator-5554 emu kill >/dev/null 2>&1 || true
  if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  echo GRAPH_QA_PHASE_PASS_emulator_cleanup
}
trap cleanup EXIT
export ANDROID_SERIAL=emulator-5554
export PATH="$ANDROID_HOME/platform-tools:$PATH"
booted=no
start=$SECONDS
while (( SECONDS - start < boot_limit )); do
  kill -0 "$pid" 2>/dev/null || { echo "Emulator exited during $GRAPH_EMULATION_MODE boot; unsupported configuration or startup failure, not test success" >&2; report_boot_failure; exit 3; }
  if [[ "$(python3 "$(dirname "$0")/deadline.py" 8 adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == 1 ]]; then booted=yes; break; fi
  sleep 2
done
[[ "$booted" == yes ]] || { echo "$GRAPH_EMULATION_MODE boot deadline exceeded (${boot_limit}s); infrastructure blocked" >&2; report_boot_failure; exit 3; }
echo GRAPH_QA_PHASE_PASS_emulator_boot
{
  python3 "$(dirname "$0")/deadline.py" 15 adb shell wm size
  python3 "$(dirname "$0")/deadline.py" 15 adb shell wm density
  python3 "$(dirname "$0")/deadline.py" 15 adb shell cat /sys/devices/system/cpu/present
} > "$RUNNER_TEMP/graph-qa/evidence/actual-display-cpu.txt"
echo GRAPH_QA_ACTUAL_DISPLAY_CPU_BEGIN
cat "$RUNNER_TEMP/graph-qa/evidence/actual-display-cpu.txt"
echo GRAPH_QA_ACTUAL_DISPLAY_CPU_END
# Caller supplies a reviewed in-repository driver; no remote command strings.
: "${GRAPH_TEST_DRIVER:?Path to reviewed executable local driver}"
[[ -f "$GRAPH_TEST_DRIVER" && -x "$GRAPH_TEST_DRIVER" ]] || exit 2
# Both boots must remain app-empty until the installation driver runs.
[[ "$(python3 "$(dirname "$0")/deadline.py" 15 adb shell getprop ro.build.version.sdk | tr -d '\r')" == "$GRAPH_API" ]] || exit 3
[[ "$(python3 "$(dirname "$0")/deadline.py" 15 adb shell getprop ro.product.cpu.abi | tr -d '\r')" == x86_64 ]] || exit 3
packages=$(python3 "$(dirname "$0")/deadline.py" 15 adb shell pm list packages com.luckyray.mobile | tr -d '\r') || exit 3
[[ -z "$packages" ]] || { echo 'Expected app-empty synthetic AVD'; exit 3; }
"$GRAPH_TEST_DRIVER"
# Successful normal shutdown preserves initialized system state; no snapshot and
# no second -wipe-data. A failure anywhere above never publishes reuse provenance.
python3 "$(dirname "$0")/deadline.py" 15 adb shell sync
python3 "$(dirname "$0")/deadline.py" 15 adb emu kill
shutdown_start=$SECONDS
while kill -0 "$pid" 2>/dev/null && (( SECONDS-shutdown_start < 45 )); do sleep 1; done
if kill -0 "$pid" 2>/dev/null; then echo 'Normal emulator shutdown timeout; reuse forbidden'; exit 3; fi
wait "$pid"
trap - EXIT
if [[ "$phase" == preflight ]]; then
  python3 - "$marker" "$name" "$GRAPH_API" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$ANDROID_AVD_HOME/$name.avd/config.ini" <<'PY_MARKER'
import json,sys,pathlib,hashlib
p,name,api,run,attempt,config=sys.argv[1:]
m={'avd':name,'api':api,'runId':run,'attempt':attempt,'noApp':True,'preflightPassed':True,'normalShutdown':True,'configSha256':hashlib.sha256(pathlib.Path(config).read_bytes()).hexdigest()}
pathlib.Path(p).write_text(json.dumps(m,indent=2)+'\n')
print('GRAPH_QA_EMPTY_AVD_READY '+json.dumps(m))
PY_MARKER
fi
