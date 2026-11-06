package com.luckyray.mobile

import android.app.Activity
import android.content.Intent

/**
 * LSH remote-surface bridge (Issue #72 M1) — the JNI entry point Rust uses to
 * open the dedicated full-screen WebView shell.
 *
 * The shell renders the PAIRED desktop's authenticated LightSeek web surface.
 * It receives the exact session URL plus the owning Desktop instance as plain
 * strings; it holds no credentials itself (the session cookie belongs to the
 * Desktop gateway origin and stays inside the per-launch shell).
 *
 * Same bridge pattern as DeviceBridge/QrScannerBridge: Kotlin object with an
 * `init { nativeInit() }` self-registration so Rust can cache the class
 * reference from a native thread (multidex-safe), kept by the R8 rules in
 * app/keystore.pro.
 */
object LshSurfaceBridge {
    init { nativeInit() }

    private external fun nativeInit()

    /**
     * Startup warm seam (same pattern as ThumbnailBridge.warm).
     *
     * Touching the object runs `init { nativeInit() }`, which caches the JVM
     * and this bridge's Class GlobalRef so Rust can reach it from a native
     * thread (multidex-safe: native threads cannot FindClass app classes).
     * Without an explicit touch at startup the object is never initialized,
     * and the first product-path `open()` fails before any Activity launch
     * with "JVM not attached (LshSurfaceBridge not initialized)".
     *
     * No-op otherwise; introduces no new JNI authority.
     */
    @JvmStatic
    fun warm() {
        // no-op: touching the object runs `init { nativeInit() }`
    }

    /** P1-F4: retire the carrier bound to this lease (Activity destroy). */
    private external fun nativeRetire(lease: String)

    /** Native-only read check at actual UI execution, never exposed to page JS. */
    private external fun nativeIsLeaseCurrent(lease: String): Boolean
    fun isLeaseCurrent(lease: String): Boolean = lease.isNotEmpty() && nativeIsLeaseCurrent(lease)

    /**
     * Launch the full-screen surface on top of the current task.
     *
     * @return true when the activity was started; false when there is no
     *         foreground LuckyRay activity to launch from (the caller maps
     *         this to a truthful refusal instead of a silent no-op).
     */
    @JvmStatic
    fun open(sessionUrl: String, ownerInstanceId: String, title: String, lease: String): Boolean {
        val activity: Activity = DeviceBridge.appActivity ?: return false
        val intent = Intent(activity, LshSurfaceActivity::class.java)
        intent.putExtra(LshSurfaceActivity.EXTRA_SESSION_URL, sessionUrl)
        intent.putExtra(LshSurfaceActivity.EXTRA_OWNER_INSTANCE_ID, ownerInstanceId)
        intent.putExtra(LshSurfaceActivity.EXTRA_TITLE, title)
        intent.putExtra(LshSurfaceActivity.EXTRA_LEASE, lease)
        activity.startActivity(intent)
        return true
    }

    @JvmStatic
    fun embedded(request: String): String = LshEmbeddedSurface.command(request)

    /**
     * P1-F4: called by the Activity when it is destroyed. Rust retires the
     * carrier ONLY when this lease still matches the live one, so a stale
     * Activity can never stop a newer carrier.
     */
    @JvmStatic
    fun retire(lease: String) {
        if (lease.isNotEmpty()) nativeRetire(lease)
    }
}
