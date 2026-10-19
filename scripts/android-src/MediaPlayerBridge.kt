package com.luckyray.mobile

import android.content.Intent
import java.lang.ref.WeakReference

/** Only Rust-issued loopback capabilities reach this private Activity. The
 * Desktop URL/bearer/certificate stay in the original Rust authority. */
object MediaPlayerBridge {
    private external fun nativeInit()
    private external fun nativeClaim(lease: String, url: String): Boolean
    private external fun nativeIsCurrent(lease: String): Boolean
    private external fun nativeFirstFrame(lease: String)
    private external fun nativeClosed(lease: String, position: Long, duration: Long, reason: Int, format: String)
    private var surface = WeakReference<MaterialsPlayerActivity>(null)
    // Main calls this only after Tauri loaded the native library. A restored
    // media Activity must not poison object initialization before Main starts.
    @JvmStatic fun warm() { nativeInit() }
    @JvmStatic fun open(url: String, title: String, lease: String, position: Long, darkMode: Boolean): Boolean {
        val activity = DeviceBridge.appActivity ?: return false
        if (activity.isFinishing || activity.isDestroyed) return false
        activity.runOnUiThread {
            if (activity.isFinishing || !activity.hasWindowFocus()) {
                nativeClosed(lease, position, 0, 7, "{}")
            } else try {
                activity.startActivity(Intent(activity, MaterialsPlayerActivity::class.java)
                    .putExtra("mediaUrl", url).putExtra("title", title)
                    .putExtra("lease", lease).putExtra("position", position).putExtra("darkMode", darkMode))
            } catch (_: Exception) { nativeClosed(lease, position, 0, 7, "{}") }
        }
        return true
    }
    fun attach(activity: MaterialsPlayerActivity, lease: String, url: String): Boolean {
        if (!nativeClaim(lease, url)) return false
        surface = WeakReference(activity)
        return true
    }
    fun isCurrent(lease: String) = nativeIsCurrent(lease)
    fun firstFrame(lease: String) { nativeFirstFrame(lease) }
    fun closed(activity: MaterialsPlayerActivity, lease: String, position: Long, duration: Long, reason: Int, format: String) {
        if (surface.get() === activity) surface.clear()
        if (lease.isNotEmpty()) nativeClosed(lease, position, duration, reason, format)
    }
    @JvmStatic fun close(lease: String) {
        val activity = surface.get() ?: return
        activity.runOnUiThread { if (activity.lease == lease) activity.closePlayer(6) }
    }
}
