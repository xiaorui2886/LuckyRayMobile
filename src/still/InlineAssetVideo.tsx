import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../services/client";
import { usePageCurrent } from "../presentation/still01/PageLayer";
import { overlayStack } from "../services/overlayStack";
import { openInlineMediaLease, type MediaGrant } from "./kit/inlineMediaLease";
import { boundedSeek, mediaTime, PLAYBACK_RATES } from "./kit/inlineVideoControls";

function PlayerIcon({ name }: { name: "play" | "pause" | "volume" | "muted" | "expand" | "collapse" | "back" }) {
  const paths = { play: 'm9 5 11 7-11 7z', pause: 'M8 5v14M16 5v14', volume: 'M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14', muted: 'M11 5 6 9H3v6h3l5 4zM16 9l5 6m0-6-5 6', expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5', collapse: 'M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5', back: 'm14 5-7 7 7 7' };
  return <svg viewBox="0 0 24 24" width="22" height="22" fill={name === "play" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

/** One owner-bound lease; presentation controls never replace the transport/codec fallback. */
export function InlineAssetVideo({ localPath, owner, library, id, poster, onFallback, onFullscreenChange }: {
  localPath?: string; owner?: string; library?: string; id: string; poster?: string; onFallback?: () => void; onFullscreenChange?: (value: boolean) => void;
}) {
  const current = usePageCurrent();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(false);
  const [playable, setPlayable] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [controls, setControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [activity, setActivity] = useState(0);
  const player = useRef<HTMLVideoElement>(null), frame = useRef<HTMLDivElement>(null);
  const seeking = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const element = player.current;
    setError(""); setUrl(""); setReady(false); setPlayable(false); setWaiting(false); setPlaying(false); setTime(0); setDuration(0); setBuffered(0); setControls(true); seeking.current = false; setFullscreen(false);
    const jobId = `inline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const retire = openInlineMediaLease({
      cached: () => owner ? api.contentMediaSource(owner, id, undefined, undefined, library) : api.localAssetMediaSource(id),
      stream: () => owner ? invoke<MediaGrant>("content_media_stream", { instance: owner, id, jobId, library }) : Promise.reject(new Error("CONTENT_NOT_CACHED")),
      release: api.contentMediaRelease, cancel: () => api.contentCancel(jobId), ready: setUrl,
      failed: failure => setError(/401|403|REVOKED|GRANT_REQUIRED|FORBIDDEN/.test(String(failure)) ? "无法读取视频，请检查电脑连接与授权。" : "暂时无法读取视频，请重试。"),
    });
    return () => { element?.pause(); element?.removeAttribute("src"); element?.load(); retire(); };
  }, [owner, library, id, localPath, retry]);
  useEffect(() => {
    if (!current) { player.current?.pause(); setFullscreen(false); if (document.fullscreenElement === frame.current) void document.exitFullscreen?.().catch(() => {}); }
  }, [current]);
  useEffect(() => {
    onFullscreenChange?.(fullscreen);
    if (!fullscreen) return;
    const close = () => { setFullscreen(false); if (document.fullscreenElement === frame.current) void document.exitFullscreen?.().catch(() => {}); };
    const release = overlayStack.push(close);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", key);
    const element = frame.current;
    return () => { release(); document.removeEventListener("keydown", key); onFullscreenChange?.(false); if (element && document.fullscreenElement === element) void document.exitFullscreen?.().catch(() => {}); };
  }, [fullscreen, onFullscreenChange]);
  useEffect(() => {
    const changed = () => { if (!document.fullscreenElement) setFullscreen(false); };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!playing || !controls || seeking.current || fullscreen && !current) return;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      let keyboardFocus = false;
      if (active && frame.current?.contains(active)) {
        // Older Android WebViews do not understand :focus-visible.
        try { keyboardFocus = active.matches(":focus-visible"); } catch { keyboardFocus = true; }
      }
      if (!keyboardFocus && !seeking.current) setControls(false);
    }, 2800);
    return () => clearTimeout(timer);
  }, [playing, controls, activity, fullscreen, current]);
  const play = async () => {
    if (!player.current || !url || !current) return;
    try { await player.current.play(); } catch { if (alive.current) { setControls(true); setPlaying(false); } }
  };
  const togglePlay = () => { if (player.current?.paused) void play(); else player.current?.pause(); setControls(true); };
  const toggleFullscreen = async () => {
    if (fullscreen) { setFullscreen(false); if (document.fullscreenElement === frame.current) await document.exitFullscreen?.().catch(() => {}); return; }
    // Android WebView may not implement requestFullscreen. In-place immersive
    // mode is always available and does not hand off to another player/page.
    setFullscreen(true); setControls(true);
    try { await frame.current?.requestFullscreen?.(); } catch { /* retain in-place immersive mode */ }
  };
  const seek = (value: string) => { const target = boundedSeek(Number(value), duration); if (player.current) player.current.currentTime = target; setTime(target); setControls(true); };
  const controlsHidden = !controls && playing;
  return <div ref={frame} className={"st-inline-video" + (fullscreen ? " is-fullscreen" : "") + (!controls && playing ? " is-controls-hidden" : "")} data-video-player="true" data-gesture-owner="media" aria-label="视频播放器" onPointerDown={event => { if ((event.target as Element).closest('button,input,select')) event.stopPropagation(); }}>
    <video ref={player} src={url || undefined} poster={poster} playsInline preload="metadata" className={ready ? "is-ready" : ""}
      onClick={() => setControls(value => !value)}
      onLoadedMetadata={() => { setPlayable(true); setDuration(Number.isFinite(player.current?.duration) ? player.current!.duration : 0); if (player.current) { player.current.muted = muted; player.current.playbackRate = rate; } }}
      onLoadedData={() => setReady(true)}
      onCanPlay={() => { setPlayable(true); setReady(true); setWaiting(false); }}
      onProgress={() => { const video = player.current; if (!video?.buffered.length) return; try { setBuffered(video.buffered.end(video.buffered.length - 1)); } catch { /* source changed between progress events */ } }}
      onTimeUpdate={() => { if (!seeking.current) setTime(player.current?.currentTime || 0); }}
      onDurationChange={() => setDuration(Number.isFinite(player.current?.duration) ? player.current!.duration : 0)}
      onPlay={() => { setPlaying(true); setControls(true); }} onPause={() => { setPlaying(false); setControls(true); }} onEnded={() => { setPlaying(false); setControls(true); }}
      onWaiting={() => setWaiting(true)} onPlaying={() => setWaiting(false)}
      onError={() => { if (url) { setError("这段视频无法内嵌播放，可以使用本机播放器。"); setPlaying(false); } }} />
    {((!ready && !playable) || waiting) && !error ? <div className="st-video-wait" role="status" aria-label="正在准备视频"><span className="st-video-spinner" /><span className="st-sr-only">正在准备视频</span></div> : null}
    {!error && playable && !playing ? <button className="st-video-central" type="button" aria-label="播放视频" onClick={() => void play()}><PlayerIcon name="play" /></button> : null}
    {error ? <div className="st-inline-video-error" role="status"><p>{error}</p><div><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button>{onFallback ? <button type="button" onClick={onFallback}>使用本机播放器</button> : null}</div></div> : null}
    <div className="st-video-controls" aria-hidden={!controls && playing ? true : undefined} onPointerDown={event => { event.stopPropagation(); setActivity(value => value + 1); }}>
      {fullscreen ? <button tabIndex={controlsHidden ? -1 : 0} type="button" className="st-video-return" aria-label="退出全屏" onClick={() => void toggleFullscreen()}><PlayerIcon name="back" /></button> : null}
      <div className="st-video-control-row">
        <button tabIndex={controlsHidden ? -1 : 0} type="button" aria-label={playing ? "暂停视频" : "播放视频"} disabled={!playable || !!error} onClick={togglePlay}><PlayerIcon name={playing ? "pause" : "play"} /></button>
        <span className="st-video-time">{mediaTime(time)}<span> / {mediaTime(duration)}</span></span>
        <button tabIndex={controlsHidden ? -1 : 0} type="button" aria-label={muted ? "开启声音" : "静音"} aria-pressed={muted} onClick={() => { const next = !muted; setMuted(next); if (player.current) player.current.muted = next; }}><PlayerIcon name={muted ? "muted" : "volume"} /></button>
        <select tabIndex={controlsHidden ? -1 : 0} aria-label="播放速度" value={rate} onChange={event => { const next = Number(event.target.value); setRate(next); if (player.current) player.current.playbackRate = next; }}>{PLAYBACK_RATES.map(value => <option key={value} value={value}>{value}×</option>)}</select>
        <button tabIndex={controlsHidden ? -1 : 0} type="button" aria-label={fullscreen ? "退出全屏" : "全屏播放"} aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}><PlayerIcon name={fullscreen ? "collapse" : "expand"} /></button>
      </div>
      <input tabIndex={controlsHidden ? -1 : 0} className="st-video-seek" style={{ backgroundImage: `linear-gradient(to right, var(--st-accent) 0%, var(--st-accent) ${duration > 0 ? Math.min(100, time / duration * 100) : 0}%, rgba(255,255,255,.55) ${duration > 0 ? Math.min(100, time / duration * 100) : 0}%, rgba(255,255,255,.55) ${duration > 0 ? Math.min(100, buffered / duration * 100) : 0}%, rgba(255,255,255,.22) ${duration > 0 ? Math.min(100, buffered / duration * 100) : 0}%, rgba(255,255,255,.22) 100%)` }} aria-label="播放进度" aria-valuetext={`${mediaTime(time)} / ${mediaTime(duration)}`} type="range" min="0" max={duration || 0} step="0.1" value={Math.min(time, duration || 0)} disabled={!playable || duration <= 0 || !!error} onPointerDown={event => { seeking.current = true; setControls(true); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* older WebView */ } }} onPointerUp={() => { seeking.current = false; setActivity(value => value + 1); }} onPointerCancel={() => { seeking.current = false; setActivity(value => value + 1); }} onLostPointerCapture={() => { seeking.current = false; setActivity(value => value + 1); }} onBlur={() => { seeking.current = false; setActivity(value => value + 1); }} onChange={event => seek(event.target.value)} />
    </div>
  </div>;
}
