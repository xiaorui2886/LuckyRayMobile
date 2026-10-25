package com.luckyray.mobile

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var mainWebView: WebView? = null
  override fun onResume() {
    super.onResume()
    LshEmbeddedSurface.resumeFor(this)
    // A content-free lifecycle signal after Wry has resumed the existing
    // WebView. The startup compatibility layer alone handles old-engine jobs;
    // newer engines stay untouched. No reload or new public IPC/eval entry.
    mainWebView?.post {
      mainWebView?.evaluateJavascript("window.dispatchEvent(new Event('lr:main-resume'))", null)
    }
  }
  override fun onPause() {
    LshEmbeddedSurface.pause()
    super.onPause()
  }
  override fun onDestroy() {
    LshEmbeddedSurface.destroyFor(this)
    mainWebView = null
    super.onDestroy()
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // INTERACTION-CLOSURE-R1: hand the activity to DeviceBridge so Rust can
    // drive root-Back (moveTaskToBack) and system-bar appearance through the
    // ALREADY-KEPT DeviceBridge class — no new JNI surface, no R8 risk.
    DeviceBridge.appActivity = this
    styleSystemBars()
    applySystemBarInsets()
    KeystoreBridge.appContext = applicationContext
    DeviceBridge.appContext = applicationContext
    CaptureBridge.init(this)
    QrScannerBridge.init(this)
    // Issue #72 G1 row 5: warm LshSurfaceBridge during startup so its
    // `init { nativeInit() }` caches the JVM + class GlobalRef BEFORE Rust
    // ever opens the LightSeek shell. Same seam as ThumbnailBridge.warm().
    LshSurfaceBridge.warm()
    // M2.7 share target: initialize ShareBridge (its init block caches the
    // bridge class for Rust) and handle a cold-start ACTION_SEND intent while
    // the temporary content URI grant is still valid. Content is copied into
    // app-private storage immediately; Rust ingests it via the startup
    // reconcile or the frontend mount-time ingest.
    ShareBridge.init(this)
    NoteImportBridge.init(this)
    maybeHandleShare(intent)
    // M2.9 material library: warm the thumbnail bridge so the JVM + class
    // GlobalRef are cached before any native-thread JNI call.
    ThumbnailBridge.warm()
    // MATERIALS-PLAYBACK: cache the JNI class at startup (multidex safe).
    // It creates no player/Activity until an explicit, owner-bound play call.
    MediaPlayerBridge.warm()
    // M2.11 companion storage & export: init caches the bridge class for Rust
    // (its init{} block registers the JNI VM/GlobalRef), enabling the export /
    // share / storage-stat / cache-cleanup commands.
    ExportBridge.init(this)
  }

  private fun styleSystemBars() {
    window.decorView.setBackgroundColor(Color.rgb(9, 9, 11))
    WindowInsetsControllerCompat(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
  }

  /**
   * Keep the WebView content clear of system bars, display cutouts, the gesture
   * navigation area AND the on-screen keyboard. Android enforces edge-to-edge
   * for target SDK 35+ while older WebViews can still report CSS safe-area
   * insets as zero, so the native content root is the reliable compatibility
   * boundary.
   *
   * STABILITY-FIX-R1(B): this is the SINGLE layout authority for the IME on
   * Android. The MI 8's WebView 83 never reports keyboard height through
   * `window.visualViewport`, so a web-side estimator cannot work; the content
   * root is padded by max(system bars/cutout, ime) instead and the web layer
   * simply lays out inside the already-shrunk viewport. Do not add a second
   * IME mechanism (e.g. injecting a CSS variable via evaluateJavascript):
   * stacking two authorities would double the offset.
   *
   * The listener is invoked again by the framework whenever the IME appears or
   * disappears, so the padding is always re-derived from the current insets.
   */
  private fun applySystemBarInsets() {
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val safe = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      // max(), not a sum: when the IME is showing, the ime inset already
      // includes the navigation-bar space it covers.
      val bottom = maxOf(safe.bottom, ime.bottom)
      view.setPadding(safe.left, safe.top, safe.right, bottom)
      LshEmbeddedSurface.imeChanged(windowInsets.isVisible(WindowInsetsCompat.Type.ime()))
      windowInsets
    }
    ViewCompat.requestApplyInsets(content)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // M2.7 share target, warm resume: MainActivity is singleTask, so a share
    // while the app is already running arrives here instead of onCreate.
    maybeHandleShare(intent)
  }

  /** P1-B (FIX-V1): READ_MEDIA_* runtime-request workaround removed pending
   * Main Controller approval. ACTION_SEND is handled directly; the system
   * share sheet's FLAG_GRANT_READ_URI_PERMISSION grant is the only access
   * path (verified on API 29 MI 8 and API 35 emulator with the redacted
   * grant diagnostics in ShareBridge). */
  private fun maybeHandleShare(intent: Intent?) {
    ShareBridge.handle(intent)
    NoteImportBridge.handle(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    mainWebView = webView
    // hand the WebView to the QR bridge so the camera preview can overlay it
    QrScannerBridge.setWebView(webView)
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (LshEmbeddedSurface.onActivityResult(requestCode, resultCode, data)) return
    if (requestCode == NoteImportBridge.REQ_NOTE) {
      NoteImportBridge.result(resultCode, data)
      return
    }
    // route capture picker results to the bridge (M2.9 adds the video picker)
    if (requestCode == CaptureBridge.REQ_IMAGE || requestCode == CaptureBridge.REQ_PHOTO
        || requestCode == CaptureBridge.REQ_FILE || requestCode == CaptureBridge.REQ_VIDEO) {
      CaptureBridge.onResult(requestCode, resultCode, data)
      return
    }
    super.onActivityResult(requestCode, resultCode, data)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == QrScannerBridge.REQ_CAMERA_PERMISSION) {
      val granted = grantResults.isNotEmpty() && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
      QrScannerBridge.onCameraPermissionResult(granted)
  }
}
}
