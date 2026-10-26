# Unified-vault disposable Android QA

This directory reuses the reviewed public graph QA transport/boot gates from
`xiaorui2886/LuckyRayMobile@e33870d9912808e6331bbe9185cddf312d55d7b2`.
The current entrypoint is `installed-unified.mjs`, not the historical migration-based
`installed-app.mjs`. Historical graph-only modules are retained for provenance and
future expansion; their presence does **not** mean their checks ran this round.

## Guardrails

- Dedicated branch `ray/mobile-unified-vault-qa-20261026`; one macOS Intel/API35 lane,
  preflight before build, plus separately labelled host browser tests.
- One run-unique disposable AVD: fresh preflight initialization, full stability and
  app-empty checks, normal shutdown; after build the same synthetic profile cold
  starts without a second wipe, repeats health/app-empty gates, then installs the
  real debug APK. No pm clear and no OS network settings changes. The initial
  phase is unpaired-local, not a whole-device offline claim. A run/attempt/API/config-bound marker is published only after
  successful preflight and observed normal shutdown. No cross-run reuse or snapshot.
- Real debug APK/native IPC. No product hooks, direct DB
  editing, mocked IPC, user device, credentials, pairing records, signing keys or
  user notes. Only synthetic named fixtures are created.
- Existing SDK licenses only, unchanged host/browser sandbox. Failure stays failure;
  no browser fallback for Android startup, no repeated install, no dismissed ANR.
- Read-only workflow permissions; checkout does not persist credentials.
- APK is build-local only. Uploaded evidence is restricted to structured JSON,
  synthetic PNG screenshots and optional MP4/WebM, seven-day retention. No APK,
  raw logcat, SQLite files, private histories or caches are published.
- Notify the owner before **every** GitHub Runner use. Publication and trigger are
  owned by the coordinating agent, not by these preparation scripts.

## Exact current coverage (only PASS after run evidence)

1. Actual app navigation and UI new-vault creation, using managed_vault_create.
2. Native idempotent creation and same-name distinct identities; no migration fixture.
3. Twenty synthetic native notes in each of two unbound vaults.
4. One catalog / selected identity across notes and graph, no duplicate options,
   graph node provenance after switching between equal display names.
5. Settings bounds leave canvas visible; screenshots of actual packaged WebView.
6. Graph creation cancel neither writes nor displays error/toast.
7. Force-stop observed old PID, verify absent, launch distinct PID, then compare
   native catalog/notes and selected graph identity, with no reseed or second clear.
8. System/app startup/ANR gates and actual runtime WebView provider identity.

A final stage stops the harness-owned synthetic peer process, verifies the app
reports disconnected, and asserts the same bound local notes and graph remain
readable. This simulates peer unavailability only; it does not change OS networking
or claim a whole-device offline test. It is PASS only with its own run evidence.

A third phase starts a runtime-only synthetic HTTPS peer and performs normal
product pairing/binding/sync through native APIs. It must pass its own assertions
before `desktopBinding=PASS_SYNTHETIC_PEER`; until then it is NOT_RUN. The peer
worker owns the exact scenario assertions. Pairing JSON and server-private logs
stay outside uploaded evidence. Real LAN connectivity, real desktop interoperability,
physical Xiaomi/MIUI and ARM64 remain **NOT_RUN**. Do not infer them from local native success.
Host Canvas/Worker checks are host-only, never Android success.

## Historical run evidence

Run `40234873650`: host-browser passed; Linux API30/35 and Mac API30 failed
preflight with build/install skipped. Mac API35 preflight and APK build passed,
then the before-install stability gate observed `Application Not Responding: system`
at 135.18s on its second fresh AVD. The APK had not yet been installed: application
checks were NOT_RUN. This was verified through the dedicated job-log connector
(job 121294174368), not inferred from the job name. The cause of the system ANR
remains unknown. The single API35 lane is not a claim that it has been fixed.
