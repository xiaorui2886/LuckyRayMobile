# Building LuckyRay Mobile

This repository contains a standalone Tauri 2 / React Android client. Its public
build needs no private source checkout, private registry, personal access token,
production signing key, paired desktop, or connected phone.

## Frontend checks

Use Node.js 24 and pnpm 11.3.0. From the repository root:

```sh
pnpm install --frozen-lockfile
node scripts/run-ci-lite-local.mjs
pnpm build
```

The workflow `.github/workflows/ci-lite.yml` is the source of truth for the
explicit test list. It includes the editor, navigation, sync, and offline contract
checks, including the current wiki-completion and reading-mode tests. Do not
replace this list with a wildcard: tests requiring a live companion gateway are
outside public CI. A passing frontend suite is not an end-to-end phone or
companion-service compatibility test.

## Android development APK on Linux

Install JDK 17, Rust stable through rustup, and Android SDK command-line tools.
The workflow uses the standard GitHub-hosted `ubuntu-24.04` runner, not a larger
or self-hosted runner. Install the following SDK components using Android's
SDK Manager, reviewing and accepting Google's SDK terms yourself as required:

```sh
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.2.12479018"
rustup target add aarch64-linux-android
```

Set `JAVA_HOME` to your JDK 17 installation and `ANDROID_HOME` to your SDK root.
Then, after the frozen pnpm install:

```sh
bash scripts/build-android-public.sh
```

This generates the Android project from the locked Tauri CLI, applies the
tracked Kotlin/JNI, manifest, and media patches, and builds an ARM64 debug APK.
The generated `src-tauri/gen/android` directory is disposable build output.
Do not commit `local.properties`, generated keys, machine paths, or build output.

APKs are under `src-tauri/gen/android/app/build/outputs/apk/`. The candidate
workflow described below checks package identity, alignment, build mode, and
expected native bridges, then uploads the unsigned release APK with SHA-256
checksums and this guide. Artifacts expire after seven days.
The workflow never creates a GitHub Release or installs on a device.

## Signing and installation safety

Local debug builds use Android's automatically generated debug
signing key. No production signing material is used or supplied. The application
ID remains `com.luckyray.mobile`; no alternate product or migration is created.

A development APK cannot update an installed copy signed with a different key.
Ephemeral CI debug keys can also differ between runs. This is not a replacement
or upgrade promise for an existing installation. Use a separate test device or
an emulator without important data. Do not uninstall an existing app just to
bypass a signature mismatch: uninstalling can erase its local data.

Debug builds are debuggable and use development network-security settings. They
are unsuitable for production distribution. Signature and bridge-symbol checks
are packaging checks, not proof of runtime, camera, sync, or data-migration
correctness. Release signing and store distribution require a separate process.

## Dependency and CI boundaries

JavaScript uses the committed `pnpm-lock.yaml` with `--frozen-lockfile`; Rust
uses the committed `src-tauri/Cargo.lock` with `--locked`. CI checks that both
lockfiles remain unchanged. Android patches specify their direct native-library
versions. Actions are pinned to immutable commit IDs. Node 24, JDK 17, Rust
stable, the runner image, and transitive Gradle downloads can still change:
this is a repeatable build procedure, not a byte-for-byte reproducibility claim.

The workflow grants only `contents: read`, does not retain checkout credentials,
and requires no repository secrets. Dependency downloads use public registries.
Pull requests use `pull_request`, never `pull_request_target`. The APK job runs
only after frontend checks pass. A focused Rust job runs the actual pinning module's four tests in a disposable
crate, using the application lockfile's exact dependency versions and checksums.
It generates synthetic certificates only in memory. It does not need Tauri GUI
libraries or any stored certificate fixture. Run it locally with Python 3.11+
and Rust installed: `python3 scripts/check-pinning-public.py`.
The Android build compiles the full Rust library for ARM64; broader host-platform
Rust tests are outside this workflow.

References:
- [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android)
- [Tauri Android CLI options](https://v2.tauri.app/reference/cli/#android-build)
- [Tauri APK and architecture guidance](https://v2.tauri.app/distribute/google-play/)
- [Android SDK terms](https://developer.android.com/studio/terms)

## Optimized release candidate (no publication)

Use `bash scripts/build-android-public.sh --release` to compile optimized Rust
and Android release code, including the tracked R8/JNI keep rules. Omitting the
argument retains the local debug-build option. This candidate branch's public
workflow builds the release variant and uploads an **unsigned** APK, SHA-256
checksums, and `BUILD-IDENTITY.json`; it does not create a GitHub Release.
The job also verifies the package, ARM64 ABI, non-debuggable flag, alignment,
and retained native bridges. It never receives a signing key.

An unsigned APK cannot be installed. The device owner must sign it locally with
the existing matching key, verify the final certificate and APK checksum, and
only then update in place. Back up the installed APK first. A mismatch must
stop installation; do not uninstall or clear data to work around it. The
release build mode does not imply stable-release acceptance or store signing.


## Managed local-vault React DOM validation (optional local tools)

The explicit CI Lite unit/contract list includes the managed-vault, import-intent,
resource, wiki identity and multi-vault scheduler tests. The React DOM suites are
separate: the production lockfile does not include jsdom, and CI does not silently
install or run it.

To run these suites with an existing, pinned jsdom 26.1.0 test-tools installation:

```sh
LR_DOM_TEST_TOOLS=/absolute/path/to/test-tools/node_modules node scripts/check-managed-dom.mjs
# Or include them after the complete CI Lite equivalent:
LR_DOM_TEST_TOOLS=/absolute/path/to/test-tools/node_modules node scripts/run-ci-lite-local.mjs --with-managed-dom
```

The scripts fail explicitly if the requested DOM tools are absent or have a
different version. They do not download packages. They use real React and actual
production UI components with synthetic native/API seams. Passing them does not
prove Android lifecycle behavior, device rendering, or real data migration.
