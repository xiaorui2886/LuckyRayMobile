package com.luckyray.mobile

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.AtomicFile
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Mobile capture bridge (Android): pick image / take photo / pick file.
 * Results are copied into the app-private outbox area and described by a
 * meta JSON file that the Rust side polls. Shared React code only sees
 * MobileCaptureAdapter. Uses startActivityForResult + MainActivity forwarding.
 *
 * The system picker is intentionally outside the durable outbox transaction.
 * If Android kills the app while that activity is open, the pending request is
 * abandoned safely and its private temporary file is reclaimed on restart;
 * only a completed Rust/SQLite enqueue becomes a durable capture.
 */
object CaptureBridge {
    private const val OUTBOX_DIR = "capture-outbox"
    private const val PREFS = "luckyray_capture_bridge"
    private const val PREF_REF = "ref"
    private const val PREF_META = "meta"
    private const val PREF_OUTPUT = "output"

    const val REQ_IMAGE = 101
    const val REQ_PHOTO = 102
    const val REQ_FILE = 103
    const val REQ_VIDEO = 104

    private lateinit var activity: Activity
    private var currentRefId: String? = null
    private var currentMetaPath: String? = null
    private var photoFile: File? = null
    private var currentOutputFile: File? = null

    init { nativeInit() }
    private external fun nativeInit()

    @JvmStatic
    fun init(act: Activity) {
        activity = act
    }

    @JvmStatic
    fun outboxDir(): String {
        return File(activity.filesDir, OUTBOX_DIR).apply { mkdirs() }.canonicalPath
    }

    /**
     * Launch a picker. kind: 0 = image, 1 = photo (camera), 2 = file,
     * 3 = video (M2.9 Local Library direct video import).
     * Returns immediately with the refId; the meta file appears when done.
     */
    @JvmStatic
    fun launch(kind: Int): String {
        if (currentRefId != null) {
            return "BUSY" // single-request model: a picker is already active
        }
        // A process-killed system activity has no Rust waiter to consume it.
        // Reclaim any stale request before beginning a fresh user operation.
        forgetPersistedRequest()

        val refId = "ref-" + System.currentTimeMillis().toString(16) + "-" + (0..0xffff).random().toString(16)
        val outbox = File(activity.filesDir, OUTBOX_DIR).apply { mkdirs() }
        currentRefId = refId
        currentMetaPath = File(outbox, "pending-$refId.meta.json").absolutePath
        persistCurrentRequest()
        try {
            when (kind) {
                0 -> {
                    activity.startActivityForResult(
                        Intent(Intent.ACTION_GET_CONTENT).setType("image/*"),
                        REQ_IMAGE
                    )
                }
                1 -> {
                    val output = File(outbox, "$refId.jpg")
                    photoFile = output
                    currentOutputFile = output
                    persistCurrentRequest()
                    val uri = FileProvider.getUriForFile(
                        activity,
                        "${activity.packageName}.fileprovider",
                        output
                    )
                    val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
                        .putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
                        .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    intent.clipData = ClipData.newRawUri("luckyray-capture", uri)
                    activity.startActivityForResult(intent, REQ_PHOTO)
                }
                2 -> {
                    activity.startActivityForResult(
                        Intent(Intent.ACTION_GET_CONTENT).setType("*/*"),
                        REQ_FILE
                    )
                }
                else -> {
                    // M2.9: dedicated gallery/video picker (same ACTION_GET_CONTENT
                    // lifecycle as image/file — no new grant handling).
                    activity.startActivityForResult(
                        Intent(Intent.ACTION_GET_CONTENT).setType("video/*"),
                        REQ_VIDEO
                    )
                }
            }
        } catch (e: Exception) {
            // ActivityNotFoundException, FileProvider failures, and vendor
            // camera failures become a terminal result instead of a Rust poll
            // timeout.
            onError(e)
        }
        return refId
    }

    /** Path of the pending meta file the Rust side should poll for this refId. */
    @JvmStatic
    fun metaPath(refId: String): String {
        return File(File(activity.filesDir, OUTBOX_DIR), "pending-$refId.meta.json").absolutePath
    }

    /**
     * Called by Rust when the polling deadline expires. It is safe and
     * idempotent: a late activity result is ignored rather than keeping the
     * bridge permanently BUSY.
     */
    @JvmStatic
    fun cancel(refId: String): String {
        if (currentRefId == null) {
            restorePendingRequest()
        }
        if (currentRefId == refId) {
            onCancelled()
        }
        return "ok"
    }

    /** Called from MainActivity.onActivityResult. */
    @JvmStatic
    fun onResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val restoredAfterProcessDeath = currentRefId == null && restorePendingRequest()
        if (currentRefId == null) {
            return
        }
        if (restoredAfterProcessDeath) {
            // The Rust invocation that launched this picker died with the
            // process, so no completion can be enqueued. Remove this temporary
            // result instead of leaking it or presenting a phantom capture.
            discardRecoveredResult()
            return
        }
        if (resultCode != Activity.RESULT_OK) {
            onCancelled()
            return
        }
        when (requestCode) {
            REQ_PHOTO -> {
                val file = photoFile
                if (file != null && file.exists()) {
                    onPickResult(null, file.absolutePath, "image", "photo.jpg", "image/jpeg")
                } else {
                    onError(IllegalStateException("camera returned no output file"))
                }
            }
            REQ_IMAGE, REQ_FILE, REQ_VIDEO -> {
                val uri = data?.data
                if (uri != null) {
                    onPickResult(uri, null, null, null, null)
                } else {
                    onCancelled()
                }
            }
            else -> onCancelled()
        }
    }

    private fun onPickResult(uri: Uri?, path: String?, kind: String?, name: String?, mime: String?) {
        val refId = currentRefId ?: return
        val metaPath = currentMetaPath ?: return
        try {
            if (path != null) {
                val output = File(path)
                currentOutputFile = output
                writeMeta(metaPath, refId, kind!!, name!!, mime!!, output.length(), output.absolutePath)
            } else if (uri != null) {
                val info = queryInfo(uri)
                val dest = File(File(activity.filesDir, OUTBOX_DIR), "$refId.${extensionFor(info.second)}")
                currentOutputFile = dest
                val input = activity.contentResolver.openInputStream(uri)
                    ?: throw IllegalStateException("picker returned unreadable URI")
                input.use { source ->
                    dest.outputStream().use { destination -> source.copyTo(destination) }
                }
                val resolvedKind = if (info.second.startsWith("image/")) "image" else "file"
                writeMeta(metaPath, refId, resolvedKind, info.first, info.second, dest.length(), dest.absolutePath)
            } else {
                onCancelled()
            }
        } catch (e: Exception) {
            onError(e)
        } finally {
            clearRequest()
        }
    }

    private fun onCancelled() {
        val metaPath = currentMetaPath
        cleanupPartialOutput()
        if (metaPath != null) {
            runCatching { writeMetaAtomically(metaPath, JSONObject().put("status", "cancelled")) }
        }
        clearRequest()
    }

    private fun onError(error: Exception) {
        val metaPath = currentMetaPath
        cleanupPartialOutput()
        if (metaPath != null) {
            runCatching {
                writeMetaAtomically(
                    metaPath,
                    JSONObject().put("status", "error").put("message", error.message ?: "unknown")
                )
            }
        }
        clearRequest()
    }

    private fun writeMeta(path: String, refId: String, kind: String, name: String, mime: String, size: Long, localPath: String) {
        val json = JSONObject()
            .put("status", "done")
            .put("refId", refId)
            .put("kind", kind)
            .put("fileName", name)
            .put("mime", mime)
            .put("sizeBytes", size)
            .put("localUri", localPath)
        writeMetaAtomically(path, json)
    }

    private fun writeMetaAtomically(path: String, json: JSONObject) {
        val atomic = AtomicFile(File(path))
        val stream: FileOutputStream = atomic.startWrite()
        try {
            stream.write(json.toString().toByteArray(Charsets.UTF_8))
            stream.fd.sync()
            atomic.finishWrite(stream)
        } catch (e: Exception) {
            atomic.failWrite(stream)
            throw e
        }
    }

    private fun queryInfo(uri: Uri): Triple<String, String, Long> {
        var name = "capture"
        var mime = activity.contentResolver.getType(uri) ?: "application/octet-stream"
        var size = 0L
        activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
            }
        }
        return Triple(name, mime, size)
    }

    private fun extensionFor(mime: String): String = when (mime) {
        "image/png" -> "png"
        "image/jpeg", "image/jpg" -> "jpg"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        "application/pdf" -> "pdf"
        "text/plain" -> "txt"
        else -> "bin"
    }

    private fun persistCurrentRequest() {
        val refId = currentRefId ?: return
        val metaPath = currentMetaPath ?: return
        activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
            .edit()
            .putString(PREF_REF, refId)
            .putString(PREF_META, metaPath)
            .putString(PREF_OUTPUT, currentOutputFile?.absolutePath)
            .apply()
    }

    private fun restorePendingRequest(): Boolean {
        val prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
        val refId = prefs.getString(PREF_REF, null) ?: return false
        val metaPath = prefs.getString(PREF_META, null) ?: return false
        currentRefId = refId
        currentMetaPath = metaPath
        currentOutputFile = prefs.getString(PREF_OUTPUT, null)?.let(::File)
        photoFile = currentOutputFile
        return true
    }

    private fun forgetPersistedRequest() {
        val prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
        // Do not delete paths remembered by a process that died: its Rust side
        // may already have committed the attachment to SQLite just before this
        // Java finally-block ran. Startup reconciliation has the database
        // allow-list needed to distinguish a durable attachment from a true
        // picker orphan; this bridge only forgets the stale in-memory request.
        prefs.edit().clear().apply()
    }

    private fun discardRecoveredResult() {
        cleanupPartialOutput()
        currentMetaPath?.let { runCatching { File(it).delete() } }
        clearRequest()
    }

    private fun cleanupPartialOutput() {
        currentOutputFile?.let { file ->
            if (file.parentFile?.canonicalPath == outboxDir()) {
                runCatching { file.delete() }
            }
        }
    }

    private fun clearRequest() {
        currentRefId = null
        currentMetaPath = null
        photoFile = null
        currentOutputFile = null
        activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE).edit().clear().apply()
    }
}
