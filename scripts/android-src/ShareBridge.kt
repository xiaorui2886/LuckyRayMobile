package com.luckyray.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.AtomicFile
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * Android system Share Target (M2.7): receives ACTION_SEND — text/URL, one
 * image, one general file — and stages it into the app-private Local Inbox
 * directory (`local-inbox/`, `att-*` files) while the temporary content URI
 * grant is still valid. The staged content is described by a
 * `share-<nonce>.meta.json` that Rust reconciles into the Local Inbox
 * idempotently; Rust never depends on the external temporary URI afterwards.
 *
 * Duplicate delivery protection lives here (a 60s digest window covers
 * Activity recreation and duplicate Intent delivery) AND in the Rust ingest
 * (a 1h share-log dedup window covers a crash between DB commit and meta
 * removal). The phone's Local Inbox is user-owned durable data, not a Desktop
 * cache: these files live under a separate `att-*` namespace from the Desktop
 * capture-outbox (`ref-*`).
 */
object ShareBridge {
    private const val INBOX_DIR = "local-inbox"
    private const val PREFS = "luckyray_share_bridge"
    private const val PREF_DIGEST = "last_digest"
    private const val PREF_AT = "last_at"
    private const val DEDUP_WINDOW_MS = 60_000L

    private lateinit var activity: Activity

    init { nativeInit() }
    private external fun nativeInit()

    /** Notifies the Rust side that a share was persisted (warm-resume path). */
    private external fun nativeNotify()

    fun notifyNoteImport() { nativeNotify() }
    @JvmStatic fun noteImportDir(): String = NoteImportBridge.directory()
    @JvmStatic fun launchNoteImport(): String = NoteImportBridge.launch()

    @JvmStatic
    fun init(act: Activity) {
        activity = act
    }

    /**
     * P1-A: API-29-safe EXTRA_STREAM extraction. The typed overload
     * `getParcelableExtra(name, Uri::class.java)` only exists on API 33+ and
     * throws NoSuchMethodError on API 29 if called unguarded, so the generic
     * overload must be used below API 33. Single compatibility point for both
     * MainActivity (grant pre-check) and handle().
     */
    @JvmStatic
    fun streamUriOf(intent: Intent?): Uri? {
        if (intent == null) return null
        return if (android.os.Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
    }

    @JvmStatic
    fun localInboxDir(): String {
        return File(activity.filesDir, INBOX_DIR).apply { mkdirs() }.canonicalPath
    }

    /**
     * App-private Local Asset root (M2.9 material library). Deliberately a
     * separate storage domain from the Local Inbox (`local-inbox/`, att-*) and
     * the Desktop capture outbox (`capture-outbox/`, ref-*): managed originals
     * live under `local-assets/originals/asset-*`, staging under
     * `local-assets/staging/`, and derived thumbnails under `local-assets/thumbs/`.
     */
    @JvmStatic
    fun localAssetsDir(): String {
        return File(activity.filesDir, "local-assets").apply { mkdirs() }.canonicalPath
    }

    /**
     * App-scoped external files dir for diagnostics export. getExternalFilesDir
     * is the system-sanctioned way to obtain (and create) this directory, which
     * adb can pull without root on Android 10+.
     */
    @JvmStatic
    fun diagnosticsDir(): String {
        val external = activity.getExternalFilesDir(null)
        return (external ?: File(activity.filesDir, "diagnostics")).absolutePath
    }

    /**
     * Handle one ACTION_SEND intent. Returns immediately; the share meta file
     * is what the Rust side consumes. Malformed shares never crash the app —
     * they simply produce no meta and nothing is ingested.
     */
    @JvmStatic
    fun handle(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()
        val streamUri = streamUriOf(intent)
        val clipUri = intent.clipData?.getItemAt(0)?.uri
        // Some apps deliver the URI only through ClipData; prefer the explicit
        // EXTRA_STREAM when both exist (single-file first version).
        val uri: Uri? = streamUri ?: clipUri

        if ((text == null || text.isEmpty()) && uri == null) return

        val nonce = "sh-" + System.currentTimeMillis().toString(16) + "-" + (0..0xffff).random().toString(16)
        val inbox = File(activity.filesDir, INBOX_DIR).apply { mkdirs() }
        val metaPath = File(inbox, "share-$nonce.meta.json")

        try {
            // Routing rule: the stream is the primary shared object. When an
            // ACTION_SEND carries BOTH EXTRA_STREAM and EXTRA_TEXT/caption,
            // the file/image wins; text-only shares take the text/link path.
            if (uri != null) {
                // FIX-V2 #2: verify the per-URI read grant BEFORE any provider
                // access (getType/query/openInputStream). A receiver without a
                // grant must fail bounded here — never via a provider
                // SecurityException after touching the URI.
                val granted = try {
                    activity.checkUriPermission(
                        uri, android.os.Process.myPid(), android.os.Process.myUid(),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                } catch (t2: Exception) {
                    false
                }
                if (!granted) {
                    Log.e(
                        "ShareBridge",
                        "ingest skipped: no read grant authority=${uri.authority} mime=${intent?.type ?: "?"} flags=${intent?.flags ?: 0}"
                    )
                    runCatching { File(metaPath.absolutePath).delete() }
                    return
                }
                stageFileShare(uri, nonce, inbox, metaPath)
            } else if (text != null && text.isNotEmpty()) {
                stageTextShare(text, nonce, metaPath)
            } else {
                return
            }
        } catch (e: Exception) {
            // Bounded failure: no meta is written, so nothing is ingested and
            // the app stays alive (e.g. unreadable stream / bad MIME).
            // P1-B diagnostic (P2-A redacted): authority/MIME/grant flags/
            // checkUriPermission result + exception class only — never the
            // full URI, file name, path, or hash.
            val auth = uri?.authority ?: "?"
            val flags = intent?.flags ?: 0
            val check = uri?.let {
                try {
                    activity.checkUriPermission(
                        it, android.os.Process.myPid(), android.os.Process.myUid(),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (t2: Exception) {
                    -999
                }
            } ?: -1
            Log.e(
                "ShareBridge",
                "ingest failed: op=${if (uri != null) "file" else "text"} " +
                    "class=${e.javaClass.simpleName} authority=$auth mime=${intent?.type ?: "?"} " +
                    "intentFlags=$flags checkUriRead=$check"
            )
            runCatching { File(metaPath.absolutePath).delete() }
        }
    }

    private fun stageFileShare(uri: Uri, nonce: String, inbox: File, metaPath: File) {
        val (name, mime, _) = queryInfo(uri)
        val dest = File(inbox, "att-$nonce.${extensionFor(mime, name)}")
        val digest = activity.contentResolver.openInputStream(uri)
            ?.use { source ->
                val md = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(64 * 1024)
                dest.outputStream().use { out ->
                    while (true) {
                        val n = source.read(buffer)
                        if (n <= 0) break
                        md.update(buffer, 0, n)
                        out.write(buffer, 0, n)
                    }
                }
                md.digest().toHex()
            }
            ?: throw IllegalStateException("share stream unreadable")
        if (!dedup(digest)) {
            runCatching { dest.delete() } // duplicate delivery — no orphan lingers
            Log.i("ShareBridge", "deduped file share: " + digest.take(12))
            return
        }
        val json = JSONObject()
            .put("status", "done")
            .put("shareId", nonce)
            .put("shareType", "file")
            .put("digest", digest)
            .put("fileName", name)
            .put("mime", mime)
            .put("sizeBytes", dest.length())
            .put("sha256", digest)
            .put("localUri", dest.absolutePath)
        writeMetaAtomically(metaPath, json)
        Log.i("ShareBridge", "staged file share -> " + dest.absolutePath)
        nativeNotify()
    }

    private fun stageTextShare(text: String, nonce: String, metaPath: File) {
        val digest = sha256Hex(text.toByteArray(Charsets.UTF_8))
        if (!dedup(digest)) return
        // A single URL becomes a link item; selected text stays text.
        val url = if (text.startsWith("http://") || text.startsWith("https://")) text else ""
        val json = JSONObject()
            .put("status", "done")
            .put("shareId", nonce)
            .put("shareType", "text")
            .put("digest", digest)
            .put("text", text)
            .put("url", url)
        writeMetaAtomically(metaPath, json)
        nativeNotify()
    }

    private fun dedup(digest: String): Boolean {
        val prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val same = digest == prefs.getString(PREF_DIGEST, null)
        val fresh = now - prefs.getLong(PREF_AT, 0L) < DEDUP_WINDOW_MS
        if (same && fresh) return false
        prefs.edit().putString(PREF_DIGEST, digest).putLong(PREF_AT, now).apply()
        return true
    }

    private fun writeMetaAtomically(path: File, json: JSONObject) {
        val atomic = AtomicFile(path)
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
        var name = "share"
        var mime = activity.contentResolver.getType(uri) ?: "application/octet-stream"
        var size = 0L
        // P1-B: narrow projection only — never projection=null (some
        // providers refuse it and it widens the query surface).
        activity.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
            }
        }
        return Triple(name, mime, size)
    }

    private fun extensionFor(mime: String, fileName: String = ""): String {
        val fromName = fileName.substringAfterLast('.', "").lowercase()
        if (fromName.isNotEmpty() && fromName.length <= 10 && fromName.all { it.isLetterOrDigit() }) {
            return fromName
        }
        return when (mime) {
            "image/png" -> "png"
            "image/jpeg", "image/jpg" -> "jpg"
            "image/webp" -> "webp"
            "image/gif" -> "gif"
            "application/pdf" -> "pdf"
            "text/plain" -> "txt"
            else -> "bin"
        }
    }

    private fun sha256Hex(bytes: ByteArray): String {
        return MessageDigest.getInstance("SHA-256").digest(bytes).toHex()
    }

    private fun ByteArray.toHex(): String {
        return joinToString("") { "%02x".format(it) }
    }
}
