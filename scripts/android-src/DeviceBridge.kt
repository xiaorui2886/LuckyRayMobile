package com.luckyray.mobile

import android.app.Activity
import android.content.Context
import android.graphics.Color
import kotlin.math.roundToInt
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Minimal platform probe bridge (device capability checks).
 *
 * gmsAvailable(): ML Kit (used by tauri-plugin-barcode-scanner) depends on
 * Google Play Services. On devices without GMS (e.g. Chinese-market Xiaomi
 * without Google services) BarcodeScanning.getClient() fails and scan() hangs
 * forever with no camera preview. Exposing this lets the UI give a clear
 * "use file pairing instead" message instead of a silent no-op.
 */
object DeviceBridge {
    lateinit var appContext: Context

    /** INTERACTION-CLOSURE-R1: the foreground MainActivity (set in onCreate).
     *  Rust drives root-Back and system-bar appearance through this activity. */
    @JvmStatic var appActivity: Activity? = null

    init { nativeInit() }

    private external fun nativeInit()

    @JvmStatic
    fun gmsAvailable(): Boolean {
        return try {
            appContext.packageManager.getPackageInfo("com.google.android.gms", 0)
            true
        } catch (e: Exception) { false }
    }

    /** Root Android Back fallback (INTERACTION-CLOSURE-R1): normal task/back
     *  semantics — background the task so the user lands on the launcher;
     *  state, data and pairing survive. NEVER a process kill. */
    @JvmStatic
    fun moveTaskToBack() {
        val activity = appActivity ?: return
        activity.runOnUiThread { activity.moveTaskToBack(true) }
    }

    /** System-bar VISUAL appearance follows the LuckyRay color mode
     *  (用户问题1). Presentation only — applySystemBarInsets() geometry and
     *  IME math in MainActivity are untouched. */
    @JvmStatic
    fun setSystemBarAppearance(dark: Boolean, dimmed: Boolean, statusRgb: Int, navigationRgb: Int) {
        val activity = appActivity ?: return
        activity.runOnUiThread {
            WindowInsetsControllerCompat(activity.window, activity.window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
            val base = if (dark) Color.rgb(10, 10, 12) else Color.rgb(241, 242, 245)
            val scrim = if (dark) Color.rgb(3, 3, 5) else Color.rgb(29, 31, 40)
            val alpha = if (!dimmed) 0f else if (dark) 0.64f else 0.30f
            fun blend(a: Int, b: Int) = (a * (1f - alpha) + b * alpha).roundToInt()
            val fallbackStatus = Color.rgb(blend(Color.red(base), Color.red(scrim)),
                blend(Color.green(base), Color.green(scrim)), blend(Color.blue(base), Color.blue(scrim)))
            // Web CSS supplies the already-composited opaque color, including
            // live fade opacity and nested sheets. NEVER dim this color again.
            fun opaque(rgb: Int) = rgb or (0xff shl 24)
            val status = if (statusRgb in 0..0xffffff) opaque(statusRgb) else fallbackStatus
            val navigation = if (navigationRgb in 0..0xffffff) opaque(navigationRgb) else base
            // The decor paints the status-bar inset on edge-to-edge Android.
            // The bottom sheet remains undimmed, as does its navigation bar.
            activity.window.decorView.setBackgroundColor(status)
            activity.window.statusBarColor = status
            activity.window.navigationBarColor = navigation
        }
    }
}
