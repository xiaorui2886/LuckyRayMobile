#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""M2.3 keep-rule sanity check: verify every native JNI bridge class survives
R8 in the release APK. Run AFTER building the release APK.

Usage:
    python scripts/check-apk-bridges.py <path-to-release.apk>

Exits non-zero if any bridge class or its JNI entry points are missing.
"""
import sys
import zipfile

BRIDGES = {
    # class name -> JNI methods that MUST be present (static, called from Rust)
    "KeystoreBridge": ["saveSecret", "loadSecret", "deleteAllSecrets"],
    "CaptureBridge": ["launch", "onResult", "metaPath", "outboxDir", "cancel", "init"],
    "DeviceBridge": ["gmsAvailable", "moveTaskToBack", "setSystemBarAppearance"],
    "QrScannerBridge": ["scanStart", "scanStop", "metaPath"],
    "ShareBridge": ["handle", "localInboxDir", "localAssetsDir", "diagnosticsDir", "init", "nativeInit", "nativeNotify"],
    "ThumbnailBridge": ["generate", "warm", "nativeInit"],
    "MediaPlayerBridge": ["warm", "open", "close", "nativeInit", "nativeClaim", "nativeIsCurrent", "nativeFirstFrame", "nativeClosed"],
    # M2.11 companion storage & export. The checker grows with the TRUE bridge
    # count (6/6 -> 7/7) and must never be weakened to make a stripped bridge
    # pass.
    "ExportBridge": ["init", "openFile", "exportFile", "shareFile", "shareText", "storageStats", "clearCache", "ownerRoots", "nativeInit"],
}

# epoch368 RUNTIME-CRASH regression guard.
#
# The Rust runtime reaches the generated FRAMEWORK activity through JNI:
#   MainActivity is a subclass of the generated TauriActivity, and the runtime
#   invokes `MainActivity.getPluginManager()Lapp/tauri/plugin/PluginManager;`.
# The CLI-generated `proguard-wry.pro` keeps only `WryActivity`, so R8 removed
# `TauriActivity.getPluginManager` from the release APK and the app died at
# launch with
#   NoSuchMethodError: no non-static method "...MainActivity;.getPluginManager()".
# These entries are NOT LuckyRay bridges but the same invariant applies: a
# JNI-visible method must survive the release shrinker. Checked whenever the
# dex contains the framework activity.
FRAMEWORK_ACTIVITY = {
    "TauriActivity": ["getPluginManager"],
}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: check-apk-bridges.py <apk>")
        return 2
    apk = sys.argv[1]
    missing = []
    with zipfile.ZipFile(apk) as z:
        # classes.dex + any classesN.dex (multidex)
        dex_names = sorted(n for n in z.namelist() if n.endswith(".dex"))
        if not dex_names:
            print("FAIL: no dex files in APK")
            return 1
        blob = b"".join(z.read(n) for n in dex_names)
    for cls, methods in BRIDGES.items():
        if cls.encode() not in blob:
            missing.append(f"{cls}: class missing from dex")
            continue
        for m in methods:
            if m.encode() not in blob:
                missing.append(f"{cls}.{m}: method missing (R8 stripped?)")
    # Framework activity ABI (only when the activity class itself is present,
    # so a non-Tauri build is not forced to grow the class).
    for cls, methods in FRAMEWORK_ACTIVITY.items():
        if cls.encode() not in blob:
            continue
        for m in methods:
            if m.encode() not in blob:
                missing.append(
                    f"{cls}.{m}: framework JNI method missing from dex "
                    f"(R8 stripped it -> NoSuchMethodError at launch)")
    if missing:
        print("FAIL: bridge keep-rule check found problems:")
        for m in missing:
            print(f"  - {m}")
        return 1
    print(f"OK: all {len(BRIDGES)} bridge classes and their JNI methods present in {apk} "
          f"(+ framework activity ABI {', '.join(FRAMEWORK_ACTIVITY)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
