# Isolated installed-Android graph QA

Public workflow triggers only on the exact `ray/mobile-graph-check-20261026` push branch, or acknowledged manual dispatch. Parent must review public source diff and notify owner before each run. No signing secrets, production certificate, release upload, real device, desktop pairing, user vault, or model service. Only newly booted disposable AVDs are supported.

- Build actual x86_64 Rust + generated Kotlin Tauri debug APK with bundled frontend. Keep application ID `com.luckyray.mobile` deliberately so JNI/bridge namespaces match production; this APK is NEVER installed on user phones and NEVER uploaded by this workflow.
- SDK installation uses existing licenses (`< /dev/null`); does not auto-accept new terms. Use existing accessible KVM when available. Otherwise attempt explicit software CPU emulation (`-accel off`) for functional coverage only, with a ten-minute boot deadline and recorded mode. Missing image/license, rejected software mode, or boot timeout is infrastructure blockage, never a browser-test fallback. No KVM permissions are changed.
- API29/API35 are matrix lanes, **not** claims of WebView83 or physical MI8/14U coverage. Actual provider is captured.
- UI harness attaches only to installed application's debug WebView over adb port-forward. It invokes existing native managed-vault commands after empty-profile guards, explicitly prepares/commits an empty synthetic migration, and writes 1000 synthetic ring-linked Markdown notes through native transactional APIs. No production test command or fake browser data layer is introduced.
- UI actions derive bounds from the actual DOM and dispatch WebView touch events through CDP. This tests real canvas handlers/rendering but is not OS-wide multitouch instrumentation. Android Home/resume uses adb.
- Current subset: native bridge/start, fresh empty migration, native1000-note seed/count, graph open, real-WebView pinch, keyboard-accessible pan, settings panel, tag toggle, tab/reload persistence, background/resume, absence of external WebView requests, frame interval sample, search/select/open synthetic local note.
- Deliberately NOT certified yet: process-death persistence, rotation, multi-vault switches, large5000/20000 load, complete Desktop semantic differential oracle, OS-level touch gestures, profiler CPU/renderer memory attribution, exact WebView83, physical OEM behavior. A subset pass must not be called full feature acceptance.

Evidence only: checks JSON + explicit synthetic PNG + runtime/provider/ABI/APKhash + gfxinfo/meminfo. No APK or raw logs upload. Two bounded half-size synthetic PNGs are emitted between `GRAPH_QA_PNG_BEGIN <name>` / `GRAPH_QA_PNG_END <name>` to let a reviewer retrieve and visually inspect pixels from text-only GitHub job logs. Full-size screenshots remain in the evidence artifact. Never place user-supplied reference images in this directory or evidence path.

Local preparation checks (`bash -n`, `node --check`, YAML parse) do not establish emulator success. The actual remote run must be reviewed before reporting any pass.

## Host browser lane (separate evidence category)

The same exact-branch/manual workflow also runs a host Chromium job. It uses the runner's existing Chrome with its **default sandbox unchanged**, temporary browser profile and loopback CDP. Missing sandbox capability is reported as infrastructure blockage; there is no `--no-sandbox`, browser install, sudo, namespace tweak or permission change fallback.

`cargo +1.95.0 test --locked --manifest-path tests/graph-export-native/Cargo.toml` exercises the production PNG export module. The browser job then runs the actual Canvas/Worker synthetic fixture via Vite and the production host/settings synthetic-data fixture. These are not Android/native-vault tests and remain separately named in results/artifacts. Screenshot logs/artifacts contain only generated synthetic content. `tests/graph-ui/browser-check.mjs` owns light/dark 360/430 UI coverage.

Software-emulation option is documented by Android: https://developer.android.com/studio/run/emulator-commandline . Runtime compatibility/boot is still measured rather than assumed. `emulation-mode.json` records requested mode, explicit accelerator argument and deadline even on failure; successful APK tests establish it actually booted. Emulator measurements of either mode are not physical-device performance claims.
