package com.luckyray.mobile

import android.app.Activity
import android.content.Context
import android.graphics.Color
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
    fun setSystemBarAppearance(dark: Boolean) {
        val activity = appActivity ?: return
        activity.runOnUiThread {
            WindowInsetsControllerCompat(activity.window, activity.window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
            if (dark) {
                activity.window.decorView.setBackgroundColor(Color.rgb(9, 9, 11))
                activity.window.statusBarColor = Color.rgb(9, 9, 11)
                activity.window.navigationBarColor = Color.rgb(9, 9, 11)
            } else {
                activity.window.decorView.setBackgroundColor(Color.rgb(247, 247, 244))
                activity.window.statusBarColor = Color.rgb(247, 247, 244)
                activity.window.navigationBarColor = Color.rgb(247, 247, 244)
            }
        }
    }
}
