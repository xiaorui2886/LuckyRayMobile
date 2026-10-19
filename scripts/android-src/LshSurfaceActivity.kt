package com.luckyray.mobile

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.io.ByteArrayInputStream

/**
 * Dedicated full-screen WebView surface for the PAIRED desktop's authenticated
 * LightSeek web view (Issue #72, LSH-REMOTE-SURFACE-M1).
 *
 * Policy (all enforced natively — there is deliberately NO JS bridge):
 *  - The shell renders exactly ONE origin: the session URL the bootstrap
 *    handed over (same scheme/host/port for every request and navigation).
 *  - Same-origin navigation stays in the shell; external http(s) links are
 *    handed to the system browser; every other scheme is refused.
 *  - Non-same-origin subresource requests get an empty 403 — the surface can
 *    never silently pull third-party content.
 *  - System Back walks WebView history first, then returns to LuckyRay.
 *  - Main-frame load failures show a truthful native offline panel (retry /
 *    close) instead of a spinner or fabricated content.
 *  - No Javascript-to-native bridge of any kind: M1 needs none, and a bridge
 *    would be a second authority into the Desktop surface.
 *
 * WebView-83 fleet note (MI 8): the UI here is plain programmatic views and
 * inline layout params — no flexbox-gap, no newer WebView APIs. The minimum
 * constructor/config surface used below exists since API 21 (minSdk 24).
 */
class LshSurfaceActivity : Activity() {
    private lateinit var root: LinearLayout
    private lateinit var webView: WebView
    private lateinit var errorOverlay: LinearLayout
    private lateinit var sessionOrigin: Uri
    private var carrierLease = ""
    private var built = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sessionUrl = intent.getStringExtra(EXTRA_SESSION_URL).orEmpty()
        val ownerInstanceId = intent.getStringExtra(EXTRA_OWNER_INSTANCE_ID).orEmpty()
        val carrierLease = intent.getStringExtra(EXTRA_LEASE).orEmpty()
        val title = sanitizeTitle(intent.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE)
        if (sessionUrl.isEmpty() || ownerInstanceId.isEmpty() || !isLoadableSessionUrl(sessionUrl)) {
            // Fail closed: an unprovable owner or a URL that is not a plain
            // http(s) web origin never reaches loadUrl.
            finish()
            return
        }
        this.carrierLease = carrierLease
        sessionOrigin = Uri.parse(sessionUrl)

        // NOTE: no global cookie purge here. Android's CookieManager is
        // process/profile-wide, so wiping it would also clear cookies belonging
        // to other LuckyRay surfaces. Browser-session isolation for the LSH
        // surface is the #166-backed carrier/bootstrap contract's job (opaque
        // per-session authority / scoped cookie/origin), not cookie deletion.

        setTitle(title)

        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The shell renders exactly ONE web origin: no local file or
            // content-provider access from the page, ever.
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    // G1 white-surface diagnostics: bounded, sanitized console
                    // capture. Never logs query/fragment/cookies/ref/bodies.
                    Log.i(
                        DIAG_TAG,
                        "console level=${message.messageLevel()} " +
                            "msg=${bounded(message.message())} " +
                            "src=${sanitizeUrl(message.sourceId())}",
                    )
                    return false
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean = handleNavigation(request.url)

                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    if (isSameOrigin(request.url)) return null
                    // Blocked subresource: scheme+host+path only, never query.
                    Log.i(
                        DIAG_TAG,
                        "blocked ${request.method} ${sanitizeUrl(request.url.toString())} main=${request.isForMainFrame}",
                    )
                    return blockedResponse()
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    Log.i(DIAG_TAG, "page started ${sanitizeUrl(url)}")
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    Log.i(DIAG_TAG, "page finished ${sanitizeUrl(url)}")
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    errorResponse: WebResourceResponse,
                ) {
                    Log.i(
                        DIAG_TAG,
                        "http error ${errorResponse.statusCode} " +
                            "${sanitizeUrl(request.url.toString())} main=${request.isForMainFrame}",
                    )
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    Log.i(
                        DIAG_TAG,
                        "resource error code=${error.errorCode} " +
                            "desc=${bounded(error.description?.toString() ?: "")} " +
                            "${sanitizeUrl(request.url.toString())} main=${request.isForMainFrame}",
                    )
                    if (request.isForMainFrame) showSurfaceError()
                }
            }
        }
        root.addView(
            webView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                1f,
            ),
        )
        errorOverlay = buildErrorOverlay()
        root.addView(
            errorOverlay,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        errorOverlay.visibility = View.GONE
        setContentView(root)
        built = true
        // One-shot version record before the first load (diagnostics).
        logWebViewVersion()
        Log.i(DIAG_TAG, "loading ${sanitizeUrl(sessionUrl)}")
        webView.loadUrl(sessionUrl)
    }

    /** Same-origin policy: the paired session's exact scheme/host/port. */
    private fun isSameOrigin(uri: Uri): Boolean =
        uri.scheme == sessionOrigin.scheme && uri.host == sessionOrigin.host && (uri.port == sessionOrigin.port)

    /**
     * Fail-closed mirror of the native launch gate: only a plain http(s) URL
     * with a non-empty host is loadable, regardless of who started this
     * activity. file/content/data/javascript and user-info-bearing URLs are
     * refused before anything can load.
     */
    private fun isLoadableSessionUrl(raw: String): Boolean {
        if (raw.isEmpty() || raw.length > MAX_URL_CHARS) return false
        if (raw.any { it.isControlChar() || it.isWhitespace() }) return false
        val uri = Uri.parse(raw)
        val scheme = uri.scheme ?: return false
        if (scheme != "http" && scheme != "https") return false
        val host = uri.host ?: return false
        if (host.isEmpty()) return false
        if (raw.contains("@")) return false // user-info in the authority
        // FINAL-INTEGRATION: the session origin is the Mobile-owned carrier,
        // so the shell accepts ONLY the loopback http origin.
        if (scheme == "http" && host != "127.0.0.1") return false
        return true
    }

    private fun Char.isControlChar(): Boolean = this.code < 0x20 || this.code == 0x7f

    /** Bounded display title: control characters stripped, length capped. */
    private fun sanitizeTitle(raw: String): String =
        raw.filterNot { it.isControlChar() }.trim().take(MAX_TITLE_CHARS)


    private fun handleNavigation(uri: Uri): Boolean {
        if (isSameOrigin(uri)) return false // same-origin stays in the shell
        val scheme = uri.scheme ?: return true
        if (scheme == "https" || scheme == "http") {
            // External link → system browser. Never rendered inside the shell.
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (_: Exception) {
                // No browser to handle it: staying inside the shell would be
                // the worse outcome, so the navigation is simply dropped.
            }
        }
        return true // every other scheme is refused
    }

    private fun blockedResponse(): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Blocked",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(ByteArray(0)),
        )

    /** Truthful native error panel — no JS injection, no fabricated content. */
    private fun buildErrorOverlay(): LinearLayout {
        val pad = (16 * resources.displayMetrics.density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.rgb(247, 247, 244))
            val message = TextView(this@LshSurfaceActivity).apply {
                text = "LightSeek 暂时无法加载"
                textSize = 16f
                gravity = Gravity.CENTER
            }
            val hint = TextView(this@LshSurfaceActivity).apply {
                text = "电脑可能不在线，或连接已变化。"
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(pad, pad / 2, pad, pad)
            }
            val retry = Button(this@LshSurfaceActivity).apply {
                text = "重试"
                setOnClickListener { hideSurfaceError(); webView.reload() }
            }
            val close = Button(this@LshSurfaceActivity).apply {
                text = "关闭"
                setOnClickListener { finish() }
            }
            addView(message)
            addView(hint)
            addView(retry, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(close, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun showSurfaceError() {
        if (!built) return
        runOnUiThread { errorOverlay.visibility = View.VISIBLE }
    }

    private fun hideSurfaceError() {
        errorOverlay.visibility = View.GONE
    }

    override fun onBackPressed() {
        // System Back: WebView history first, then return to LuckyRay.
        if (built && webView.canGoBack()) {
            webView.goBack()
        } else {
            finish()
        }
    }

    override fun onPause() {
        super.onPause()
        if (built) webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (built) webView.onResume()
    }

    override fun onDestroy() {
        if (built) {
            webView.stopLoading()
            webView.destroy()
            root.removeAllViews()
        }
        // P1-F4: retire OUR carrier. Rust matches the lease, so a stale
        // Activity cannot stop a newer carrier.
        LshSurfaceBridge.retire(carrierLease)
        super.onDestroy()
    }

    /** Bounded, query-free logging helpers (G1 white-surface diagnostics). */
    private fun bounded(value: String?): String {
        val text = value ?: ""
        return if (text.length <= MAX_DIAG_CHARS) text else text.substring(0, MAX_DIAG_CHARS) + "..."
    }

    /** scheme://host/path only - query, fragment, capability and ref are dropped. */
    private fun sanitizeUrl(raw: String?): String {
        if (raw.isNullOrEmpty()) return ""
        val uri = Uri.parse(raw)
        val scheme = uri.scheme ?: return "(opaque)"
        val host = uri.host ?: ""
        val path = uri.path ?: ""
        return if (host.isEmpty()) "$scheme:$path" else "$scheme://$host$path"
    }

    /** Once at startup: the installed WebView package + version (diagnostics). */
    private fun logWebViewVersion() {
        try {
            val info = packageManager.getPackageInfo("com.google.android.webview", 0)
            Log.i(DIAG_TAG, "webview package=${info.packageName} version=${info.versionName}")
        } catch (e: Exception) {
            // Some ROMs use a different provider package; report the failure
            // class so the absence is observable rather than silent.
            Log.i(DIAG_TAG, "webview package=unknown (${e.javaClass.simpleName})")
        }
    }

    companion object {
        const val DIAG_TAG = "LshSurfaceDiag"
        const val MAX_DIAG_CHARS = 300
        const val EXTRA_LEASE = "carrierLease"
        const val MAX_URL_CHARS = 2048
        const val MAX_TITLE_CHARS = 64
        const val EXTRA_SESSION_URL = "sessionUrl"
        const val EXTRA_OWNER_INSTANCE_ID = "ownerInstanceId"
        const val EXTRA_TITLE = "title"
        const val DEFAULT_TITLE = "LightSeek"
    }
}
