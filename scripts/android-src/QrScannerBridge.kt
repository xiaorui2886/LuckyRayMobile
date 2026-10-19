package com.luckyray.mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.util.Size
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native QR scanner bridge — CameraX + BUNDLED ML Kit barcode scanning.
 *
 * Bundled ML Kit (com.google.mlkit:barcode-scanning) ships the model inside the
 * APK and does NOT require Google Play Services, unlike the unbundled
 * play-services-mlkit-* artifacts (which the tauri-plugin-barcode-scanner uses).
 * This is what makes QR pairing work on Chinese-market / no-GMS devices.
 *
 * Lifecycle: scanStart() adds a full-screen CameraX preview over the WebView;
 * scanStop() tears the camera down. Result is written to a meta file consumed by
 * the Rust side (qr.rs) — same pattern as CaptureBridge.
 */
object QrScannerBridge {
    private const val DIR = "qr-scanner"
    private const val META = "qr-result.meta.json"

    lateinit var appContext: Context
    private var activity: ComponentActivity? = null
    private var webView: WebView? = null
    private var previewView: PreviewView? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private var scanner: com.google.mlkit.vision.barcode.BarcodeScanner? = null

    @Volatile private var running = false
    @Volatile private var refId = ""
    @Volatile private var awaitingPermission = false

    const val REQ_CAMERA_PERMISSION = 104

    init { nativeInit() }

    private external fun nativeInit()

    @JvmStatic
    fun init(act: ComponentActivity) {
        activity = act
        appContext = act.applicationContext
    }

    @JvmStatic
    fun setWebView(wv: WebView?) {
        webView = wv
    }

    /** Start the camera + analyzer. Returns a refId; permission denial becomes a terminal meta error. */
    @JvmStatic
    fun scanStart(): String {
        synchronized(this) {
            if (running) return ""
            running = true
            refId = "qr-" + java.util.UUID.randomUUID().toString().substring(0, 8)
        }
        val act = activity ?: return fail("no activity")
        val wv = webView ?: return fail("no webview")
        clearMeta()
        if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            awaitingPermission = true
            act.runOnUiThread {
                if (running && awaitingPermission) {
                    act.requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA_PERMISSION)
                }
            }
            return refId
        }
        startCamera(act, wv)
        return refId
    }

    /** Called by MainActivity after the primary no-GMS scanner request resolves. */
    @JvmStatic
    fun onCameraPermissionResult(granted: Boolean) {
        if (!running || !awaitingPermission) return
        awaitingPermission = false
        if (!granted) {
            fail("camera permission denied")
            return
        }
        val act = activity ?: run {
            fail("no activity")
            return
        }
        val wv = webView ?: run {
            fail("no webview")
            return
        }
        startCamera(act, wv)
    }

    private fun startCamera(act: ComponentActivity, wv: WebView) {
        act.runOnUiThread {
            if (!running) return@runOnUiThread
            try {
                val pv = PreviewView(act).apply {
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                }
                val parent = wv.parent as? ViewGroup
                    ?: return@runOnUiThread failOnUi("no webview parent")
                parent.addView(pv)
                previewView = pv

                val future = ProcessCameraProvider.getInstance(act)
                future.addListener({
                    try {
                        val provider = future.get()
                        cameraProvider = provider
                        bind(provider)
                    } catch (e: Exception) {
                        failOnUi("camera bind: ${e.message}")
                        tearDownCamera()
                    }
                }, ContextCompat.getMainExecutor(act))
            } catch (e: Exception) {
                failOnUi("camera start: ${e.message}")
                tearDownCamera()
            }
        }
    }

    private fun bind(provider: ProcessCameraProvider) {
        val act = activity ?: return
        val preview = Preview.Builder().build().also {
            it.surfaceProvider = previewView?.surfaceProvider
        }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setTargetResolution(Size(1280, 720))
            .build()
        analysis.setAnalyzer(ContextCompat.getMainExecutor(act)) { image ->
            analyze(image)
        }
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        scanner = BarcodeScanning.getClient(options)
        try {
            provider.bindToLifecycle(act, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        } catch (e: Exception) {
            failOnUi("camera bind: ${e.message}")
        }
    }

    private fun analyze(image: ImageProxy) {
        val media = image.image
        if (media == null) { image.close(); return }
        val input = InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees)
        scanner?.process(input)
            ?.addOnSuccessListener { barcodes ->
                if (barcodes.isNotEmpty()) {
                    val content = barcodes[0].rawValue ?: ""
                    if (content.isNotEmpty()) {
                        writeMeta(content)
                        tearDownCamera()
                    }
                }
            }
            ?.addOnFailureListener { }
            ?.addOnCompleteListener {
                image.close()
                media.close()
            }
    }

    /** Stop the camera (called by Rust after timeout/cancel or on success). */
    @JvmStatic
    fun scanStop() {
        awaitingPermission = false
        val act = activity
        if (act != null) {
            act.runOnUiThread { tearDownCamera() }
        } else {
            tearDownCamera()
        }
        synchronized(this) { running = false }
    }

    private fun tearDownCamera() {
        try {
            cameraProvider?.unbindAll()
        } catch (_: Exception) {}
        cameraProvider = null
        scanner?.close()
        scanner = null
        val pv = previewView
        if (pv != null) {
            val parent = pv.parent as? ViewGroup
            parent?.removeView(pv)
            previewView = null
        }
    }

    /** True while a scan is active (Rust poll guard). */
    @JvmStatic
    fun isRunning(): Boolean = running

    /** Path to the result meta file (Rust reads this). */
    @JvmStatic
    fun metaPath(): String {
        val dir = File(appContext.filesDir, DIR)
        if (!dir.exists()) dir.mkdirs()
        return File(dir, META).absolutePath
    }

    private fun writeMeta(content: String) {
        try {
            val meta = JSONObject()
                .put("status", "done")
                .put("content", content)
                .put("refId", refId)
                .put("ts", System.currentTimeMillis())
            File(metaPath()).writeText(meta.toString())
        } catch (_: Exception) {}
    }

    private fun clearMeta() {
        try { File(metaPath()).delete() } catch (_: Exception) {}
    }

    /** Write an error meta (Rust surfaces it as typed error instead of hanging). */
    private fun fail(msg: String): String {
        try {
            val meta = JSONObject()
                .put("status", "error")
                .put("error", msg)
                .put("refId", refId)
                .put("ts", System.currentTimeMillis())
            File(metaPath()).writeText(meta.toString())
        } catch (_: Exception) {}
        synchronized(this) {
            running = false
            awaitingPermission = false
        }
        return refId
    }

    private fun failOnUi(msg: String) {
        fail(msg)
        tearDownCamera()
    }
}
