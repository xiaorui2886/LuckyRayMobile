package com.luckyray.mobile

import android.graphics.Color
import android.content.pm.ActivityInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONObject

/** Opaque, independent native composition first; no Surface above a retained
 * WebView, no background service/playback and no arbitrary URL/file authority. */
@androidx.annotation.OptIn(UnstableApi::class)
class MaterialsPlayerActivity : ComponentActivity() {
    var lease: String = ""; private set
    private var player: ExoPlayer? = null
    private var view: PlayerView? = null
    private var chrome: LinearLayout? = null
    private var mediaRoot: FrameLayout? = null
    private var fullscreen = false
    private var restoreOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    private var darkMode = false
    @Volatile private var closed = false
    private var attached = false
    private val handler = Handler(Looper.getMainLooper())
    private val format = JSONObject()
    private val rangeRetries = java.util.concurrent.atomic.AtomicInteger(0)
    private val fence = object : Runnable {
        override fun run() {
            if (closed) return
            if (!MediaPlayerBridge.isCurrent(lease)) closePlayer(6)
            else handler.postDelayed(this, 100)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        darkMode = intent.getBooleanExtra("darkMode", false)
        lease = intent.getStringExtra("lease") ?: ""
        val url = intent.getStringExtra("mediaUrl") ?: ""
        val uri = Uri.parse(url)
        // Exact native capability, not a free HTTP/file/open-intent gateway.
        if (uri.scheme != "http" || uri.host != "127.0.0.1" || uri.port !in 1..65535 ||
            uri.userInfo != null || uri.query != null || uri.fragment != null ||
            !lease.matches(Regex("[a-f0-9]{32}")) || uri.path != "/media/$lease") { finish(); return }
        val claimed = try {MediaPlayerBridge.attach(this, lease, url)} catch (_: UnsatisfiedLinkError) {false}
        if (!claimed) {finish(); return}
        attached = true
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (fullscreen) setFullscreen(false) else closePlayer(0)
            }
        })
        val canvas = Color.parseColor(if (darkMode) "#0a0a0c" else "#f1f2f5")
        val ink = Color.parseColor(if (darkMode) "#f0f0f2" else "#18191f")
        val root = FrameLayout(this).apply {setBackgroundColor(canvas)}
        mediaRoot = root
        // Target36 edge-to-edge and Android10 both keep controls clear of the
        // navigation area/cutout. This is native media only, not an IME layer.
        root.setOnApplyWindowInsetsListener { _, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val types = WindowInsets.Type.displayCutout() or if (fullscreen) 0 else WindowInsets.Type.systemBars()
                val bars = insets.getInsets(types)
                root.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                root.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        setContentView(root); root.requestApplyInsets()
        val layout = LinearLayout(this).apply {orientation = LinearLayout.VERTICAL; setBackgroundColor(canvas)}
        root.addView(layout, FrameLayout.LayoutParams(-1, -1))
        val bar = LinearLayout(this).apply {gravity = Gravity.CENTER_VERTICAL; setBackgroundColor(canvas)}
        chrome = bar
        val back = TextView(this).apply {
            text = "‹ 返回"; textSize = 16f; setTextColor(ink); gravity = Gravity.CENTER
            contentDescription = "返回素材"; setOnClickListener { closePlayer(0) }
        }
        bar.addView(back, LinearLayout.LayoutParams(dp(72), dp(56)))
        bar.addView(TextView(this).apply {
            text = intent.getStringExtra("title") ?: "视频"; textSize = 15f; setTextColor(ink)
            gravity = Gravity.CENTER_VERTICAL
            setSingleLine(); ellipsize = TextUtils.TruncateAt.END; setPadding(0, 0, dp(14), 0)
        }, LinearLayout.LayoutParams(0, dp(56), 1f))
        layout.addView(bar, LinearLayout.LayoutParams(-1, dp(56)))
        val playerView = PlayerView(this).apply {
            setBackgroundColor(Color.BLACK); setShutterBackgroundColor(Color.BLACK)
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            setShowNextButton(false); setShowPreviousButton(false)
            setShowFastForwardButton(true); setShowRewindButton(true)
            setKeepContentOnPlayerReset(false)
            setFullscreenButtonClickListener { isFullscreen -> setFullscreen(isFullscreen) }
        }
        view = playerView; layout.addView(playerView, LinearLayout.LayoutParams(-1, 0, 1f))
        applySystemBars()
        updateFullscreenButton()
        val http = DefaultHttpDataSource.Factory().setConnectTimeoutMs(10000).setReadTimeoutMs(30000)
            .setAllowCrossProtocolRedirects(false)
        val retry = object : DefaultLoadErrorHandlingPolicy(2) {
            override fun getRetryDelayMsFor(info: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
                // The constructor is only the propagation threshold, not a
                // maximum. Hard cap the whole Activity session at two retries;
                // keep the same capability/version, never a full-file fallback.
                if (closed || generateSequence<Throwable>(info.exception) {it.cause}.take(8).any {
                    it is HttpDataSource.InvalidResponseCodeException && it.responseCode in setOf(401, 403, 404, 410, 412, 416)
                }) return C.TIME_UNSET
                val delay = super.getRetryDelayMsFor(info)
                if (delay == C.TIME_UNSET) return delay // parser/range/cleartext failures stay fatal
                while (true) {
                    val used = rangeRetries.get()
                    if (used >= 2) return C.TIME_UNSET
                    if (rangeRetries.compareAndSet(used, used + 1)) return delay
                }
            }
            override fun getFallbackSelectionFor(options: LoadErrorHandlingPolicy.FallbackOptions, info: LoadErrorHandlingPolicy.LoadErrorInfo): LoadErrorHandlingPolicy.FallbackSelection? = null
        }
        val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(this, http)).setLoadErrorHandlingPolicy(retry)
        val load = DefaultLoadControl.Builder().setBufferDurationsMs(1000, 5000, 300, 1000)
            .setTargetBufferBytes(8 * 1024 * 1024).setPrioritizeTimeOverSizeThresholds(false).build()
        try {
            val p = ExoPlayer.Builder(this, DefaultRenderersFactory(this).setEnableDecoderFallback(true))
                .setMediaSourceFactory(sources).setLoadControl(load).build()
            player = p; playerView.player = p
            p.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            p.setHandleAudioBecomingNoisy(true)
            p.addListener(object : Player.Listener {
                override fun onRenderedFirstFrame() { MediaPlayerBridge.firstFrame(lease) }
                override fun onIsPlayingChanged(isPlaying: Boolean) { playerView.keepScreenOn = isPlaying }
                override fun onPlayerError(error: PlaybackException) {
                    // Only a finite canonical code crosses JNI. Never leak the
                    // loopback capability or upstream exception/headers to JS.
                    val reason = when (error.errorCode) {
                        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
                        PlaybackException.ERROR_CODE_DECODING_FAILED,
                        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
                        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
                        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED -> 3
                        in 2000..2999 -> 4
                        else -> 5
                    }
                    format.put("playerErrorCode", error.errorCode); closePlayer(reason)
                }
            })
            p.addAnalyticsListener(object : AnalyticsListener {
                override fun onVideoDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {format.put("videoDecoder", decoderName)}
                override fun onAudioDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {format.put("audioDecoder", decoderName)}
                override fun onVideoInputFormatChanged(eventTime: AnalyticsListener.EventTime, f: Format, decoderReuseEvaluation: DecoderReuseEvaluation?) {
                    format.put("videoMime", f.sampleMimeType).put("codecs", f.codecs).put("width", f.width).put("height", f.height)
                    format.put("containerMime", f.containerMimeType)
                    if (f.frameRate.isFinite() && f.frameRate > 0) format.put("frameRate", f.frameRate.toDouble())
                    f.colorInfo?.let {format.put("lumaBitdepth", it.lumaBitdepth).put("chromaBitdepth", it.chromaBitdepth)}
                }
                override fun onAudioInputFormatChanged(eventTime: AnalyticsListener.EventTime, f: Format, decoderReuseEvaluation: DecoderReuseEvaluation?) {
                    format.put("audioMime", f.sampleMimeType).put("channels", f.channelCount).put("sampleRate", f.sampleRate)
                }
                override fun onAudioPositionAdvancing(eventTime: AnalyticsListener.EventTime, playoutStartSystemTimeMs: Long) {format.put("audioAdvancing", true)}
            })
            p.setMediaItem(MediaItem.fromUri(uri))
            p.seekTo(intent.getLongExtra("position", 0).coerceAtLeast(0)); p.prepare(); p.play()
            handler.post(fence)
        } catch (_: Exception) { closePlayer(5) }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()

    private fun setFullscreen(value: Boolean) {
        if (closed || fullscreen == value) return
        if (value) restoreOrientation = requestedOrientation
        fullscreen = value
        chrome?.visibility = if (value) View.GONE else View.VISIBLE
        requestedOrientation = if (value) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else restoreOrientation
        updateFullscreenButton()
        applySystemBars()
        view?.showController()
        mediaRoot?.requestApplyInsets()
    }

    private fun updateFullscreenButton() {
        view?.setFullscreenButtonState(fullscreen)
        val description = if (fullscreen) "退出全屏" else "全屏播放"
        view?.findViewById<View>(androidx.media3.ui.R.id.exo_fullscreen)?.contentDescription = description
        view?.findViewById<View>(androidx.media3.ui.R.id.exo_minimal_fullscreen)?.contentDescription = description
    }

    @Suppress("DEPRECATION")
    private fun applySystemBars() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = if (fullscreen) Color.BLACK else Color.parseColor(if (darkMode) "#0a0a0c" else "#f1f2f5")
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.apply {
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                val appearance = if (!fullscreen && !darkMode) WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS else 0
                setSystemBarsAppearance(appearance, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
                if (fullscreen) hide(WindowInsets.Type.systemBars()) else show(WindowInsets.Type.systemBars())
            }
        } else {
            window.decorView.systemUiVisibility = if (fullscreen) View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                else if (!darkMode) View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR else 0
        }
    }
    fun closePlayer(reason: Int) {
        if (closed) return
        closed = true; handler.removeCallbacksAndMessages(null)
        if (fullscreen) requestedOrientation = restoreOrientation
        val p = player
        val position = p?.currentPosition?.coerceAtLeast(0) ?: 0
        val duration = p?.duration?.coerceAtLeast(0) ?: 0
        val actualReason = if (reason == 0 && p?.playbackState == Player.STATE_ENDED) 2 else reason
        // Detach surface, stop loading and release audio focus before the
        // product page can resume. Nothing survives Home/Back/destroy.
        view?.keepScreenOn = false; view?.player = null
        p?.pause(); p?.stop(); p?.release(); player = null; view = null
        format.put("rangeRetries", rangeRetries.get())
        if (attached) MediaPlayerBridge.closed(this, lease, position, duration, actualReason, format.toString())
        if (!isFinishing) finish()
    }
    override fun onPause() { player?.pause(); super.onPause() }
    override fun onStop() { closePlayer(1); super.onStop() }
    override fun onDestroy() { closePlayer(1); super.onDestroy() }
}
