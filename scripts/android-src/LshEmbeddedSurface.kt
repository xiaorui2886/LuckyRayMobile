package com.luckyray.mobile

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.util.Log
import android.os.Looper
import android.os.SystemClock
import android.os.Handler
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.util.concurrent.FutureTask
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** A presentation-only child of the main Activity. No JavaScript bridge, no
 * credentials, no second runtime. All HTTP/WS authority remains in the carrier.
 * Layout is relative to the main Tauri WebView, never screen coordinates. */
object LshEmbeddedSurface {
    private var web: WebView? = null
    private var host: FrameLayout? = null
    private var owner = ""
    private var presentationId = ""
    @Volatile private var lease = ""
    private var origin: Uri? = null
    private var ready = false
    private var failed = false
    private var failureCode = ""
    private var presentationDiagnostic = "not_probed"
    private var presentationActivation = 0L
    private var gestureCounter = 0L
    private var touchX = 0f
    private var touchY = 0f
    private var touchBegan = 0L
    private var nativeTouchCandidate = false
    private var pendingCapabilityUrl = ""
    private var capabilityChecking = false
    private var clearCapabilityHistory = false
    private var pageGeneration = 0
    private var deadlineGeneration = 0
    private val presentationHandler = Handler(Looper.getMainLooper())
    private val activeTime = LshPresentationActiveTime { SystemClock.elapsedRealtime() }
    private var deadlineBegan = 0L
    private var deadlineTask: Runnable? = null
    private var probeTask: Runnable? = null
    private var probeBegan = -1L
    private var probeEpoch = 0
    private var rendererResumed = false
    private var presentationActive = false
    private var dark = false
    private var wantedVisible = false
    private var foreground = true
    // Presentation-only hold. No screenshot, new lease, or grant renewal.
    private var lifecycleGeneration = 0L
    private var pendingFileResult: Array<Uri>? = null
    private var fileResultReady = false
    private var filePageGeneration = -1
    private var suspended = false
    private var suspensionBegan = -1L
    private var suspensionTask: Runnable? = null
    private var suspensionLabel: TextView? = null
    private fun inputAllowed(): Boolean = !suspended && presentationActive && ready && !failed && LshSurfaceBridge.isLeaseCurrent(lease)
    private fun suspendInput() {
        if (!suspended) lifecycleGeneration += 1
        suspended = true
        invalidateTabGesture(); notifyIme(false); web?.clearFocus()
        web?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }
    private fun endSuspension() {
        suspended = false; suspensionBegan = -1L
        suspensionTask?.let { presentationHandler.removeCallbacks(it) }; suspensionTask = null
        suspensionLabel?.visibility = View.GONE
        web?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }
    private fun deliverPendingFile() {
        if (!fileResultReady || !inputAllowed()) return
        val callback = fileCallback; fileCallback = null
        callback?.onReceiveValue(if (filePageGeneration == pageGeneration) pendingFileResult else null)
        pendingFileResult = null; fileResultReady = false
    }
    private fun checkSuspension() {
        suspensionTask?.let { presentationHandler.removeCallbacks(it) }; suspensionTask = null
        if (!suspended || !foreground || !wantedVisible) return
        if (!LshSurfaceBridge.isLeaseCurrent(lease)) { Log.i("LshPresentationDiag", "lease=retired"); destroy(); return }
        val now = SystemClock.elapsedRealtime()
        if (suspensionBegan < 0L) suspensionBegan = now
        if (now - suspensionBegan >= 20_000L) {
            fileCallback?.onReceiveValue(null); fileCallback = null; pendingFileResult = null; fileResultReady = false; pendingFileRequest = -1
            failed = true; failureCode = "LSH_REVALIDATION_TIMEOUT"
            Log.i("LshPresentationDiag", "revalidation=timeout")
            wantedVisible = false; syncPresentationActivity(); return
        }
        suspensionLabel?.visibility = if (now - suspensionBegan >= 700L) View.VISIBLE else View.GONE
        val task = Runnable { checkSuspension() }
        suspensionTask = task; presentationHandler.postDelayed(task, 200L)
    }
    private var activity: Activity? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var fileRequest = 7142
    private var pendingFileRequest = -1

    fun command(raw: String): String {
        val current = DeviceBridge.appActivity ?: return error("LSH_NO_ACTIVITY")
        if (runCatching { JSONObject(raw).optString("action") }.getOrNull() == "back") return back(current, raw)
        val dispatchedLease = lease
        val abandoned = AtomicBoolean(false)
        val task = FutureTask<String> {
            if (abandoned.get()) return@FutureTask error("LSH_NATIVE_TIMEOUT")
            val previous = web
            try {
                val request = JSONObject(raw)
                val result = execute(current, request).toString()
                // If the worker deadline won while the UI was executing open,
                // retire only this launch, never a newer replacement.
                if (abandoned.get() && request.optString("action") == "open" && lease == request.optString("lease")) destroy()
                result
            }
            catch (_: Exception) {
                if (web !== previous && runCatching { JSONObject(raw).optString("action") }.getOrNull() == "open") destroy()
                error("LSH_EMBED_DECLINED")
            } }
        if (Looper.myLooper() == Looper.getMainLooper()) task.run() else current.runOnUiThread(task)
        // Return actual UI completion, not merely 'queued'. This method is
        // called by Rust's blocking worker, never Android's main thread.
        return try { task.get(5, TimeUnit.SECONDS) }
        catch (_: Exception) {
            abandoned.set(true)
            task.cancel(false) // queued work must not execute after timeout
            // UI execution may already have completed before abandonment was
            // observed. Fence delayed cleanup to this exact launch lease.
            val request = runCatching { JSONObject(raw) }.getOrNull()
            if (request != null) current.runOnUiThread {
                if (request.optString("action") == "open") {
                    if (lease.isNotEmpty() && lease == request.optString("lease")) destroy()
                } else if (dispatchedLease.isNotEmpty() && lease == dispatchedLease && owner == request.optString("expectedInstance") && presentationId == request.optString("presentationId")) {
                    // A cancelled hide/close must not strand its old overlay
                    // above another tab when a stalled UI thread recovers.
                    if (request.optString("action") == "close") destroy()
                    else { invalidateTabGesture(); notifyIme(false); wantedVisible = false; syncPresentationActivity(); web?.clearFocus() }
                }
            }
            error("LSH_NATIVE_TIMEOUT")
        }
    }
    private fun back(current: Activity, raw: String): String {
        // evaluateJavascript completes asynchronously on UI. Only the JNI
        // blocking worker waits; never wait for a callback on that same UI.
        if (Looper.myLooper() == Looper.getMainLooper()) return error("LSH_BACK_THREAD_INVALID")
        val completion = CompletableFuture<String>()
        current.runOnUiThread {
            if (completion.isDone) return@runOnUiThread
            try {
                val expected = JSONObject(raw).getString("expectedInstance")
                val view = web
                if (view == null) {
                    completion.complete(state().put("backHandled", false).toString())
                    return@runOnUiThread
                }
                require(owner == expected && presentationId == JSONObject(raw).getString("presentationId") && !current.isFinishing && !current.isDestroyed)
                if (!inputAllowed()) { completion.complete(state().put("backHandled", true).toString()); return@runOnUiThread }
                val generation = pageGeneration
                val lifecycle = lifecycleGeneration
                Handler(Looper.getMainLooper()).postDelayed({ completion.complete(error("LSH_BACK_OUTCOME_UNKNOWN")) }, 2_000L)
                view.evaluateJavascript(
                    "(()=>{if(!window.dispatchEvent(new Event('luckyray-mobile-back',{cancelable:true})))return true;return !(document.activeElement||document).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));})()"
                ) { consumed ->
                    if (completion.isDone) return@evaluateJavascript
                    if (web !== view || owner != expected || generation != pageGeneration || lifecycle != lifecycleGeneration || !inputAllowed()) {
                        completion.complete(error("CONTENT_SOURCE_CHANGED"))
                        return@evaluateJavascript
                    }
                    var handled = consumed == "true"
                    if (!handled && view.canGoBack()) { view.goBack(); handled = true }
                    completion.complete(state().put("backHandled", handled).toString())
                }
            } catch (_: Exception) { completion.complete(error("LSH_EMBED_DECLINED")) }
        }
        return try { completion.get(3, TimeUnit.SECONDS) }
        catch (_: Exception) {
            val unknown = error("LSH_BACK_OUTCOME_UNKNOWN")
            completion.complete(unknown)
            unknown
        }
    }

    private fun error(code: String) = JSONObject().put("error", code).toString()
    private fun state() = JSONObject().put("opened", web != null)
        .put("visible", host?.visibility == View.VISIBLE).put("ready", ready)
        .put("suspended", suspended).put("lifecycleGeneration", lifecycleGeneration)
        .put("failed", failed).put("canGoBack", web?.canGoBack() == true)
        .put("presentationDiagnostic", presentationDiagnostic)
        .apply { if (failed) put("error", failureCode.ifEmpty { "LSH_PAGE_LOAD_FAILED" }) }
    private fun execute(a: Activity, request: JSONObject): JSONObject {
        val expected = request.getString("expectedInstance")
        val action = request.getString("action")
        if (action != "close" && action != "hide") require(!a.isFinishing && !a.isDestroyed)
        if (action == "open") {
            val url = request.getString("sessionUrl")
            val uri = Uri.parse(url)
            require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port > 0 && uri.userInfo == null)
            require(expected.isNotEmpty() && request.getString("lease").isNotEmpty())
            // Rust blocking dispatch may be delayed beyond the caller deadline.
            // Refuse a retired launch before touching any newer same-owner view.
            require(LshSurfaceBridge.isLeaseCurrent(request.getString("lease")))
            destroy()
            owner = expected; presentationId = request.getString("presentationId"); lease = request.getString("lease"); origin = uri; activity = a
            presentationActivation = request.optLong("presentationActivation", 0L)
            val frame = object : FrameLayout(a) {
                // A DOWN swallowed while checking must never become an UP in
                // the page if permission arrives halfway through that gesture.
                private var blockedTouchSequence = false
                override fun dispatchTouchEvent(event: MotionEvent): Boolean {
                    if (event.actionMasked == MotionEvent.ACTION_DOWN) blockedTouchSequence = !inputAllowed()
                    if (!inputAllowed()) blockedTouchSequence = true
                    val blocked = blockedTouchSequence
                    if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) blockedTouchSequence = false
                    return if (blocked) true else super.dispatchTouchEvent(event)
                }
                override fun onInterceptTouchEvent(event: MotionEvent): Boolean = !inputAllowed() || super.onInterceptTouchEvent(event)
                override fun onTouchEvent(event: MotionEvent): Boolean = if (!inputAllowed()) true else super.onTouchEvent(event)
                override fun dispatchKeyEvent(event: KeyEvent): Boolean = if (!inputAllowed()) true else super.dispatchKeyEvent(event)
            }
            val browser = WebView(a)
            web = browser; host = frame
            browser.settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true
                allowFileAccess = false; allowContentAccess = false
                setSupportMultipleWindows(false)
                mediaPlaybackRequiresUserGesture = true
            }
            browser.setOnTouchListener { _, event -> if (!inputAllowed()) true else { observeTabGesture(browser, event); false } }
            browser.webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    if (!inputAllowed() || web !== view || view.url?.let { sameOrigin(Uri.parse(it)) } != true) return false
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback; filePageGeneration = pageGeneration; fileResultReady = false; pendingFileResult = null
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        val accepted = params.acceptTypes.filter { it.contains("/") && it.length < 128 }.toTypedArray()
                        if (accepted.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, accepted)
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    pendingFileRequest = fileRequest
                    fileRequest = if (fileRequest >= 7173) 7142 else fileRequest + 1
                    try { a.startActivityForResult(intent, pendingFileRequest) }
                    catch (_: Exception) { fileCallback = null; callback.onReceiveValue(null) }
                    return true
                }
            }
            browser.webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    if (web !== view) return
                    invalidateTabGesture()
                    pageGeneration += 1
                    probeEpoch += 1; probeBegan = -1L
                    probeTask?.let { presentationHandler.removeCallbacks(it) }; probeTask = null
                    ready = false; failed = false; failureCode = ""; presentationDiagnostic = "not_probed"
                    armPresentationDeadline(view)
                    syncPresentationActivity()
                }
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    if (sameOrigin(req.url)) return false
                    if (inputAllowed() && req.isForMainFrame && (req.url.scheme == "https" || req.url.scheme == "http")) {
                        try { a.startActivity(Intent(Intent.ACTION_VIEW, req.url)) } catch (_: Exception) { }
                    }
                    return true
                }
                override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                    if (sameOrigin(req.url)) return null
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    if (web !== view) return
                    if (failed) return
                    if (pendingCapabilityUrl.isNotEmpty()) {
                        probeCapabilities(view, pageGeneration)
                        return
                    }
                    applyTheme()
                    if (probeBegan < 0L) probeBegan = activeTime.elapsed()
                    probePresentation(view, pageGeneration, probeEpoch)
                }
                override fun onReceivedError(view: WebView, req: WebResourceRequest, error: WebResourceError) {
                    if (web === view && req.isForMainFrame) { failed = true; ready = false; host?.visibility = View.GONE; syncPresentationActivity() }
                }
                override fun onReceivedHttpError(view: WebView, req: WebResourceRequest, response: WebResourceResponse) {
                    if (web === view && req.isForMainFrame && response.statusCode >= 400) { failed = true; ready = false; host?.visibility = View.GONE; syncPresentationActivity() }
                }
            }
            frame.addView(browser, FrameLayout.LayoutParams(-1, -1))
            suspensionLabel = TextView(a).apply {
                text = "正在确认连接…"; textSize = 12f
                val density = resources.displayMetrics.density
                setPadding((18 * density).toInt(), (10 * density).toInt(), (18 * density).toInt(), (10 * density).toInt())
                gravity = android.view.Gravity.CENTER
                // Quiet corner status inside the native content bounds. Keep
                // the chat and compose area clear rather than covering center.
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
                accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
                elevation = 3 * density
                visibility = View.GONE
            }
            frame.addView(suspensionLabel, FrameLayout.LayoutParams(-2, -2, android.view.Gravity.BOTTOM or android.view.Gravity.END).apply {
                val inset = (12 * a.resources.displayMetrics.density).toInt()
                marginEnd = inset; bottomMargin = inset
            })
            (a.findViewById<View>(android.R.id.content) as ViewGroup).addView(frame, ViewGroup.LayoutParams(1, 1))
            frame.visibility = View.GONE
            dark = request.optBoolean("dark", false)
            layout(a, request.getJSONObject("bounds"))
            // Start the finite deadline before navigation, not onPageFinished:
            // stalled main-frame loads and absent JS callbacks must fail too.
            armPresentationDeadline(browser)
            pendingCapabilityUrl = url
            capabilityChecking = false
            clearCapabilityHistory = true
            // App-owned blank document tests syntax/APIs BEFORE official modules.
            // It contains no capability, network script, credentials or bridge.
            browser.loadDataWithBaseURL("http://127.0.0.1:" + uri.port + "/", "<!doctype html><html><head></head><body></body></html>", "text/html", "UTF-8", null)
        } else {
            if (web == null) return state()
            require(owner == expected)
            require(presentationId == request.getString("presentationId"))
            when (action) {
                "suspend" -> { require(ready && !failed); suspendInput(); dark = request.optBoolean("dark", dark); layout(a, request.getJSONObject("bounds")); applyTheme() }
                "layout" -> { if (request.optLong("lifecycleGeneration", 0L) != lifecycleGeneration) { Log.i("LshPresentationDiag", "revalidation=stale_lifecycle"); return state() }; endSuspension(); val nextActivation = request.optLong("presentationActivation", 0L); if (nextActivation != presentationActivation) invalidateTabGesture(); presentationActivation = nextActivation; dark = request.optBoolean("dark", dark); layout(a, request.getJSONObject("bounds")); applyTheme(); deliverPendingFile() }
                "hide" -> { lifecycleGeneration += 1; invalidateTabGesture(); notifyIme(false); wantedVisible = false; syncPresentationActivity(); web?.clearFocus() }
                "close" -> destroy()
                "status" -> syncPresentationActivity()
                else -> throw IllegalArgumentException("Unsupported presentation action")
            }
        }
        return state()
    }
    /** Fixed presentation probe only. No conversation text, credentials or
     * general page script is accepted by this interface. Every callback and
     * timer is fenced to the exact WebView and navigation generation. */
    private fun armPresentationDeadline(view: WebView) {
        deadlineGeneration += 1
        deadlineBegan = activeTime.elapsed()
        schedulePresentationDeadline(view)
    }
    private fun schedulePresentationDeadline(view: WebView) {
        deadlineTask?.let { presentationHandler.removeCallbacks(it) }; deadlineTask = null
        if (!presentationActive || ready || failed) return
        val deadline = deadlineGeneration
        val task = Runnable {
            deadlineTask = null
            if (web === view && deadline == deadlineGeneration && presentationActive && !ready && !failed) {
                failed = true; ready = false; failureCode = "LSH_PAGE_TIMEOUT"
                Log.i("LshPresentationDiag", "deadline=" + presentationDiagnostic)
                host?.visibility = View.GONE
                view.stopLoading()
                syncPresentationActivity()
            }
        }
        deadlineTask = task
        presentationHandler.postDelayed(task, (40_000L - (activeTime.elapsed() - deadlineBegan)).coerceAtLeast(0L))
    }
    /** Pause only presentation budgets, never carrier/authentication expiry.
     * No readiness poll or deadline remains scheduled while hidden. */
    private fun syncPresentationActivity() {
        val view = web
        val authorized = view != null && LshSurfaceBridge.isLeaseCurrent(lease)
        if (view != null && !authorized) {
            Log.i("LshPresentationDiag", "lease=retired")
            // A retired/replaced carrier has no authority to retain a view.
            // Host may bootstrap again only after fresh Desktop permission.
            destroy()
            return
        }
        val active = authorized && foreground && wantedVisible && !failed && !suspended
        val changed = active != presentationActive
        presentationActive = active
        activeTime.setActive(active)
        // A retained, noninteractive page still needs its renderer resumed to
        // repaint after Android backgrounding. This grants no input or lease.
        val render = authorized && foreground && wantedVisible && !failed && (active || (suspended && ready))
        if (render != rendererResumed) {
            rendererResumed = render
            // Lifecycle intent only, not evidence that a frame was painted.
            Log.i("LshPresentationDiag", if (render) "renderer=resumed" else "renderer=paused")
            if (render) view?.onResume() else view?.onPause()
        }
        if (!active) {
            probeEpoch += 1
            deadlineTask?.let { presentationHandler.removeCallbacks(it) }; deadlineTask = null
            probeTask?.let { presentationHandler.removeCallbacks(it) }; probeTask = null
            host?.visibility = if (authorized && foreground && wantedVisible && suspended && ready && !failed) View.VISIBLE else View.GONE
            checkSuspension()
            return
        }
        view ?: return
        host?.visibility = if (ready) View.VISIBLE else View.INVISIBLE
        schedulePresentationDeadline(view)
        if (changed && probeBegan >= 0L && !ready) probePresentation(view, pageGeneration, probeEpoch)
    }
    private fun probePresentation(view: WebView, generation: Int, epoch: Int) {
        if (web !== view || generation != pageGeneration || epoch != probeEpoch || failed || !presentationActive) return
        view.evaluateJavascript(
            "[document.documentElement.dataset.luckyrayMobileVersion==='mobile-shell-v1-dsh-0.2.1-rc.2',(function(){var shell=document.querySelector('[data-luckyray-mobile-shell=\"mobile-shell-v1-dsh-0.2.1-rc.2\"].lr-mobile-overlay');var root=document.querySelector('[data-slot=\"main.conversation\"] .wSkVaW_root,section.lr-mobile-conversation');var body=root&&root.querySelector('[data-conversation-content]');var seat=body&&body.querySelector('[data-composer-seat]');return !!(shell&&body&&seat&&seat.childElementCount>0&&seat.querySelector('[data-composer-card]')&&seat.querySelector('[data-composer-input]')&&body.querySelector('[data-conversation-scroll]')&&['hero','active'].indexOf(body.getAttribute('data-content-phase'))>=0&&!root.querySelector('[data-slot-error],[data-factory-error]'));})(),new URLSearchParams(location.search).get('luckyrayMobile')==='1',!!(window.__ModuleLoader__&&typeof window.__ModuleLoader__.load==='function'),!!document.getElementById('luckyray-mobile-presentation')]"
        ) { raw ->
            if (web !== view || generation != pageGeneration || epoch != probeEpoch || failed || !presentationActive) return@evaluateJavascript
            // Only the five fixed booleans are accepted. Never retain/log raw
            // callback text, page URLs, query strings, session text or errors.
            val bits = runCatching { JSONArray(raw) }.getOrNull()?.takeIf {
                it.length() == 5 && (0 until 5).all { index -> it.opt(index) is Boolean }
            }
            val installed = bits?.optBoolean(0, false) == true
            val mounted = bits?.optBoolean(1, false) == true
            val mobileMode = bits?.optBoolean(2, false) == true
            val loaderPresent = bits?.optBoolean(3, false) == true
            val stylePresent = bits?.optBoolean(4, false) == true
            presentationDiagnostic = when {
                bits == null -> "probe_invalid"
                !mobileMode -> "mobile_mode_missing"
                installed && mounted -> "ready"
                installed -> "root_not_mounted"
                !loaderPresent -> "module_loader_missing"
                stylePresent -> "version_marker_missing"
                else -> "mobile_plugin_not_installed"
            }
            if (mobileMode && installed && mounted) {
                if (!ready) {
                    if (clearCapabilityHistory) { view.clearHistory(); clearCapabilityHistory = false }
                    view.evaluateJavascript(TAB_GESTURE_SCRIPT, null)
                }
                ready = true
                syncPresentationActivity()
            } else if (activeTime.elapsed() - probeBegan >= 30_000L) {
                failed = true; ready = false
                failureCode = when {
                    bits == null -> "LSH_PRESENTATION_PROBE_INVALID"
                    !mobileMode -> "LSH_MOBILE_MODE_REQUIRED"
                    installed -> "LSH_MOBILE_UI_NOT_READY"
                    else -> "LSH_MOBILE_UI_REQUIRED"
                }
                // Fixed enum only; no general console forwarding or JS bridge.
                Log.i("LshPresentationDiag", "readiness=" + presentationDiagnostic)
                syncPresentationActivity()
            } else {
                probeTask?.let { presentationHandler.removeCallbacks(it) }
                val task = Runnable { probeTask = null; probePresentation(view, generation, epoch) }
                probeTask = task
                presentationHandler.postDelayed(task, 250L)
            }
        }
    }

    private fun probeCapabilities(view: WebView, generation: Int) {
        if (capabilityChecking || web !== view || failed) return
        capabilityChecking = true
        view.evaluateJavascript(CAPABILITY_SCRIPT) { raw ->
            if (web !== view || generation != pageGeneration || failed || pendingCapabilityUrl.isEmpty()) return@evaluateJavascript
            val bits = runCatching { JSONArray(raw) }.getOrNull()
            val valid = bits != null && bits.length() == 5 && (0 until 5).all { bits.opt(it) is Boolean }
            if (!valid || (0 until 5).any { bits?.optBoolean(it, false) != true }) {
                pendingCapabilityUrl = ""
                failed = true; ready = false
                presentationDiagnostic = if (!valid) "capability_probe_invalid" else "webview_capability_missing"
                failureCode = if (!valid) "LSH_PRESENTATION_PROBE_INVALID" else "LSH_WEBVIEW_UPDATE_REQUIRED"
                Log.i("LshPresentationDiag", "capability=" + presentationDiagnostic)
                syncPresentationActivity()
                return@evaluateJavascript
            }
            val launch = pendingCapabilityUrl
            pendingCapabilityUrl = ""
            view.loadUrl(launch)
        }
    }
    private fun invalidateTabGesture() { gestureCounter += 1; nativeTouchCandidate = false }
    private fun canDeliverTabGesture(view: WebView): Boolean =
        web === view && ready && !failed && foreground && wantedVisible &&
        host?.visibility == View.VISIBLE && presentationActivation > 0 &&
        view.url?.let { sameOrigin(Uri.parse(it)) } == true &&
        LshSurfaceBridge.isLeaseCurrent(lease)
    private fun observeTabGesture(view: WebView, event: MotionEvent) {
        val density = view.resources.displayMetrics.density
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                invalidateTabGesture()
                if (web === view && ready) view.evaluateJavascript("typeof window.__luckyrayDiscardTabSwipe==='function'&&window.__luckyrayDiscardTabSwipe()", null)
                touchX = event.x; touchY = event.y; touchBegan = event.eventTime
                nativeTouchCandidate = event.pointerCount == 1 && canDeliverTabGesture(view) &&
                    event.x >= 24 * density && event.x <= view.width - 24 * density &&
                    event.y >= 24 * density && event.y <= view.height - 24 * density
            }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> invalidateTabGesture()
            MotionEvent.ACTION_MOVE -> if (event.pointerCount != 1 || kotlin.math.abs(event.y - touchY) > 24 * density) invalidateTabGesture()
            MotionEvent.ACTION_UP -> {
                val dx = event.x - touchX
                val elapsed = event.eventTime - touchBegan
                val candidate = nativeTouchCandidate && event.pointerCount == 1 && elapsed in 40L..600L &&
                    kotlin.math.abs(dx) >= 80 * density && kotlin.math.abs(event.y - touchY) <= 24 * density
                nativeTouchCandidate = false
                if (!candidate || !canDeliverTabGesture(view)) return
                val gesture = gestureCounter; val generation = pageGeneration
                val id = presentationId; val activation = presentationActivation; val currentLease = lease
                val expected = if (dx < 0) "left" else "right"
                // One bounded callback after a physical UP, never a background poll.
                view.postDelayed({
                    if (gesture != gestureCounter || generation != pageGeneration || id != presentationId ||
                        activation != presentationActivation || currentLease != lease || !canDeliverTabGesture(view)) return@postDelayed
                    view.evaluateJavascript("typeof window.__luckyrayTakeTabSwipe==='function'?window.__luckyrayTakeTabSwipe():''") { raw ->
                        if (raw != JSONObject.quote(expected) || gesture != gestureCounter || generation != pageGeneration ||
                            id != presentationId || activation != presentationActivation || currentLease != lease || !canDeliverTabGesture(view)) return@evaluateJavascript
                        val main = activity?.findViewById<View>(android.R.id.content)?.let { findMain(it) } ?: return@evaluateJavascript
                        val detail = JSONObject().put("direction", expected).put("presentationId", id)
                            .put("presentationActivation", activation).put("gestureId", gesture)
                        main.evaluateJavascript("window.dispatchEvent(new CustomEvent('luckyray-lsh-tab-swipe',{detail:" + detail.toString() + "}));", null)
                    }
                }, 80L)
            }
        }
    }
    private val CAPABILITY_SCRIPT = """(function(){var syntax=false;try{new Function('class C { static {} };var x;x??=1;x&&=2;x||=3;');syntax=true;}catch(e){}return [syntax,typeof Object.hasOwn==='function',typeof Array.prototype.at==='function',typeof String.prototype.replaceAll==='function',typeof WeakRef==='function'];})()"""
    private val TAB_GESTURE_SCRIPT = """
(function () {
  if (window.__luckyrayTakeTabSwipe) return;
  var start = null, pending = null;
  var blocked = 'input,textarea,select,button,a,pre,code,table,video,audio,canvas,iframe,[contenteditable],[role="textbox"],[role="slider"],[role="dialog"],[role="menu"],[data-swipe-owner],.lr-mobile-header';
  function selection() { var s = window.getSelection(); return !!s && !s.isCollapsed; }
  function eligible(node) {
    if (!node || !node.isConnected || !node.closest || !node.closest('.lr-mobile-conversation [data-conversation-content],html[data-luckyray-mobile="1"] [data-slot="main.conversation"] [data-conversation-content]') || node.closest(blocked) || selection()) return false;
    var active = document.activeElement;
    if (active && active.matches && active.matches('input,textarea,select,[contenteditable],[role="textbox"]')) return false;
    if (document.documentElement.dataset.luckyrayMobilePanel === '1') return false;
    if (document.querySelector('.pI_x6G_frame:not([data-sidebar-collapsed])')) return false;
    if (Array.from(document.querySelectorAll('[role="dialog"],[role="menu"],.lr-mobile-header-details:not([hidden])')).some(function (n) { return n.getAttribute('aria-hidden') !== 'true' && n.getClientRects().length > 0; })) return false;
    for (var n = node; n && n !== document.documentElement; n = n.parentElement) {
      var style = getComputedStyle(n);
      if (n.scrollWidth > n.clientWidth + 2 && /auto|scroll|overlay/.test(style.overflowX)) return false;
      if (n.draggable || n.getAttribute('role') === 'application') return false;
    }
    return true;
  }
  function cancel() { start = null; pending = null; }
  window.addEventListener('touchstart', cancel, {passive:true,capture:true});
  window.addEventListener('touchstart', function (e) {
    cancel();
    if (!e.isTrusted || e.defaultPrevented || e.touches.length !== 1 || !eligible(e.target)) return;
    var t = e.touches[0];
    if (t.clientX < 24 || t.clientX > innerWidth - 24 || t.clientY < 24 || t.clientY > innerHeight - 24) return;
    start = { x:t.clientX, y:t.clientY, at:performance.now(), target:e.target, id:t.identifier, event:e, move:null };
  }, {passive:true});
  window.addEventListener('touchmove', function (e) {
    if (!start) return;
    if (!e.isTrusted || e.defaultPrevented || start.event.defaultPrevented || (start.move && start.move.defaultPrevented) || e.touches.length !== 1 || e.touches[0].identifier !== start.id || Math.abs(e.touches[0].clientY - start.y) > 24 || selection()) { cancel(); return; }
    start.move = e;
  }, {passive:true});
  window.addEventListener('touchend', function (e) {
    var s = start; start = null; pending = null;
    if (!s || !e.isTrusted || e.defaultPrevented || s.event.defaultPrevented || (s.move && s.move.defaultPrevented) || e.touches.length !== 0 || e.changedTouches.length !== 1 || e.changedTouches[0].identifier !== s.id || !eligible(s.target)) return;
    var t=e.changedTouches[0], dx=t.clientX-s.x, dy=t.clientY-s.y, duration=performance.now()-s.at;
    if (duration < 40 || duration > 600 || Math.abs(dx) < 80 || Math.abs(dy) > 24 || Math.abs(dx) < Math.abs(dy)*1.6) return;
    // Keep the event only until the single native drain; a later window
    // listener's preventDefault still wins. Never export the target or text.
    pending={direction:dx<0?'left':'right',at:performance.now(),event:e,move:s.move,target:s.target};
  }, {passive:true});
  window.addEventListener('touchcancel', cancel, {passive:true});
  window.addEventListener('pagehide', cancel);
  document.addEventListener('visibilitychange', cancel);
  window.__luckyrayDiscardTabSwipe = function () { pending = null; };
  window.__luckyrayTakeTabSwipe = function () {
    var p=pending; pending=null;
    return p && !p.event.defaultPrevented && !(p.move && p.move.defaultPrevented) && performance.now()-p.at <= 250 && eligible(p.target) ? p.direction : '';
  };
})();
    """.trimIndent()

    private fun sameOrigin(uri: Uri): Boolean = origin?.let { uri.scheme == it.scheme && uri.host == it.host && uri.port == it.port } == true
    private fun findMain(view: View): WebView? {
        if (view === host || view === web) return null
        if (view is WebView) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findMain(view.getChildAt(i))?.let { return it }
        return null
    }
    private fun layout(a: Activity, b: JSONObject) {
        val content = a.findViewById<View>(android.R.id.content) as ViewGroup
        val main = findMain(content) ?: throw IllegalStateException("Main WebView missing")
        val viewport = b.getDouble("viewportWidth")
        val values = listOf(b.getDouble("x"), b.getDouble("y"), b.getDouble("width"), b.getDouble("height"), viewport)
        require(values.all { it.isFinite() } && viewport > 0 && values[2] >= 0 && values[3] >= 0)
        val scale = main.width / viewport
        val mp = IntArray(2); val cp = IntArray(2)
        main.getLocationInWindow(mp); content.getLocationInWindow(cp)
        val left = (values[0] * scale).toInt().coerceIn(0, main.width)
        val top = (values[1] * scale).toInt().coerceIn(0, main.height)
        val width = (values[2] * scale).toInt().coerceIn(0, main.width - left)
        val height = (values[3] * scale).toInt().coerceIn(0, main.height - top)
        host?.layoutParams = FrameLayout.LayoutParams(width, height).apply {
            leftMargin = mp[0] - cp[0] + left - content.paddingLeft
            topMargin = mp[1] - cp[1] + top - content.paddingTop
        }
        suspensionLabel?.apply {
            val inset = (12 * resources.displayMetrics.density).toInt()
            maxWidth = (width - 2 * inset).coerceAtLeast(1)
        }
        wantedVisible = foreground && width > 0 && height > 0
        syncPresentationActivity()
    }
    private fun applyTheme() {
        suspensionLabel?.apply {
            setTextColor(if (dark) Color.rgb(221, 224, 234) else Color.rgb(91, 96, 113))
            background = GradientDrawable().apply {
                cornerRadius = 22 * resources.displayMetrics.density
                setColor(if (dark) Color.rgb(34, 36, 43) else Color.rgb(250, 250, 253))
                setStroke((resources.displayMetrics.density).toInt().coerceAtLeast(1), if (dark) Color.rgb(58, 61, 72) else Color.rgb(226, 228, 236))
            }
        }
        web?.setBackgroundColor(if (dark) Color.rgb(10, 10, 12) else Color.rgb(241, 242, 245))
        // Fixed, application-owned presentation signal. No arbitrary script or
        // value can cross this boundary. The desktop mobile UI consumes it.
        web?.evaluateJavascript(if (dark)
            "document.documentElement.dataset.luckyrayMobileTheme='dark';window.dispatchEvent(new Event('luckyray-mobile-theme'));"
        else "document.documentElement.dataset.luckyrayMobileTheme='light';window.dispatchEvent(new Event('luckyray-mobile-theme'));", null)
    }
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode !in 7142..7173) return false
        if (requestCode != pendingFileRequest) return true
        pendingFileRequest = -1
        val uris = mutableListOf<Uri>()
        if (resultCode == Activity.RESULT_OK && web != null) {
            data?.data?.let { if (it.scheme == "content") uris.add(it) }
            data?.clipData?.let { clip -> for (i in 0 until clip.itemCount) {
                val uri = clip.getItemAt(i).uri
                if (uri.scheme == "content" && !uris.contains(uri)) uris.add(uri)
            } }
        }
        pendingFileResult = if (uris.isEmpty()) null else uris.toTypedArray(); fileResultReady = true
        deliverPendingFile()
        return true
    }
    fun imeChanged(visible: Boolean) { notifyIme(visible && host?.visibility == View.VISIBLE && web?.hasFocus() == true) }
    private fun notifyIme(active: Boolean) {
        val content = activity?.findViewById<View>(android.R.id.content) ?: return
        val main = findMain(content) ?: return
        main.evaluateJavascript(if (active)
            "window.dispatchEvent(new CustomEvent('luckyray-lsh-ime',{detail:{active:true}}));"
        else "window.dispatchEvent(new CustomEvent('luckyray-lsh-ime',{detail:{active:false}}));", null)
    }
    fun resumeFor(a: Activity) {
        if (activity === a || activity == null) {
            foreground = true
            syncPresentationActivity()
            // Fixed lifecycle signal to the app-owned host only. Android child
            // WebViews do not consistently deliver document visibility events.
            val content = a.findViewById<View>(android.R.id.content)
            if (content != null) findMain(content)?.evaluateJavascript(
                "window.dispatchEvent(new Event('luckyray:foreground'));", null)
        }
    }
    fun pause() { lifecycleGeneration += 1; if (wantedVisible && ready && !failed) suspendInput(); invalidateTabGesture(); notifyIme(false); foreground = false; syncPresentationActivity() }
    fun destroyFor(a: Activity) { if (activity === a) destroy() }
    private fun destroy() {
        lifecycleGeneration += 1; pendingFileResult = null; fileResultReady = false
        endSuspension(); suspensionLabel = null
        rendererResumed = false
        presentationActive = false; activeTime.setActive(false)
        deadlineGeneration += 1; probeEpoch += 1; probeBegan = -1L
        deadlineTask?.let { presentationHandler.removeCallbacks(it) }; deadlineTask = null
        probeTask?.let { presentationHandler.removeCallbacks(it) }; probeTask = null
        invalidateTabGesture()
        pendingCapabilityUrl = ""; capabilityChecking = false; clearCapabilityHistory = false; presentationActivation = 0L
        notifyIme(false)
        val oldLease = lease
        fileCallback?.onReceiveValue(null); fileCallback = null; pendingFileRequest = -1
        host?.let { (it.parent as? ViewGroup)?.removeView(it) }
        web?.apply { stopLoading(); removeAllViews(); destroy() }
        web = null; host = null; origin = null; owner = ""; presentationId = ""; lease = ""; ready = false; failed = false; failureCode = ""; presentationDiagnostic = "not_probed"; pageGeneration += 1; activity = null; wantedVisible = false
        if (oldLease.isNotEmpty()) LshSurfaceBridge.retire(oldLease)
    }
}

/** Monotonic presentation-only clock. Carrier leases keep their own real clock. */
internal class LshPresentationActiveTime(private val now: () -> Long) {
    private var accumulated = 0L
    private var since: Long? = null
    fun elapsed(): Long = accumulated + (since?.let { (now() - it).coerceAtLeast(0L) } ?: 0L)
    fun setActive(active: Boolean) {
        if (active && since == null) since = now()
        else if (!active && since != null) { accumulated = elapsed(); since = null }
    }
}
