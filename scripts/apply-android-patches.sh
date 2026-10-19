#!/usr/bin/env bash
# LuckyRay Mobile — apply verified Android build patches after `tauri android init`.
# Includes Windows and non-ASCII path compatibility fixes; see BUILDING.md.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../src-tauri/gen/android"

# 1) Kotlin Gradle Plugin: template 1.9.25 is incompatible with Gradle 8.14 (stdlib resolution).
sed -i 's|classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")|classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.20")|' build.gradle.kts

# 2) AGP rejects non-ASCII project path on Windows.
grep -q "overridePathCheck" gradle.properties || printf '\nandroid.overridePathCheck=true\n' >> gradle.properties

# 3) R8 must keep the JNI bridges (otherwise they are stripped from release APK).
cat > app/keystore.pro <<'EOF'
# ---- LuckyRay native bridge keep rules (Rust JNI entry points) ----
# Each bridge is called from Rust via JNI; R8 would strip them from the
# release APK (M2.2 regression: CaptureBridge.launch was stripped ->
# NoSuchMethodError in the SAF picker). Keep them ALL together here.
-keep class com.luckyray.mobile.KeystoreBridge { *; }
-keepclassmembers class com.luckyray.mobile.KeystoreBridge { *; }
-keep class com.luckyray.mobile.DeviceBridge { *; }
-keepclassmembers class com.luckyray.mobile.DeviceBridge { *; }
-keep class com.luckyray.mobile.CaptureBridge { *; }
-keepclassmembers class com.luckyray.mobile.CaptureBridge { *; }
-keep class com.luckyray.mobile.QrScannerBridge { *; }
-keepclassmembers class com.luckyray.mobile.QrScannerBridge { *; }
-keep class com.luckyray.mobile.ShareBridge { *; }
-keepclassmembers class com.luckyray.mobile.ShareBridge { *; }
-keep class com.luckyray.mobile.ThumbnailBridge { *; }
-keepclassmembers class com.luckyray.mobile.ThumbnailBridge { *; }
-keep class com.luckyray.mobile.MediaPlayerBridge { *; }
-keepclassmembers class com.luckyray.mobile.MediaPlayerBridge { *; }
-keep class com.luckyray.mobile.ExportBridge { *; }
-keepclassmembers class com.luckyray.mobile.ExportBridge { *; }
# LSH-REMOTE-SURFACE-M1: Rust JNI opens the dedicated WebView shell through
# this bridge; the activity itself is manifest-referenced and needs no keep.
-keep class com.luckyray.mobile.LshSurfaceBridge { *; }
-keepclassmembers class com.luckyray.mobile.LshSurfaceBridge { *; }
# INTERACTION-CLOSURE-R1: Rust JNI calls MainActivity.moveTaskToBack() and
# setSystemBarAppearance() (root Back fallback + system-bar appearance).
# R8 strips/renames companion methods without an explicit keep.
-keepclassmembers class com.luckyray.mobile.MainActivity {
    public static ** moveTaskToBack();
    public static ** setSystemBarAppearance(*);
}
# epoch368 RUNTIME-CRASH regression: the Rust runtime reaches the generated
# framework activity's plugin manager through JNI
# (`MainActivity.getPluginManager()Lapp/tauri/plugin/PluginManager;`). R8
# removed TauriActivity.getPluginManager from the release APK because only
# WryActivity carries a keep rule (see the CLI-generated proguard-wry.pro),
# producing `NoSuchMethodError: no non-static method ...getPluginManager()`
# at launch. Same class of failure as the M2.2 CaptureBridge regression above:
# a JNI-visible framework method must be kept explicitly.
-keep class com.luckyray.mobile.TauriActivity { *; }
-keepclassmembers class com.luckyray.mobile.TauriActivity {
    public app.tauri.plugin.PluginManager getPluginManager();
    public boolean handleBackNavigation();
}
EOF

# 4) AndroidManifest: camera + local network permissions.
MANIFEST=app/src/main/AndroidManifest.xml
# This player is foreground-only and uses the view's keepScreenOn flag, not
# Media3's optional wake mode. Do not add a new background WAKE_LOCK permission
# through a transitive library manifest; preserve the delivered APK contract.
grep -q 'xmlns:tools=' "$MANIFEST" || sed -i 's|<manifest xmlns:android=|<manifest xmlns:tools="http://schemas.android.com/tools" xmlns:android=|' "$MANIFEST"
grep -q 'android.permission.WAKE_LOCK" tools:node="remove"' "$MANIFEST" || sed -i 's|<uses-permission android:name="android.permission.INTERNET" />|<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.WAKE_LOCK" tools:node="remove" />|' "$MANIFEST"
# Android's asset interception cannot reliably stream/seek cached media on
# physical devices. Allow only our token-protected IPv4 loopback media server.
grep -q 'android:networkSecurityConfig=' "$MANIFEST" || sed -i 's|<application|<application android:networkSecurityConfig="@xml/network_security_config"|' "$MANIFEST"
mkdir -p app/src/main/res/xml app/src/debug/res/xml
cat > app/src/main/res/xml/network_security_config.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
XML
cat > app/src/debug/res/xml/network_security_config.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
XML
grep -q "android.permission.CAMERA" "$MANIFEST" || sed -i 's|<uses-permission android:name="android.permission.INTERNET" />|<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />|' "$MANIFEST"
# 4b) Maintain the Gradle CLI task and SDK properties from tracked sources.
# scripts/tauri-wrapper.cmd remains a portable manual CLI entry point.
node "$SCRIPT_DIR/configure-android-build.mjs"

echo "android patches applied"

# 5) FileProvider must expose the capture-outbox dir for camera output.
cat > app/src/main/res/xml/file_paths.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <external-path name="my_images" path="." />
  <cache-path name="my_cache_images" path="." />
  <files-path name="capture_outbox" path="capture-outbox/" />
</paths>
XML

# 5b) M2.11: DEDICATED NARROW provider for companion share/export — exposes
#     ONLY the Mobile-owned roots (Local Asset originals + Local Inbox
#     attachments), never the app data dir or external storage.
cat > app/src/main/res/xml/export_file_paths.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <files-path name="local_assets_originals" path="local-assets/originals/" />
  <files-path name="local_inbox" path="local-inbox/" />
  <cache-path name="desktop_content_resources" path="content-resources/" />
</paths>
XML
# register the narrow provider (authority ${applicationId}.exportprovider)
grep -q "exportprovider" "$MANIFEST" || sed -i 's|</application>|    <provider\n      android:name="androidx.core.content.FileProvider"\n      android:authorities="${applicationId}.exportprovider"\n      android:exported="false"\n      android:grantUriPermissions="true">\n      <meta-data\n        android:name="android.support.FILE_PROVIDER_PATHS"\n        android:resource="@xml/export_file_paths" />\n    </provider>\n  </application>|' "$MANIFEST"
# M2.13 FIX-V2: the exported NarrowFileProvider (FIX-V1 experiment) must
# NEVER be present — open/share go through the non-exported exportprovider.
grep -q "NarrowFileProvider" "$MANIFEST" && python - "$MANIFEST" <<'PYINNER'
import sys, re
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
if "NarrowFileProvider" in s:
    s = re.sub(r'\s*<provider\s+android:name="com\.luckyray\.mobile\.NarrowFileProvider"[^>]*/>', "", s, count=1)
    open(p, "w", encoding="utf-8").write(s)
PYINNER
# M2.13 FIX-V2: idempotent contract patches — windowSoftInputMode=adjustResize
# and the ACTION_SEND filters (text/plain, image/*, */*) must exist on the
# generated activity (the tauri template ships them; keep the guarantee).
python - "$MANIFEST" <<'PYINNER'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
if 'android:windowSoftInputMode="adjustResize"' not in s:
    s = s.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:windowSoftInputMode="adjustResize"', 1)
for mime in ["text/plain", "image/*", "*/*"]:
    marker = '<data android:mimeType="%s" />' % mime
    if marker not in s:
        flt = ('\n    <intent-filter>\n      <action android:name="android.intent.action.SEND" />\n'
               '      <category android:name="android.intent.category.DEFAULT" />\n'
               '      <data android:mimeType="%s" />\n    </intent-filter>' % mime)
        s = s.replace("</activity>", flt + "\n  </activity>", 1)
open(p, "w", encoding="utf-8").write(s)
PYINNER
# LSH-REMOTE-SURFACE-M1: the dedicated full-screen WebView surface runs in
# its own NON-exported activity (the "exactly one exported component" pairing
# contract is preserved). Idempotent insertion before </application>.
if grep -q 'android:name=".LshSurfaceActivity"' "$MANIFEST"; then :; else
  python - "$MANIFEST" <<'PYINNER'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
activity = """
    <activity
      android:name=".LshSurfaceActivity"
      android:exported="false"
      android:configChanges="orientation|screenSize|keyboardHidden"
      android:theme="@android:style/Theme.NoTitleBar.Fullscreen" />
"""
s = s.replace("</application>", activity + "</application>", 1)
open(p, "w", encoding="utf-8").write(s)
PYINNER
fi

# MATERIALS-PLAYBACK-R1: opaque native surface, never externally exported.
if grep -q 'android:name=".MaterialsPlayerActivity"' "$MANIFEST"; then :; else
  node - "$MANIFEST" <<'JSINNER'
const fs = require('fs');
const p = process.argv[2];
const s = fs.readFileSync(p, 'utf8');
const activity = `
    <activity android:name=".MaterialsPlayerActivity" android:exported="false"
      android:configChanges="orientation|screenSize|screenLayout|keyboardHidden"
      android:theme="@android:style/Theme.Material.NoActionBar.Fullscreen" />
`;
fs.writeFileSync(p, s.replace('</application>', activity + '</application>'));
JSINNER
fi

# 6) Bridge Kotlin sources (MainActivity / KeystoreBridge / CaptureBridge /
#    DeviceBridge / QrScannerBridge / ShareBridge / ThumbnailBridge /
#    ExportBridge / LshSurfaceBridge / LshSurfaceActivity) are committed under
#    scripts/android-src and copied into the generated project.
SRC_KOTLIN="$SCRIPT_DIR/android-src"
DEST_KOTLIN=app/src/main/java/com/luckyray/mobile
cp "$SRC_KOTLIN/MainActivity.kt" "$DEST_KOTLIN/MainActivity.kt"
cp "$SRC_KOTLIN/KeystoreBridge.kt" "$DEST_KOTLIN/KeystoreBridge.kt"
cp "$SRC_KOTLIN/CaptureBridge.kt" "$DEST_KOTLIN/CaptureBridge.kt"
cp "$SRC_KOTLIN/DeviceBridge.kt" "$DEST_KOTLIN/DeviceBridge.kt"
cp "$SRC_KOTLIN/QrScannerBridge.kt" "$DEST_KOTLIN/QrScannerBridge.kt"
cp "$SRC_KOTLIN/ShareBridge.kt" "$DEST_KOTLIN/ShareBridge.kt"
cp "$SRC_KOTLIN/ThumbnailBridge.kt" "$DEST_KOTLIN/ThumbnailBridge.kt"
cp "$SRC_KOTLIN/ExportBridge.kt" "$DEST_KOTLIN/ExportBridge.kt"
cp "$SRC_KOTLIN/LshSurfaceBridge.kt" "$DEST_KOTLIN/LshSurfaceBridge.kt"
cp "$SRC_KOTLIN/LshSurfaceActivity.kt" "$DEST_KOTLIN/LshSurfaceActivity.kt"
cp "$SRC_KOTLIN/MediaPlayerBridge.kt" "$DEST_KOTLIN/MediaPlayerBridge.kt"
cp "$SRC_KOTLIN/MaterialsPlayerActivity.kt" "$DEST_KOTLIN/MaterialsPlayerActivity.kt"
# Carry the checked Media3 notice and the unmodified standard Apache2 license
# text already provided by our pinned Tauri dependency into generated assets.
mkdir -p app/src/main/assets/open-source
cp "$SRC_KOTLIN/MEDIA3-NOTICE.txt" app/src/main/assets/open-source/MEDIA3-NOTICE.txt
cp "$SCRIPT_DIR/../node_modules/@tauri-apps/api/LICENSE_APACHE-2.0" app/src/main/assets/open-source/APACHE-2.0.txt

# 7) Bundled ML Kit barcode scanning (no GMS required — model ships in APK).
#    tauri-plugin-barcode-scanner uses play-services-mlkit-barcode-scanning
#    (unbundled, needs GMS) so we drive the native bridge instead.
BUILD_KTS=app/build.gradle.kts
grep -q "com.google.mlkit:barcode-scanning" "$BUILD_KTS" || sed -i 's|implementation("com.google.android.material:material:1.12.0")|implementation("com.google.android.material:material:1.12.0")\n    implementation("com.google.mlkit:barcode-scanning:17.3.0")\n    implementation("androidx.camera:camera-core:1.5.1")\n    implementation("androidx.camera:camera-camera2:1.5.1")\n    implementation("androidx.camera:camera-lifecycle:1.5.1")\n    implementation("androidx.camera:camera-view:1.5.1")|' "$BUILD_KTS"
# Platform MediaCodec + two pinned AndroidX modules, no FFmpeg/libmpv/codec
# native extension bundle or GMS-dependent network stack.
grep -q 'androidx.media3:media3-exoplayer:1.11.1' "$BUILD_KTS" || sed -i 's|implementation("com.google.android.material:material:1.12.0")|implementation("com.google.android.material:material:1.12.0")\n    implementation("androidx.media3:media3-exoplayer:1.11.1")\n    implementation("androidx.media3:media3-ui:1.11.1")|' "$BUILD_KTS"
