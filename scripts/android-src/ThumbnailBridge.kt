package com.luckyray.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfRenderer
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.ParcelFileDescriptor
import android.text.StaticLayout
import android.text.TextPaint
import android.media.ExifInterface
import java.io.File
import java.io.FileOutputStream

/**
 * Bounded thumbnail generation for the Local Material Library.
 *
 * The material grid must never decode every full-resolution original at once.
 * `generate()` decodes with BitmapFactory bounds-first + inSampleSize (memory
 * stays bounded regardless of the original size), scales down to a 512px max
 * side, and writes a JPEG into the app-private derived thumbnail cache
 * (`local-assets/thumbs/`). PDF first pages, video frames, embedded audio covers
 * and bounded text excerpts use the same disposable cache. Thumbnails are never
 * user-owned originals; failure returns an error string and the UI falls back
 * to the icon/art treatment.
 */
object ThumbnailBridge {
    init { nativeInit() }
    private external fun nativeInit()

    @JvmStatic
    fun warm() {
        // no-op: touching the object runs `init { nativeInit() }`, caching the
        // JVM + class GlobalRef before any native-thread JNI call
    }

    @JvmStatic
    fun generate(srcPath: String, destPath: String, maxDimension: Int): String {
        var decoded: Bitmap? = null
        var scaled: Bitmap? = null
        var oriented: Bitmap? = null
        return try {
            val limit = maxDimension.coerceIn(512, 1280)
            // Actual file content only: a PDF page, media cover/frame, or a
            // bounded text excerpt. Unsupported files retain a format card.
            val filePreview = if (limit == 512) filePreview(srcPath, limit) else null
            if (filePreview != null) {
                decoded = filePreview
                File(destPath).parentFile?.mkdirs()
                FileOutputStream(destPath).use { fos ->
                    if (!filePreview.compress(Bitmap.CompressFormat.JPEG, 82, fos)) return "error:encode-failed"
                    fos.fd.sync()
                }
                return "ok"
            }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(srcPath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                return "error:unreadable-image"
            }
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= limit
                || bounds.outHeight / (sample * 2) >= limit
            ) {
                sample *= 2
            }
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            val bitmap = BitmapFactory.decodeFile(srcPath, opts)
                ?: return "error:decode-failed"
            decoded = bitmap
            val scale = minOf(1f, limit.toFloat() / maxOf(bitmap.width, bitmap.height))
            val out = if (scale < 1f) {
                Bitmap.createScaledBitmap(
                    bitmap,
                    (bitmap.width * scale).toInt().coerceAtLeast(1),
                    (bitmap.height * scale).toInt().coerceAtLeast(1),
                    true
                )
            } else {
                bitmap
            }
            scaled = out
            // Apply the original orientation after the bounded resize, without
            // retaining a second full-size bitmap. Screen PNG preserves alpha;
            // the existing 512px grid thumbnail stays JPEG.
            val orientation = try {
                ExifInterface(srcPath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
            val matrix = Matrix()
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            }
            val finalBitmap = if (matrix.isIdentity) out else Bitmap.createBitmap(out, 0, 0, out.width, out.height, matrix, true)
            oriented = finalBitmap
            File(destPath).parentFile?.mkdirs()
            FileOutputStream(destPath).use { fos ->
                val format = if (limit > 512) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
                if (!finalBitmap.compress(format, 82, fos)) return "error:encode-failed"
                fos.fd.sync()
            }
            "ok"
        } catch (_: OutOfMemoryError) {
            "error:decode-memory"
        } catch (e: Exception) {
            "error:${e.message ?: "unknown"}"
        } finally {
            if (oriented !== scaled && oriented !== decoded) oriented?.recycle()
            if (scaled !== decoded) scaled?.recycle()
            decoded?.recycle()
        }
    }
    private fun filePreview(path: String, limit: Int): Bitmap? {
        val extension = File(path).extension.lowercase()
        if (extension == "pdf") {
            ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                PdfRenderer(fd).use { pdf ->
                    if (pdf.pageCount == 0) return null
                    pdf.openPage(0).use { page ->
                        val scale = limit.toFloat() / maxOf(page.width, page.height)
                        val bitmap = Bitmap.createBitmap((page.width * scale).toInt().coerceAtLeast(1), (page.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                        bitmap.eraseColor(Color.WHITE)
                        try {
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            return bitmap
                        } catch (error: Exception) {
                            bitmap.recycle()
                            throw error
                        }
                    }
                }
            }
        }
        val video = extension in setOf("mp4", "webm", "mkv", "mov", "m4v", "3gp", "avi")
        val audio = extension in setOf("mp3", "m4a", "flac", "ogg", "wav", "aac", "opus")
        if (video || audio) {
            val reader = MediaMetadataRetriever()
            try {
                reader.setDataSource(path)
                val bitmap = if (audio) {
                    val bytes = reader.embeddedPicture ?: return null
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    var sample = 1
                    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > limit * 2) sample *= 2
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                } else if (Build.VERSION.SDK_INT >= 27) {
                    val encodedWidth = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: return null
                    val encodedHeight = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: return null
                    if (encodedWidth <= 0 || encodedHeight <= 0) return null
                    val rotation = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                    val width = if (rotation % 180 != 0) encodedHeight else encodedWidth
                    val height = if (rotation % 180 != 0) encodedWidth else encodedHeight
                    val scale = minOf(1f, limit.toFloat() / maxOf(width, height))
                    reader.getScaledFrameAtTime(-1, MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                        (width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1))
                } else reader.getFrameAtTime(-1, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                if (bitmap == null) return null
                val scale = minOf(1f, limit.toFloat() / maxOf(bitmap.width, bitmap.height))
                if (scale >= 1f) return bitmap
                val scaled = Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true)
                if (scaled !== bitmap) bitmap.recycle()
                return scaled
            } finally { reader.release() }
        }
        if (extension in setOf("txt", "md", "markdown", "csv", "json", "xml", "log", "yaml", "yml", "js", "ts", "py", "css", "html", "rs", "kt")) {
            val bytes = File(path).inputStream().use { stream ->
                val buffer = ByteArray(8192)
                val count = stream.read(buffer)
                if (count < 1) return null
                buffer.copyOf(count)
            }
            if (bytes.any { it == 0.toByte() }) return null
            val text = bytes.toString(Charsets.UTF_8).removePrefix("\uFEFF").take(1800)
            if (text.isBlank()) return null
            val bitmap = Bitmap.createBitmap(400, 512, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.WHITE)
            val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(50, 56, 66); textSize = 18f }
            val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, 352).setIncludePad(false).setLineSpacing(4f, 1f).build()
            canvas.save(); canvas.translate(24f, 26f); canvas.clipRect(0f, 0f, 352f, 460f); layout.draw(canvas); canvas.restore()
            return bitmap
        }
        return null
    }

}
