#!/usr/bin/env bash
# Synthetic host Chromium evidence only; NOT installed Android coverage.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${CI_GRAPH_QA_REVIEWED:-}" == yes ]] || exit 2
: "${RUNNER_TEMP:?}"
cd "$(dirname "$0")/../.."
export GRAPH_QA_EVIDENCE="$RUNNER_TEMP/graph-host-evidence"
mkdir -p "$GRAPH_QA_EVIDENCE"
chrome=$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)
[[ -n "$chrome" ]] || { echo 'Existing runner Chrome unavailable; no browser installation fallback' >&2; exit 3; }
"$chrome" --version > "$GRAPH_QA_EVIDENCE/browser-version.txt"
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1423 --strictPort > "$RUNNER_TEMP/graph-vite.log" 2>&1 &
vite_pid=$!
# Keep default Chromium sandbox. No OS security or namespace changes.
"$chrome" --headless=new --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$RUNNER_TEMP/graph-chrome-profile" about:blank > "$RUNNER_TEMP/graph-chrome.log" 2>&1 &
chrome_pid=$!
trap 'kill "$chrome_pid" "$vite_pid" 2>/dev/null || true' EXIT
ready=no
for ((i=0;i<60;i++)); do
  kill -0 "$chrome_pid" || { echo 'Chrome failed with default sandbox; infrastructure blocked' >&2; exit 3; }
  kill -0 "$vite_pid" || { echo 'Vite startup failed' >&2; exit 3; }
  if curl --silent --fail http://127.0.0.1:9222/json/version >/dev/null && curl --silent --fail http://127.0.0.1:1423/ >/dev/null; then ready=yes; break; fi
  sleep 1
done
[[ "$ready" == yes ]] || { echo 'Host browser/Vite startup deadline exceeded' >&2; exit 3; }
timeout 180 node tests/graphCanvas/MobileGraphCanvas.browser.test.mjs http://127.0.0.1:9222 http://127.0.0.1:1423 | tee "$GRAPH_QA_EVIDENCE/canvas-results.json"
node scripts/graph-qa/capture-host.mjs http://127.0.0.1:9222 canvas-host
# UI worker owns this real-component/synthetic-data test, not the Android driver.
timeout 240 node tests/graph-ui/browser-check.mjs http://127.0.0.1:9222 http://127.0.0.1:1423 "$GRAPH_QA_EVIDENCE"
