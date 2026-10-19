package com.luckyray.mobile

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.security.MessageDigest

/**
 * Mobile Companion Storage & Export (M2.11 + FIX-V1) — one small explicit
 * native boundary for:
 *
 *  - export: copy a Mobile-owned file (Local Asset original under
 *    `local-assets/originals/asset-*`, or Local Inbox attachment under
 *    `local-inbox/att-*`) into the SYSTEM ecosystem via scoped storage /
 *    MediaStore — Pictures/LuckyRay (images), Movies/LuckyRay (video),
 *    Download/LuckyRay (documents/general files). Scoped storage semantics:
 *    IS_PENDING=1 → bounded streaming copy → size + STREAMED SHA-256
 *    verification → IS_PENDING=0; any failure removes the incomplete pending
 *    row (rollback). The LuckyRay source is never deleted or moved by export.
 *
 *  - dedupe: the same unchanged source exported twice resolves to
 *    `already_exists` — MediaStore candidate query scoped to the LuckyRay
 *    destination (display name + size + RELATIVE_PATH, hard-capped) plus
 *    bounded streaming SHA-256 verification against the source hash. A
 *    target deleted externally simply disappears from the query (dead rows
 *    are purged), so a later export creates a fresh copy. Same display name
 *    with different bytes never overwrites — a safe unique name is generated
 *    instead.
 *
 *  - share: ACTION_SEND chooser with a `content://` URI granted through the
 *    DEDICATED narrow provider `${applicationId}.exportprovider`, whose
 *    export_file_paths.xml exposes ONLY `local-assets/originals/` and
 *    `local-inbox/`. Temporary FLAG_GRANT_READ_URI_PERMISSION only; no raw
 *    file:// URIs; no persistable grants to recipients.
 *
 *  - storage transparency + cache hygiene: bounded byte/count stats for the
 *    user-owned roots vs the disposable derived thumbnail roots, and a
 *    `clearCache()` that deletes ONLY the two known disposable roots
 *    (`local-assets/thumbs/` and `cacheDir/thumb-*.img`) — never originals,
 *    inbox attachments, capture outbox, notes, SQLite or Keystore. Freed
 *    bytes are counted ONLY for files whose delete actually succeeded.
 *
 * FIX-V1 lifecycle (P1-3): the singleton keeps the APPLICATION context for
 * ContentResolver/filesDir/FileProvider/storage work and only a
 * WeakReference<Activity> for chooser launches; the chooser is started on
 * the Android UI thread; no strong static Activity reference is retained.
 *
 * FIX-V1 serialization (P1-2): the whole export critical section
 * (dedupe → insert → copy → verify → publish) is `@Synchronized`
 * process-wide, so near-concurrent duplicate attempts cannot create two
 * physical copies; publication verifies the streamed SHA-256 of the written
 * MediaStore item against the expected source hash BEFORE clearing
 * IS_PENDING, and rolls back the pending row on any mismatch.
 *
 * No MANAGE_EXTERNAL_STORAGE / all-files access, no legacy
 * WRITE_EXTERNAL_STORAGE, no GMS. Errors returned to the renderer are
 * bounded generic codes/messages — never raw Throwable text or private
 * filesystem paths.
 */
object ExportBridge {
    private const val EXPORT_DIR = "LuckyRay"
    private const val HASH_BUFFER = 64 * 1024
    private const val MAX_UNIQUE_ATTEMPTS = 1000
    /** FIX-V1 P2-1: hard cap on plausible dedupe/name-collision candidates. */
    private const val MAX_CANDIDATES = 32

    // FIX-V1 P1-3: application context for all ContentResolver/filesDir/
    // FileProvider/storage work; only a weak current-activity holder for
    // chooser launches. No strong static Activity reference.
    private lateinit var appContext: Context
    private var activityRef = WeakReference<Activity>(null)

    init { nativeInit() }
    private external fun nativeInit()

    @JvmStatic
    fun init(act: Activity) {
        appContext = act.applicationContext
        activityRef = WeakReference(act)
    }

    // ------------------------------------------------------------------
    // Roots (exact ownership roots, no traversal beyond them)
    // ------------------------------------------------------------------
    // M2.13-B2: these roots must EXIST for ownerRoots()/export validation —
    // Kotlin canonicalPath does not check existence, and a missing root made
    // the Rust-side canonicalize fail ("owner root not accessible") on any
    // device that never imported a Local Asset. mkdirs() is idempotent and
    // matches ShareBridge.localInboxDir().
    private fun assetOriginalsFile(): File =
        File(appContext.filesDir, "local-assets/originals").apply { mkdirs() }
    private fun inboxFile(): File =
        File(appContext.filesDir, "local-inbox").apply { mkdirs() }
    private fun assetThumbsFile(): File = File(appContext.filesDir, "local-assets/thumbs")
    private fun outboxFile(): File = File(appContext.filesDir, "capture-outbox")

    /** FIX-V1 P1-1: exact canonical owner roots for the Rust source
     *  boundary — the SAME platform authority that creates the roots. */
    @JvmStatic
    fun ownerRoots(): String {
        return JSONArray()
            .put(assetOriginalsFile().canonicalPath)
            .put(inboxFile().canonicalPath)
            .toString()
    }

    // ==================================================================
    // EXPORT (Scope A + B; FIX-V1 P1-2 serialized + verified)
    // ==================================================================
    @JvmStatic
    @Synchronized
    fun exportFile(sourcePath: String, displayName: String, mime: String, collection: String, sourceSha256: String): String {
        return try {
            doExport(sourcePath, displayName, mime, collection, sourceSha256)
        } catch (t: Throwable) {
            errorJson(t)
        }
    }

    private fun doExport(
        sourcePath: String,
        displayName: String,
        mime: String,
        collection: String,
        sourceSha256: String
    ): String {
        val src = File(sourcePath)
        if (!src.isFile) {
            Log.e("ExportBridge", "early: source missing: $sourcePath")
            return errorJson("source missing")
        }
        val collectionUri = when (collection) {
            "Pictures" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            "Movies" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            "Downloads" -> MediaStore.Downloads.EXTERNAL_CONTENT_URI
            else -> return errorJson("unknown collection")
        }
        val relPath = when (collection) {
            "Pictures" -> "Pictures/$EXPORT_DIR/"
            "Movies" -> "Movies/$EXPORT_DIR/"
            else -> "Download/$EXPORT_DIR/" // API 29 downloads RELATIVE_PATH prefix
        }
        val safeName = sanitizeName(displayName)
        val resolver = appContext.contentResolver

        // --- dedupe: exact name + size + destination candidates, verified by
        //     bounded streaming hash (FIX-V1 P2-1: LuckyRay path only, capped) ---
        var matchName: String? = null
        var matchUri: Uri? = null
        queryCandidates(collectionUri, safeName, src.length(), relPath) { name, uri ->
            if (streamSha256(uri) == sourceSha256) {
                matchName = name
                matchUri = uri
                true // stop searching — an unchanged source already exists
            } else {
                false
            }
        }
        if (matchUri != null) {
            return JSONObject()
                .put("status", "already_exists")
                .put("destination", destinationLabel(collection))
                .put("displayName", matchName ?: safeName)
                .put("uri", matchUri.toString())
                .put("bytes", src.length())
                .toString()
        }

        // --- same display name with different bytes → safe unique name ---
        // First purge dead MediaStore rows for this name in OUR destination
        // folder: a row whose file was deleted externally still owns the
        // files._data path (UNIQUE constraint) and would block a fresh insert
        // with the plain name.
        purgeStaleRows(collectionUri, safeName, relPath)
        val finalName = uniqueName(collectionUri, safeName, relPath)

        // --- crash-safe pending write: IS_PENDING=1 → stream → verify → 0 ---
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, finalName)
            put(MediaStore.MediaColumns.MIME_TYPE, mime.ifEmpty { "application/octet-stream" })
            put(MediaStore.MediaColumns.RELATIVE_PATH, relPath)
            put(MediaStore.MediaColumns.SIZE, src.length())
            if (Build.VERSION.SDK_INT >= 29) {
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
        }
        val uri = resolver.insert(collectionUri, values)
            ?: run {
                Log.e("ExportBridge", "early: insert failed (name=$finalName, coll=$collection)")
                return errorJson("insert failed")
            }
        try {
            val out = resolver.openOutputStream(uri) ?: throw RuntimeException("open output stream failed")
            out.use { o ->
                src.inputStream().use { inp ->
                    val buf = ByteArray(HASH_BUFFER)
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                    }
                }
            }
            val written = querySize(uri)
            if (written >= 0 && written != src.length()) {
                throw RuntimeException("size mismatch after export")
            }
            // FIX-V1 P1-2B: content-integrity boundary — the published item
            // must hash to the expected source SHA-256 (catches a source
            // TOCTOU/change during the copy) BEFORE IS_PENDING is cleared.
            val writtenHash = streamSha256(uri)
            if (writtenHash == null || writtenHash != sourceSha256) {
                throw RuntimeException("content verification failed")
            }
            if (Build.VERSION.SDK_INT >= 29) {
                resolver.update(
                    uri,
                    ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
                    null,
                    null
                )
            }
            return JSONObject()
                .put("status", "created")
                .put("destination", destinationLabel(collection))
                .put("displayName", finalName)
                .put("uri", uri.toString())
                .put("bytes", src.length())
                .toString()
        } catch (t: Throwable) {
            // M2.13 debug: device-local diagnostic only — the renderer still
            // gets the bounded generic errorJson (no paths/URIs forwarded).
            Log.e("ExportBridge", "doExport failed: " + t.javaClass.simpleName + " | " + t.message, t)
            // rollback: the pending row must not linger as a broken system item
            runCatching { resolver.delete(uri, null, null) }
            throw t
        }
    }

    /** Bounded MediaStore query: rows with this exact display name (+ size
     * when `size >= 0`) inside the intended LuckyRay RELATIVE_PATH, excluding
     * in-flight pending rows. Hard-capped at MAX_CANDIDATES rows (FIX-V1
     * P2-1). The callback returns true to stop iterating (early exit). */
    private fun queryCandidates(
        collectionUri: Uri,
        name: String,
        size: Long,
        relPath: String,
        onRow: (displayName: String, uri: Uri) -> Boolean
    ) {
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME
        )
        val selection = StringBuilder()
            .append(MediaStore.MediaColumns.DISPLAY_NAME).append(" = ? AND ")
            .append(MediaStore.MediaColumns.RELATIVE_PATH).append(" = ?")
        val args = mutableListOf(name, relPath)
        if (size >= 0) {
            selection.append(" AND ").append(MediaStore.MediaColumns.SIZE).append(" = ?")
            args.add(size.toString())
        }
        if (Build.VERSION.SDK_INT >= 29) {
            selection.append(" AND (")
                .append(MediaStore.MediaColumns.IS_PENDING).append(" = 0 OR ")
                .append(MediaStore.MediaColumns.IS_PENDING).append(" IS NULL)")
        }
        val cursor: Cursor? = runCatching {
            appContext.contentResolver.query(collectionUri, projection, selection.toString(), args.toTypedArray(), null)
        }.getOrNull()
        cursor?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            var seen = 0
            while (c.moveToNext() && seen < MAX_CANDIDATES) {
                val id = c.getLong(idCol)
                val display = c.getString(nameCol) ?: name
                seen += 1
                if (onRow(display, Uri.withAppendedPath(collectionUri, id.toString()))) break
            }
        }
    }

    /**
     * Remove MediaStore rows in `relPath` with this display name whose backing
     * file no longer exists (externally deleted). A dead row keeps the
     * `files._data` UNIQUE slot, so without this a fresh export after an
     * external delete fails with SQLITE_CONSTRAINT_UNIQUE. Only rows in OUR
     * destination folder are touched; rows with live files are kept.
     */
    private fun purgeStaleRows(collectionUri: Uri, name: String, relPath: String) {
        val projection = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.RELATIVE_PATH)
        val selection = MediaStore.MediaColumns.DISPLAY_NAME + " = ? AND " +
            MediaStore.MediaColumns.RELATIVE_PATH + " = ?"
        val args = arrayOf(name, relPath)
        val cursor: Cursor? = runCatching {
            appContext.contentResolver.query(collectionUri, projection, selection, args, null)
        }.getOrNull()
        val stale = mutableListOf<Uri>()
        cursor?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            var seen = 0
            while (c.moveToNext() && seen < MAX_CANDIDATES) {
                seen += 1
                stale.add(Uri.withAppendedPath(collectionUri, c.getLong(idCol).toString()))
            }
        }
        for (uri in stale) {
            val readable = runCatching {
                appContext.contentResolver.openInputStream(uri)?.use { true } ?: false
            }.getOrDefault(false)
            if (!readable) {
                runCatching { appContext.contentResolver.delete(uri, null, null) }
            }
        }
    }

    private fun uniqueName(collectionUri: Uri, base: String, relPath: String): String {
        val dot = base.lastIndexOf('.')
        val stem = if (dot > 0) base.substring(0, dot) else base
        val ext = if (dot > 0) base.substring(dot) else ""
        if (!displayNameExists(collectionUri, base, relPath)) return base
        for (i in 1..MAX_UNIQUE_ATTEMPTS) {
            val candidate = "$stem ($i)$ext"
            if (!displayNameExists(collectionUri, candidate, relPath)) return candidate
        }
        return "$stem-${System.currentTimeMillis()}$ext"
    }

    private fun displayNameExists(collectionUri: Uri, name: String, relPath: String): Boolean {
        var exists = false
        queryCandidates(collectionUri, name, -1L, relPath) { _, uri ->
            // A MediaStore row whose file was deleted externally is NOT a live
            // name owner: only rows whose content is actually readable count,
            // so a fresh export after an external delete reuses the plain name.
            val readable = runCatching {
                appContext.contentResolver.openInputStream(uri)?.use { true } ?: false
            }.getOrDefault(false)
            if (readable) {
                exists = true
                true
            } else {
                false
            }
        }
        return exists
    }

    private fun querySize(uri: Uri): Long {
        return runCatching {
            val cursor = appContext.contentResolver.query(
                uri,
                arrayOf(MediaStore.MediaColumns.SIZE),
                null,
                null,
                null
            )
            cursor?.use { c -> if (c.moveToFirst()) c.getLong(0) else -1L } ?: -1L
        }.getOrDefault(-1L)
    }

    private fun streamSha256(uri: Uri): String? {
        return runCatching {
            val input = appContext.contentResolver.openInputStream(uri) ?: return null
            input.use { inp ->
                val digest = MessageDigest.getInstance("SHA-256")
                val buf = ByteArray(HASH_BUFFER)
                while (true) {
                    val n = inp.read(buf)
                    if (n < 0) break
                    digest.update(buf, 0, n)
                }
                digest.digest().joinToString("") { "%02x".format(it) }
            }
        }.getOrNull()
    }

    /** Defense-in-depth sanitization (the Rust boundary is authoritative and
     *  always sanitizes first; this mirrors the same rules). */
    private fun sanitizeName(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/\\u0000-\\u001f\\u007f]"), "_").trim().trimStart('.')
        return cleaned.ifEmpty { "export" }
    }

    private fun destinationLabel(collection: String): String = when (collection) {
        "Pictures" -> "相册"
        "Movies" -> "视频"
        else -> "Downloads"
    }

    // ==================================================================
    // SHARE (Scope C; FIX-V1 P1-3 UI-thread-safe chooser; FIX-V2 grant)
    // ==================================================================
    @JvmStatic
    fun shareFile(sourcePath: String, displayName: String, mime: String): String {
        return try {
            // FIX-V2: back to the non-exported dedicated provider
            // (${applicationId}.exportprovider, exported=false +
            // grantUriPermissions=true, export_file_paths.xml exposes ONLY
            // local-assets/originals/ and local-inbox/). The read grant is
            // carried BOTH on EXTRA_STREAM and on ClipData (system share
            // sheets route grants through the clip); no raw file://.
            val src = File(sourcePath)
            if (!src.isFile) return errorJson("source missing")
            val uri = FileProvider.getUriForFile(appContext, appContext.packageName + ".exportprovider", src)
            val type = mime.ifEmpty { "application/octet-stream" }
            val name = sanitizeName(displayName)
            val intent = Intent(Intent.ACTION_SEND).apply {
                this.type = type
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TITLE, name)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = ClipData.newRawUri(name, uri)
            }
            if (!launchChooser(intent)) return errorJson("no activity available")
            JSONObject().put("status", "ok").toString()
        } catch (t: Throwable) {
            errorJson(t)
        }
    }

    @JvmStatic
    fun shareText(text: String): String {
        return try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            if (!launchChooser(intent)) return errorJson("no activity available")
            JSONObject().put("status", "ok").toString()
        } catch (t: Throwable) {
            errorJson(t)
        }
    }

    /** M2.13 FIX-V1 P1-D + FIX-V2: external open of an app-private file (Local
     *  Inbox attachment or Local Asset original) through the non-exported
     *  dedicated provider (`${applicationId}.exportprovider`, exported=false +
     *  grantUriPermissions=true). ACTION_VIEW with the URI on Intent data and
     *  a temporary read grant — never a raw file:// URI.
     *
     *  Truthful success: `status=ok` is returned ONLY when startActivity
     *  actually succeeds. ActivityNotFoundException / SecurityException / any
     *  launch failure returns a bounded error. The launch runs on the Android
     *  UI thread; when this thread already IS the UI thread (JNI can call in
     *  on the main thread) it runs directly — otherwise a bounded latch waits
     *  for the UI-thread outcome (5 s timeout -> bounded error, never a
     *  deadlock and never a false ok). */
    @JvmStatic
    fun openFile(sourcePath: String, mime: String): String {
        return try {
            val src = File(sourcePath)
            if (!src.isFile) return errorJson("source missing")
            val uri = FileProvider.getUriForFile(appContext, appContext.packageName + ".exportprovider", src)
            val type = mime.ifEmpty { "application/octet-stream" }
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, type)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                // FIX-V2 #1: the read grant must also ride on ClipData — on
                // API 35 the system routes per-URI grants through the clip.
                clipData = ClipData.newRawUri(uri.lastPathSegment, uri)
            }
            val act = activityRef.get() ?: return errorJson("no activity available")
            val mainLooper = android.os.Looper.getMainLooper()
            if (android.os.Looper.myLooper() == mainLooper) {
                // Already on the UI thread: launch directly (no latch).
                return try {
                    act.startActivity(intent)
                    JSONObject().put("status", "ok").toString()
                } catch (t: Throwable) {
                    Log.e("ExportBridge", "open failed: class=${t.javaClass.simpleName}")
                    errorJson("launch failed")
                }
            }
            val latch = java.util.concurrent.CountDownLatch(1)
            // Visible to the waiting thread via the latch's happens-before.
            var outcome: String? = null
            act.runOnUiThread {
                try {
                    act.startActivity(intent)
                    outcome = JSONObject().put("status", "ok").toString()
                } catch (t: Throwable) {
                    Log.e("ExportBridge", "open failed: class=${t.javaClass.simpleName}")
                    outcome = errorJson("launch failed")
                } finally {
                    latch.countDown()
                }
            }
            if (!latch.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
                return errorJson("launch timed out")
            }
            outcome ?: errorJson("launch failed")
        } catch (t: Throwable) {
            errorJson(t)
        }
    }

    /** Launch the chooser on the Android UI thread via the current activity
     *  (weak reference only). Returns false when no live Activity exists —
     *  a stale Activity is never dereferenced. */
    private fun launchChooser(intent: Intent): Boolean {
        val act = activityRef.get() ?: return false
        act.runOnUiThread {
            runCatching { act.startActivity(Intent.createChooser(intent, "分享到")) }
        }
        return true
    }

    // ==================================================================
    // STORAGE TRANSPARENCY + CACHE HYGIENE (Scope F; FIX-V1 P2-2)
    // ==================================================================
    @JvmStatic
    fun storageStats(): String {
        return try {
            val inbox = dirStats(inboxFile()) { it.startsWith("att-") }
            val assets = dirStats(assetOriginalsFile()) { it.startsWith("asset-") }
            val thumbsLocal = dirStats(assetThumbsFile()) { true }
            var thumbCount = thumbsLocal.count
            var thumbBytes = thumbsLocal.bytes
            appContext.cacheDir.listFiles()?.forEach { f ->
                if (f.isFile && f.name.startsWith("thumb-") && f.name.endsWith(".img")) {
                    thumbCount += 1
                    thumbBytes += f.length()
                }
            }
            val outbox = dirStats(outboxFile()) { it.startsWith("ref-") }
            JSONObject()
                .put("inbox", JSONObject().put("count", inbox.count).put("bytes", inbox.bytes))
                .put("assetOriginals", JSONObject().put("count", assets.count).put("bytes", assets.bytes))
                .put("thumbs", JSONObject().put("count", thumbCount).put("bytes", thumbBytes))
                .put("outbox", JSONObject().put("count", outbox.count).put("bytes", outbox.bytes))
                .toString()
        } catch (t: Throwable) {
            errorJson(t)
        }
    }

    private class DirStats(val count: Int, val bytes: Long)

    private fun dirStats(dir: File, filter: (String) -> Boolean): DirStats {
        var count = 0
        var bytes = 0L
        dir.listFiles()?.forEach { f ->
            if (f.isFile && filter(f.name)) {
                count += 1
                bytes += f.length()
            }
        }
        return DirStats(count, bytes)
    }

    /**
     * Delete ONLY the known disposable derived cache roots:
     *  - `local-assets/thumbs/` (Local Asset previews);
     *  - `cacheDir/thumb-*.img` (Desktop-derived thumbnail cache).
     * Idempotent; never touches originals / inbox attachments / staging /
     * capture outbox / notes / SQLite / Keystore. FIX-V1 P2-2: bytes/count
     * are accumulated ONLY for files whose delete actually succeeded, so an
     * idempotent second clear reports 0/0.
     */
    @JvmStatic
    fun clearCache(): String {
        return try {
            var freed = 0L
            var removed = 0
            assetThumbsFile().listFiles()?.forEach { f ->
                if (f.isFile) {
                    val size = f.length()
                    if (f.delete()) {
                        freed += size
                        removed += 1
                    }
                }
            }
            appContext.cacheDir.listFiles()?.forEach { f ->
                if (f.isFile && f.name.startsWith("thumb-") && f.name.endsWith(".img")) {
                    val size = f.length()
                    if (f.delete()) {
                        freed += size
                        removed += 1
                    }
                }
            }
            JSONObject()
                .put("freedBytes", freed)
                .put("filesRemoved", removed)
                .toString()
        } catch (t: Throwable) {
            errorJson(t)
        }
    }

    // ------------------------------------------------------------------
    // Bounded, path-free error reporting (FIX-V1 P2-2): raw Throwable text
    // can contain absolute private filesystem paths and must never reach the
    // renderer. Expected failures use fixed safe codes; unexpected failures
    // collapse to a single generic message.
    // ------------------------------------------------------------------
    private fun errorJson(message: String): String =
        JSONObject().put("status", "error").put("message", message).toString()

    private fun errorJson(t: Throwable): String {
        // Never forward t.message — Android exceptions can embed absolute
        // private paths. Bounded generic categories only.
        val generic = when (t) {
            is SecurityException -> "export failed"
            is IllegalArgumentException -> "export failed"
            is java.io.IOException -> "export failed"
            else -> "export failed"
        }
        return errorJson(generic)
    }
}
