package com.luckyray.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.UUID

/** Scoped copies only. No filesystem resolver, persistable grant or storage permission. */
object NoteImportBridge {
    const val REQ_NOTE = 4317
    private const val LIMIT = 4 * 1024 * 1024
    private const val EXTRA_ID = "com.luckyray.mobile.NOTE_IMPORT_ID"
    private lateinit var activity: Activity
    @Volatile private var pickerActive = false
    private val worker = java.util.concurrent.ThreadPoolExecutor(1, 1, 30, java.util.concurrent.TimeUnit.SECONDS,
        java.util.concurrent.ArrayBlockingQueue<Runnable>(8))
    private fun queueFull(): Boolean = (root.listFiles()?.count { it.name.endsWith(".json") } ?: 0) >= 32
    private val prefs get() = activity.getSharedPreferences("note_import", Activity.MODE_PRIVATE)
    private val root get() = File(activity.filesDir, "note-import").apply { mkdirs() }
    fun init(act: Activity) { activity = act }
    @Synchronized fun directory(): String {
        // Recover interrupted AtomicFile commits before native queue scanning.
        root.listFiles()?.filter { it.name.endsWith(".json.bak") }?.forEach { backup ->
            runCatching { AtomicFile(File(root, backup.name.removeSuffix(".bak"))).openRead().close() }
        }
        root.listFiles()?.filter { it.name.endsWith(".json.new") }?.forEach { staged ->
            val base = File(root, staged.name.removeSuffix(".new"))
            if (!base.exists() && staged.length() <= LIMIT * 6L + 4096) runCatching {
                val json = JSONObject(staged.readText(Charsets.UTF_8))
                val id = json.getString("requestId")
                require(UUID.fromString(id).toString() == id && base.name == "$id.json")
                write(id, json)
            }
        }
        return root.canonicalPath
    }
    @Synchronized fun launch(): String {
        if (pickerActive || queueFull()) return "busy"
        // A prior process may have died while the picker was outside the app.
        // A fresh explicit launch closes that old request, never gets stuck.
        prefs.getString("picker", null)?.let { receipt(it, "picker", "cancelled", "") }
        pickerActive = true
        val id = UUID.randomUUID().toString()
        prefs.edit().putString("picker", id).commit()
        activity.runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/plain", "text/markdown", "text/x-markdown", "application/octet-stream"))
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.startActivityForResult(intent, REQ_NOTE)
            } catch (_: Exception) {
                receipt(id, "picker", "error", "NOTE_IMPORT_PICKER_UNAVAILABLE")
                pickerActive = false
                prefs.edit().remove("picker").commit()
            }
        }
        return JSONObject().put("status", "launched").put("requestId", id).toString()
    }
    @Synchronized fun result(resultCode: Int, data: Intent?) {
        pickerActive = false
        val id = prefs.getString("picker", null) ?: return
        prefs.edit().remove("picker").commit()
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            receipt(id, "picker", "cancelled", "")
        } else stageAsync(uri, id, "picker")
    }
    fun handle(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        // Never intercept websites, file:// paths or other app schemes.
        if (uri.scheme != "content") return
        val supplied = intent.getStringExtra(EXTRA_ID)
        val valid = supplied?.takeIf { runCatching { UUID.fromString(it).toString() == it }.getOrDefault(false) }
        val id = valid ?: UUID.randomUUID().toString().also {
            intent.putExtra(EXTRA_ID, it)
        }
        stageAsync(uri, id, "view")
    }
    private fun stageAsync(uri: Uri, id: String, source: String) {
        if (queueFull()) { rejected(id, source); return }
        try { worker.execute { stage(uri, id, source) } }
        catch (_: java.util.concurrent.RejectedExecutionException) { rejected(id, source) }
    }
    private fun rejected(id: String, source: String) {
        if (source == "picker") receipt(id, source, "error", "NOTE_IMPORT_QUEUE_FULL")
        else busyNotice()
    }
    private fun busyNotice() {
        activity.runOnUiThread { android.widget.Toast.makeText(activity, "导入队列已满，请稍后重试", android.widget.Toast.LENGTH_SHORT).show() }
    }
    private fun rememberView(key: String, importId: String, at: Long) {
        val edit = prefs.edit()
        val keys = prefs.all.keys.filter { it.startsWith("view:") }
        if (keys.size >= 128) keys.take(keys.size - 127).forEach { edit.remove(it) }
        // Store only a hash of URI+content, never the provider URI itself.
        edit.putString("view:$key", JSONObject().put("id", importId).put("at", at).toString()).commit()
    }
    private fun repeatedViewId(key: String, fallback: String, now: Long): String {
        return runCatching {
            val previous = JSONObject(prefs.getString("view:$key", "") ?: "")
            val id = previous.getString("id")
            val age = now - previous.getLong("at")
            if (age >= 0L && age < 60_000L && id.length == 36 && UUID.fromString(id).toString() == id) id else fallback
        }.getOrDefault(fallback)
    }
    private fun stage(uri: Uri, id: String, source: String) {
        if (queueFull()) { rejected(id, source); return }
        val pendingId = prefs.getString("delivery:$id", id) ?: id
        if (File(root, "$pendingId.json").exists()) { ShareBridge.notifyNoteImport(); return }
        try {
            require(uri.scheme == "content") { "NOTE_IMPORT_URI_UNSUPPORTED" }
            val granted = activity.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(),
                Intent.FLAG_GRANT_READ_URI_PERMISSION) == android.content.pm.PackageManager.PERMISSION_GRANTED
            require(granted) { "NOTE_IMPORT_PERMISSION_DENIED" }
            var name = ""
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    if (si >= 0 && !c.isNull(si)) require(c.getLong(si) <= LIMIT) { "NOTE_IMPORT_TOO_LARGE" }
                }
            }
            require(name.length <= 512) { "NOTE_IMPORT_FILENAME_INVALID" }
            require(name.substringAfterLast('.', "").lowercase() in setOf("md", "markdown", "txt")) { "NOTE_IMPORT_EXTENSION_UNSUPPORTED" }
            val bytes = activity.contentResolver.openInputStream(uri)?.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                var emptyReads = 0
                val deadline = android.os.SystemClock.elapsedRealtime() + 30_000
                while (true) {
                    require(android.os.SystemClock.elapsedRealtime() <= deadline) { "NOTE_IMPORT_READ_TIMEOUT" }
                    val n = input.read(buffer)
                    if (n < 0) break
                    if (n == 0) { require(++emptyReads <= 8) { "NOTE_IMPORT_UNREADABLE" }; continue }
                    emptyReads = 0
                    require(out.size() + n <= LIMIT) { "NOTE_IMPORT_TOO_LARGE" }
                    out.write(buffer, 0, n)
                }
                out.toByteArray()
            } ?: throw IllegalArgumentException("NOTE_IMPORT_UNREADABLE")
            val offset = if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) 3 else 0
            val text = try { Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes, offset, bytes.size-offset)).toString()
            } catch (_: Exception) { throw IllegalArgumentException("NOTE_IMPORT_ENCODING_UNSUPPORTED") }
            require(text.none { (it.code < 32 && it !in "\t\n\r") || it.code == 127 }) { "NOTE_IMPORT_ENCODING_UNSUPPORTED" }
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            // Reopening is navigation, not a silent drop. URI+bytes identify
            // a duplicate delivery; identical text in two files stays distinct.
            val viewKey = MessageDigest.getInstance("SHA-256")
                .digest((uri.toString() + "\u0000" + digest).toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            val now = System.currentTimeMillis()
            val importId = if (source == "view") repeatedViewId(viewKey, id, now) else id
            // Delivery ID remains fresh, so acknowledging the previous receipt
            // cannot delete this new navigation request. Native INSERT OR IGNORE
            // uses importId and never overwrites the already edited local note.
            val deliveryId = if (source == "picker") id else UUID.randomUUID().toString()
            val json = JSONObject().put("requestId", deliveryId).put("importId", importId)
                .put("source", source).put("status", "ready")
                .put("fileName", name).put("content", text)
            write(deliveryId, json)
            val deliveries = prefs.all.keys.filter { it.startsWith("delivery:") }
            val edit = prefs.edit()
            if (deliveries.size >= 128) deliveries.take(deliveries.size - 127).forEach { edit.remove(it) }
            edit.putString("delivery:$id", deliveryId).commit()
            if (source == "view") rememberView(viewKey, importId, now)
            ShareBridge.notifyNoteImport()
        } catch (e: Exception) {
            val error = e.message?.takeIf { it.startsWith("NOTE_IMPORT_") } ?: "NOTE_IMPORT_UNREADABLE"
            receipt(id, source, "error", error)
        }
    }
    private fun receipt(id: String, source: String, status: String, error: String) {
        runCatching {
            write(id, JSONObject().put("requestId", id).put("source", source).put("status", status).put("error", error))
            ShareBridge.notifyNoteImport()
        }
    }
    @Synchronized private fun write(id: String, json: JSONObject) {
        require(id.length == 36 && UUID.fromString(id).toString() == id) { "NOTE_IMPORT_REQUEST_INVALID" }
        val atomic = AtomicFile(File(root, "$id.json"))
        val stream = atomic.startWrite()
        try {
            stream.write(json.toString().toByteArray(Charsets.UTF_8)); stream.fd.sync(); atomic.finishWrite(stream)
        } catch (e: Exception) { atomic.failWrite(stream); throw e }
    }
}
