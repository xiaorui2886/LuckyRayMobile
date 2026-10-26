## Approved bounded follow-up after run 40401952198 (not yet executed)

That run proved KVM acceleration, actual four guest CPUs, a 30-second cold boot,
and a 120-second healthy observation. Before the second launch, effective access
to `/dev/kvm` was gone. The ACL contents were not recorded at that point, so the
actor and precise mutation are UNKNOWN; no emulator/System UI cause is asserted.
The gate stopped before APK build, and original ACL restoration succeeded.

The approved next-run candidate adds read-only per-phase UID/device/inode/mode/ACL
observations before capability checks and before/after clean shutdown. A bounded
recheck can restore only the same named UID's rw entry if that entry alone is
missing, with unchanged root-owned device identity and safe base ACL. Extra users,
groups, masks or permissions fail closed. At most one check/reapply per planned
reopen stage is permitted, with prior successful empty-AVD phase proof. No loop,
udev rule, group change, world access or root emulator is introduced. The owner approved one next run at 21:23 UTC, including public test scripts. The
new exact branch is `ray/mobile-unified-vault-kvm-20261026-2124`, first creation
and first attempt only. The earlier `2044` branch authorization is consumed and
is not reused.

## Current one-shot Linux KVM lane (2026-10-26)

The next installed-app run is restricted to creation of the exact fresh branch
`ray/mobile-unified-vault-kvm-20261026-2124`, first attempt only. Later pushes,
manual dispatch, and reruns do not reuse the owner's device-access approval.
`kvm-access.py` independently checks the event, repository, ref, commit, hosted
Linux identity and non-root UID. It adds only that UID's read/write ACL on the
root-owned `/dev/kvm` character device, preserving owner/group/world permissions.
Existing ACL tools are required; no package install, chmod 666, group/udev/network
changes, root emulator, or software CPU fallback. An always-run cleanup restores
the original ACL before the disposable runner is destroyed.

The empty AVD must cold boot, pass its observation gate, shut down normally, then
reopen and pass the same health gate BEFORE dependency setup and expensive APK
compilation. Both normal-shutdown provenance markers are required for the later
installation boot; it never wipes the profile on reopen. First/reopened stability
results are separate evidence files. A system failure is NOT_RUN app acceptance.

Prior Mac Intel runs compiled the APK, but one hit a Bash 3.2 harness bug (fixed),
and the next hit Android System UI ANR before app installation. Those builds are
not evidence that LuckyRay installed-app or automatic-sync checks passed. The
historical lane notes below describe previous capabilities, not current acceptance.

# Unified-vault disposable Android QA

This directory reuses the reviewed public graph QA transport/boot gates from
`xiaorui2886/LuckyRayMobile@e33870d9912808e6331bbe9185cddf312d55d7b2`.
The current entrypoint is `installed-unified.mjs`, not the historical migration-based
`installed-app.mjs`. Historical graph-only modules are retained for provenance and
future expansion; their presence does **not** mean their checks ran this round.

## Guardrails

- Current dedicated branch `ray/mobile-unified-vault-kvm-20261026-2044`; one Ubuntu
  KVM/API35 lane with initial and reopened empty preflight before build, plus
  separately labelled host browser tests. The macOS lane is historical only.
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
