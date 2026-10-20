import { systemBarScrim, systemBarUpdater } from "./services/systemBarAppearance";
import { useCallback, useEffect, useSyncExternalStore, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { api, type ConnState } from "./services/client";
import { syncCoordinator } from "./services/syncCoordinator";
import { KnowledgeLiveSync } from "./services/knowledgeLiveSync";
import { knowledgeChangeFeed, knowledgePermissionsChanged } from "./still/kit/knowledgeSession";
import { refreshConnectionStateOnDataCommit } from "./services/connectionStateRefresh";
import { localDataStore } from "./services/localDataStore";
import { shouldPublishInboxCommit } from "./services/shareIngest";
import { overlayStack } from "./services/overlayStack";
import { navigation, type Tab } from "./navigation";
import StillApp, { stillNav } from "./still/StillShell";
import { StillHealthRecovery } from "./still/StillSettings";

export { navigation };
export type { Tab };
const knowledgeLiveSync = new KnowledgeLiveSync(knowledgeChangeFeed, () => syncCoordinator.wake(), knowledgePermissionsChanged);

export default function App() {
  const [conn, setConn] = useState<ConnState | null>(null);
  const [ws, setWs] = useState<{ state: string; last_seq: number; current: string }>({
    state: "stopped",
    last_seq: 0,
    current: "",
  });
  // M2.7: bump when a share event lands so the Local Inbox list reloads.
  const [inboxTick, setInboxTick] = useState(0);
  void inboxTick;
  // FIX-V1 P1-3A: publish an Inbox commit ONLY when the ingest actually
  // consumed new shares — a focus/visibility reconciliation sweep with zero
  // new items and a failed ingest are NOT mutations and publish nothing.
  const ingestShares = useCallback(async () => {
    try {
      const r = await api.localInboxIngestShares();
      if (shouldPublishInboxCommit(r)) {
        localDataStore.publish("inbox");
        setInboxTick((t) => t + 1);
      }
    } catch {
      /* failed ingest publishes nothing; retried on the next event / next mount */
    }
  }, []);
  // M3-M1 Phase-B R1: Settings no longer renders live sync status — the
  // coordinator stays subscribed via trigger paths only.
  const route = useSyncExternalStore(
    (fn) => navigation.subscribe(fn),
    () => navigation.current()
  );
  void route; // the Still shell subscribes to the same authority itself

  const refresh = useCallback(async () => {
    try {
      const c = await api.connState();
      setConn(c);
      if (c.ws) setWs(c.ws);
    } catch {
      /* not ready */
    }
  }, []);

  useEffect(() => {
    const instance = conn?.paired ? conn.identity?.instanceId || "" : "";
    syncCoordinator.setOwner(instance);
    const retire = knowledgeLiveSync.bind(instance);
    if (instance) syncCoordinator.wake();
    return retire;
  }, [conn?.paired, conn?.identity?.instanceId]);

  useEffect(() => {
    if (!conn?.paired || ws.state !== "connected") return;
    syncCoordinator.trigger();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") syncCoordinator.trigger();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [conn?.identity?.instanceId, conn?.paired, ws.state]);

  // M3-M1 R2: an existing pairing reconnects by itself after the phone app
  // starts or returns to the foreground — the user should not have to open
  // 连接电脑 and tap 重新连接. Idempotent on the Rust side (already-running
  // returns immediately; an explicit 断开连接 is honoured and never
  // overridden; an unpaired device does nothing).
  const resumeConnection = useCallback(async () => {
    try {
      await api.connResume();
    } catch {
      /* transport/runtime unavailable — the manual 重新连接 action remains */
    }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let un1: (() => void) | undefined, un2: (() => void) | undefined, unShare: (() => void) | undefined, unFocus: (() => void) | undefined;
    let unBack: any;
    const unDataCommit = refreshConnectionStateOnDataCommit(refresh);
    (async () => {
      un1 = await listen("lr:ws-status", (e) => {
        const v = e.payload as any;
        setWs((p) => ({ ...p, state: v.state, last_seq: v.last_seq }));
        refresh();
        if (v.state === "connected") syncCoordinator.trigger(); // WS reconnect -> sync
      });
      un2 = await listen("lr:ws-event", (e) => {
        const v = e.payload as any;
        setWs((p) => ({ ...p, last_seq: v.seq, current: v.type }));
      });
      // M2.7: a warm-resume share written a share-*.meta.json -> ingest it and
      // tell every screen the Local Inbox changed.
      unShare = await listen("lr:local-share", async () => {
        await ingestShares();
        setInboxTick((t) => t + 1);
      });
      // M2.7: when the activity regains focus (e.g. returning from the system
      // share sheet) the lr:local-share event may have been delivered before
      // the WebView was ready and got lost. Re-ingest is idempotent by share
      // digest, so a focus-triggered sweep closes that gap safely.
      unFocus = await listen("tauri://focus", async () => {
        await ingestShares();
        setInboxTick((t) => t + 1);
      });
      // M2.7 cold start: ingest shares that arrived before the WebView was up.
      await ingestShares();
      // M3-M1 R2: cold start resumes an existing pairing without a manual tap.
      void resumeConnection();
      // Official Android back-button handling (Tauri 2).
      unBack = await onBackButtonPress(() => {
        // A note editor with unsaved work consumes BACK first (same contract
        // as before — it preventDefaults and runs its own guarded exit).
        if (!window.dispatchEvent(new Event("luckyray:desktop-note-back", {cancelable: true}))) return;
        // A modal sheet/dialog consumes BACK before any navigation: closing the
        // overlay is always the least surprising result.
        if (overlayStack.dismissTop()) return;
        // MATERIAL-LIBRARY-INSTANT-R1 R7 (三): an active multi-select consumes
        // BACK before any navigation — exiting the selection is less surprising
        // than leaving the page. When no selection is active the event is not
        // preventDefaulted and the pipeline continues unchanged.
        if (!window.dispatchEvent(new Event("luckyray:selection-back", {cancelable: true}))) return;
        // The Still shell runs the animated page exit; at the home root with
        // no layers it reports false and normal Android task semantics apply.
        if (stillNav.back()) return;
        void api.moveTaskToBack();
      });
    })();
    void refresh();
    // M2.7: the WebView becomes visible whenever the activity resumes (e.g.
    // after the system share sheet). On Android this is the reliable signal
    // that a just-delivered share can be ingested, even if its event arrived
    // before the WebView was ready. Idempotent by share digest.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void ingestShares();
        setInboxTick((t) => t + 1);
        // M3-M1 R2: a phone returning to the foreground (or waking from a
        // doze-killed socket) re-establishes the existing pairing. The manual
        // 断开连接 opt-out still vetoes this on the Rust side.
        void resumeConnection();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      un1?.();
      un2?.();
      unShare?.();
      unFocus?.();
      unBack?.unlisten?.();
      unDataCommit();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, resumeConnection]);

  // Local-data health gate: if the SQLite schema is not at the expected version
  // (interrupted migration / corrupted db), render the recovery page instead of
  // a silent white screen. Retry re-runs migrations (forward-only, transactional).
  const [health, setHealth] = useState<{ ok: boolean; schemaVersion: number; expectedVersion: number; tablesOk: boolean } | null>(null);
  const [healthError, setHealthError] = useState<string>("");

  const checkHealth = useCallback(async () => {
    try {
      const h = await api.dbHealth();
      setHealth(h);
      setHealthError("");
    } catch (e: any) {
      setHealthError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  // `100dvh` is not implemented by the MI 8's Android System WebView 83.
  // Keep the app shell tied to the visual viewport so the shell matches the
  // visible area, while CSS still supplies 100vh/100dvh fallbacks for newer
  // engines.
  //
  // STABILITY-FIX-R1(B): the keyboard is NO LONGER estimated here. On Android,
  // MainActivity pads the content root by max(system bars/cutout, ime) and is
  // the single IME layout authority, so the web layer just lays out inside the
  // already-shrunk viewport. A second web-side estimator would stack on top of
  // that padding and double the offset.
  useEffect(() => {
    const visualViewport = window.visualViewport;
    const updateViewportHeight = () => {
      const height = Math.round(visualViewport?.height ?? window.innerHeight);
      document.documentElement.style.setProperty("--app-viewport-h", `${height}px`);
    };

    updateViewportHeight();
    visualViewport?.addEventListener("resize", updateViewportHeight);
    window.addEventListener("resize", updateViewportHeight);
    return () => {
      visualViewport?.removeEventListener("resize", updateViewportHeight);
      window.removeEventListener("resize", updateViewportHeight);
      document.documentElement.style.removeProperty("--app-viewport-h");
    };
  }, []);

  // INTERACTION-CLOSURE-R1 (P1): page-level pinch zoom is forbidden. The
  // viewport meta locks modern WebViews; WebView83 builds may still honor
  // multi-finger scale, so gesture events on the shell are blocked unless the
  // target explicitly opts in via [data-media-zoom-layer] (asset image only).
  // OS-level accessibility magnification is NOT affected (different pathway).
  useEffect(() => {
    const blockShellPinch = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-media-zoom-layer]")) return;
      e.preventDefault();
    };
    // passive:false is required for preventDefault to take effect.
    document.addEventListener("touchmove", blockShellPinch, { passive: false });
    return () => document.removeEventListener("touchmove", blockShellPinch);
  }, []);

  // INTERACTION-CLOSURE-R1 (P1): presentation-only editing state. When a text
  // field gains focus, the Still shell sets data-text-entry on .st-app so the
  // dock/compose action HIDE immediately — the native IME animation cannot
  // drag their absolutely-positioned layers into mid-screen. This decides
  // VISIBILITY ONLY — it never estimates or publishes any keyboard height
  // (native insets remain the sole IME geometry authority).
  //
  // STILL-01.1-USER-QA-FIX-R1: focusin/focusout alone is not enough — after
  // the system keyboard closes, Android may KEEP the input focused, so the
  // dock stayed hidden until the user tapped elsewhere. The visualViewport
  // resize event is used here strictly as a ONE-BIT "keyboard is now closed"
  // lifecycle signal (a significant height GROWTH): it clears the flag, never
  // writes any geometry, and adds no second inset authority. Search text and
  // caret stay; tapping the still-focused input reopens the IME and the dock
  // hides again via focusin.
  const [editingText, setEditingText] = useState(false);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) {
        setEditingText(true);
      }
    };
    const onFocusOut = () => {
      // Defer: focus may move between fields (search -> clear button).
      window.setTimeout(() => {
        const a = document.activeElement;
        const stillEditing = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ||
          (a instanceof HTMLElement && a.isContentEditable);
        if (!stillEditing) setEditingText(false);
      }, 60);
    };
    // One-bit IME lifecycle signal with HYSTERESIS, anchored to the viewport
    // height at which the keyboard is CLOSED (`closedViewportHeight`):
    //  - h falling ≥60px below it  -> keyboard open  -> dock hidden while a
    //    real text field holds focus (covers re-taps of a focused input,
    //    which fire no focusin);
    //  - h returning to within 60px of it -> keyboard closed -> dock restored
    //    even if the input never lost focus (the original complaint).
    //
    // Why hysteresis instead of comparing consecutive resize events: several
    // keyboards (14U screenshot) animate the inset with an overshoot — a
    // >60px GROWTH arrives right after the shrink. A naive "grew -> closed"
    // rule un-hides the dock mid-animation, which is exactly the dock-above-
    // keyboard the user filmed. Bounces while open never reach the close
    // branch because they stay far below the stable height. This stays a
    // pure VISIBILITY signal: no geometry is read or written, and native
    // WindowInsets remain the only IME geometry authority.
    let closedViewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const onViewportResize = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      if (h < closedViewportHeight - 60) {
        const a = document.activeElement;
        if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || (a instanceof HTMLElement && a.isContentEditable)) {
          setEditingText(true);
        }
      } else if (h >= closedViewportHeight - 60) {
        closedViewportHeight = h;
        setEditingText(false);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    window.addEventListener("resize", onViewportResize);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      window.removeEventListener("resize", onViewportResize);
    };
  }, []);

  // INTERACTION-CLOSURE-R1 (用户问题1): keep the Android system-bar VISUAL
  // appearance in sync with the color mode (light -> light bar with dark
  // icons; dark -> dark bar with light icons). Presentation only — the
  // approved native inset geometry is never touched here.
  useEffect(() => {
    const updater = systemBarUpdater(api.setSystemBarAppearance);
    const apply = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      updater.request(dark, systemBarScrim.active());
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const release = systemBarScrim.subscribe(apply);
    return () => { release(); observer.disconnect(); updater.dispose(); };
  }, []);

  // Android System WebView 83 does not reliably scroll a nested flex scroller
  // when an IME focuses an input, even with ADJUST_RESIZE.  Bring any editor
  // control into the visible portion of the shell after the IME settles.
  useEffect(() => {
    const revealFocusedControl = (event: FocusEvent) => {
      const target = event.target;
      const isEditor = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (!isEditor) return;
      window.setTimeout(() => {
        target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      }, 160);
    };

    document.addEventListener("focusin", revealFocusedControl);
    return () => document.removeEventListener("focusin", revealFocusedControl);
  }, []);

  if (health && !health.ok) {
    return (
      <StillHealthRecovery
        health={health}
        onRetry={() => {
          setHealth(null);
          checkHealth();
        }}
        onExportDiagnostics={() => {
          api.dbExportDiagnostics().catch(() => {
            /* diagnostics write is best-effort */
          });
        }}
        onResetLocalData={() => {
          api.dbResetFull()
            .then(() => {
              setHealth(null);
              checkHealth();
            })
            .catch((e: any) => setHealthError(e?.message ?? String(e)));
        }}
      />
    );
  }
  if (healthError) {
    return (
      <StillHealthRecovery
        health={null}
        onRetry={checkHealth}
        onExportDiagnostics={() => {
          api.dbExportDiagnostics().catch(() => { /* best-effort */ });
        }}
        onResetLocalData={() => {
          api.dbResetFull()
            .then(() => {
              setHealth(null);
              setHealthError("");
              checkHealth();
            })
            .catch((e: any) => setHealthError(e?.message ?? String(e)));
        }}
      />
    );
  }

  // STILL-01.1: the Still component tree is the ONLY visible presentation.
  // The legacy screens under src/screens/ are rollback/business-logic sources
  // and never render here.
  return <StillApp conn={conn} editingText={editingText} />;
}
