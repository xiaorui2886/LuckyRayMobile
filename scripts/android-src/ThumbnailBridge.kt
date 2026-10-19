package com.luckyray.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.File
import java.io.FileOutputStream

/**
 * Bounded thumbnail generation for the M2.9 Local Material Library.
 *
 * The material grid must never decode every full-resolution original at once.
 * `generate()` decodes with BitmapFactory bounds-first + inSampleSize (memory
 * stays bounded regardless of the original size), scales down to a 512px max
 * side, and writes a JPEG into the app-private derived thumbnail cache
 * (`local-assets/thumbs/`). Thumbnails are disposable derived cache — never
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
}
