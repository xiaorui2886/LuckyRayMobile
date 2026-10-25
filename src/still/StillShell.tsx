import { managedVault, managedNoteRoute, parseManagedNoteRoute } from "../services/managedVault";
import "./kit/rootSwipe.css";
import { RootSwipeContext, ROOT_SWIPE_TABS, rootSwipeTarget, useHorizontalSwipe, type SwipeDirection } from "./kit/useHorizontalSwipe";
import { LocalNoteImportBridge } from "./kit/LocalNoteImportBridge";
import type { NoteHeadingIntent } from "./kit/useNoteHeadingNavigation";
// STILL-01.1 parity rebuild — production shell.
//
// The .st-app tree is the ONLY visible presentation in this build: every
// authority scenario renders the Still component tree (ui/Still.tsx +
// ui/Views.tsx, source-identical copies). The legacy screens under
// src/screens/ remain in the repo as rollback/business-logic sources but are
// never rendered here.
//
// Authorities keep their roles: NavigationController stays the single
// navigation authority (this shell only DERIVES a view-layer page stack from
// its snapshot), overlayStack owns dismissible layers, toastStore owns
// feedback, and native insets stay the only IME geometry authority
// (data-text-entry decides VISIBILITY of the dock/compose action only — it
// never estimates a keyboard height).
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HomeCapture, TabBar, type Root } from "../presentation/still01/Still";
import { PageLayer } from "../presentation/still01/PageLayer";
import "../presentation/still01/still.css";
import { navigation, type Route } from "../navigation";
import { overlayStack } from "../services/overlayStack";
import { applyColorMode, readColorMode } from "../services/appearance";
import { api, type ConnState } from "../services/client";
import { localDataStore } from "../services/localDataStore";
import { failureCopy } from "../services/feedback";
import { toast, toastStore } from "../services/toast";
import { StillHome } from "./StillHome";
import { StillLibrary } from "./StillLibrary";
import { StillKnowledge } from "./StillCollection";
import { StillAgent, StillRun } from "./StillAgent";
import {
  StillSettingsRoot, StillPreferences, StillAppearance, StillStorage,
  StillDiagnostics, StillRecoveryPage, StillInboxPage,
} from "./StillSettings";
import { StillConnect } from "./StillConnect";
import { StillCapture } from "./StillCapture";
import { StillInboxDetail } from "./StillInbox";
import { StillAsset, type AssetPreview } from "./StillAsset";
import { StillSearch } from "./StillSearch";
import type { NoteSearchTarget } from "./kit/noteSearch";
import { StillNote, StillNewNote } from "./StillNote";
import { stillScene, NOTE_EDIT_PREFIX, type Scene } from "./stillScene";

import "./kit/knowledgeActions.css";
import "../presentation/still01/defaultTheme.css";
import "./kit/librarySurfaces.css";

const ROOT_TABS: readonly string[] = ROOT_SWIPE_TABS;

export type StillNav = {
  conn: ConnState | null;
  open: (page: string, id?: string, opts?: { edit?: boolean; assetPreview?: AssetPreview; noteHeading?: NoteHeadingIntent; noteSearch?: NoteSearchTarget; linked?: boolean }) => void;
  back: () => void;
  registerOverlay: (d: () => void) => () => void;
  mode: "light" | "dark";
  setMode: (m: "light" | "dark") => void;
  reduced: boolean;
  setReduced: (v: boolean) => void;
};

const StillNavContext = createContext<StillNav | null>(null);
export function useStillNav(): StillNav {
  const v = useContext(StillNavContext);
  if (!v) throw new Error("Still screens require the StillNav provider");
  return v;
}

/** Back coordinator handed to the App shell's Android back chain. */
export const stillNav = { back: (): boolean => false };

const REDUCED_KEY = "still.reduced";

export default function StillApp({ conn, editingText }: { conn: ConnState | null; editingText: boolean }) {
  const route = useSyncExternalStore(
    (fn) => navigation.subscribe(fn),
    () => navigation.current()
  );
  void route; // subscription only; the stack is read below
  const stack = navigation.snapshot();
  const rootTab = (stack[0]?.tab ?? "home") as Root;
  const [mode, setModeState] = useState<"light" | "dark">(readColorMode);
  const [reduced, setReducedState] = useState(() => {
    try { return localStorage.getItem(REDUCED_KEY) === "true"; } catch { return false; }
  });
  const [lshIme, setLshIme] = useState(false);
  useEffect(() => {
    const onIme = (event: Event) => setLshIme((event as CustomEvent).detail?.active === true);
    window.addEventListener("luckyray-lsh-ime", onIme);
    return () => window.removeEventListener("luckyray-lsh-ime", onIme);
  }, []);
  const [entered, setEntered] = useState(true);
  const [maskedKey, setMaskedKey] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const navigating = useRef(false);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitKey = useRef<number | null>(null);
  const returnKey = useRef<number | null>(null);
  const appRef = useRef<HTMLDivElement>(null);
  // Only the materials root is retained, after its first visit. Its existing
  // pagers/session own the state; do not invent another root snapshot cache.
  const libraryVisited = useRef(false);
  const agentVisited = useRef(false);
  if (rootTab === "ai") agentVisited.current = true;
  if (rootTab === "library") libraryVisited.current = true;

  // Pages above the root, in stack order. Pure derivation — nothing here
  // creates, pops or rewrites history.
  const [, refreshAssetPreview] = useState(0);
  const assetPreviews = useRef(new WeakMap<Route, AssetPreview>());
  const noteHeadings = useRef(new WeakMap<Route, NoteHeadingIntent>());
  const noteSearches = useRef(new WeakMap<Route, NoteSearchTarget>());
  const [, refreshNoteIntent] = useState(0);
  const pages: (Scene & { assetPreview?: AssetPreview; noteHeading?: NoteHeadingIntent; noteSearch?: NoteSearchTarget })[] = [];
  for (let i = 1; i < stack.length; i++) {
    const r = stack[i];
    const key = routeKey(r);
    const scene = stillScene(r, key);
    if (scene) pages.push({ ...scene, assetPreview: assetPreviews.current.get(r), noteHeading: noteHeadings.current.get(r), noteSearch: noteSearches.current.get(r) });
  }
  const top = pages[pages.length - 1];

  const setMode = (m: "light" | "dark") => { applyColorMode(m); setModeState(m); };
  const setReduced = (v: boolean) => {
    setReducedState(v);
    try { localStorage.setItem(REDUCED_KEY, String(v)); } catch { /* session-only */ }
  };

  // Enter animation for a freshly pushed page (double rAF, as the authority
  // demo does); a Back reveal re-enters without the animation.
  useEffect(() => {
    if (top && returnKey.current === top.key) {
      returnKey.current = null;
      setEntered(true);
      setLeaving(false);
      return;
    }
    setEntered(false);
    setLeaving(false);
    let r2 = 0;
    const r = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setEntered(true)); });
    return () => { cancelAnimationFrame(r); cancelAnimationFrame(r2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top?.key]);

  // Retain the underlay for navigation/scroll, but stop its paint once the
  // opaque top page has arrived. Old WebView can otherwise composite retained
  // list text above an asynchronously repainted asset image. Back reveals it
  // immediately; masking never changes the navigation or list authority.
  useEffect(() => {
    if (!top || !entered) return;
    const key = top.key;
    const reduce = reduced || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setMaskedKey(key), reduce ? 1 : 300);
    return () => clearTimeout(timer);
  }, [top?.key, entered, reduced]);
  const maskUnderlay = !!top && maskedKey === top.key && !leaving;

  useEffect(() => () => { if (navTimer.current) clearTimeout(navTimer.current); }, []);

  // Still 01.1 density axis, derived exactly as the authority demo does:
  // compact ≤ 360, wide ≥ 520, regular in between.
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      el.dataset.density = w <= 360 ? "compact" : w >= 520 ? "wide" : "regular";
    };
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener("resize", update);
    return () => { ro?.disconnect(); window.removeEventListener("resize", update); };
  }, []);

  function finishBack() {
    if (exitKey.current === null) return; // transitionend after the timer fallback
    exitKey.current = null;
    if (navTimer.current) clearTimeout(navTimer.current);
    setLeaving(false);
    navigating.current = false;
    returnKey.current = top?.key ?? null;
    navigation.goBack();
  }

  /** Animated Back for a pushed page; plain goBack for a non-home root.
   *  Returns false at the home root with no layers (system fallback). */
  function back(): boolean {
    if (navigating.current) return true;
    if (top) {
      navigating.current = true;
      exitKey.current = top.key;
      setLeaving(true);
      const reduce = reduced || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      navTimer.current = setTimeout(finishBack, reduce ? 1 : 340);
      return true;
    }
    // Only root pages may consume directory Back; pushed editors retain their guarded exit.
    if (!window.dispatchEvent(new Event("luckyray:directory-back", { cancelable: true }))) return true;
    return navigation.goBack();
  }

  // Hand the guarded Back to the App shell's Android handler.
  useEffect(() => {
    stillNav.back = () => back();
    return () => { stillNav.back = () => false; };
  });

  const openGeneration = useRef(0);
  const open = (page: string, id?: string, opts?: { edit?: boolean; assetPreview?: AssetPreview; noteHeading?: NoteHeadingIntent; noteSearch?: NoteSearchTarget; linked?: boolean }, aliasChecked = false) => {
    const generation = ++openGeneration.current;
    if (page === "note" && id && !parseManagedNoteRoute(id) && !aliasChecked) {
      const origin = navigation.current();
      let retired = false;
      const stopWatching = navigation.subscribe(() => { if (navigation.current() !== origin) retired = true; });
      void managedVault.resolveLegacy(id).then(target => {
        if (retired || generation !== openGeneration.current) return;
        open(page, target ? managedNoteRoute(target.localVaultId, target.noteId) : id, opts, true);
      }, () => { if (!retired && generation === openGeneration.current) toast.error("暂时无法确认笔记位置，请重试。原有内容未改变。"); }).finally(stopWatching);
      return;
    }
    if (ROOT_TABS.includes(page)) {
      navigation.switchRoot(page as Route["tab"]);
      return;
    }
    if (page === "search") { navigation.openSearch(); return; }
    if (page === "capture") { navigation.pushScreen("capture"); return; }
    // Content details opened from a root other than their owner PRESERVE the
    // initiating root (the origin), so Back returns to wherever the user
    // actually was: Home -> note -> Back = Home, Library -> asset stays
    // Library, Knowledge -> note stays Knowledge (UX-POLISH-R1 §1.3).
    // A detail opened from an open Search overlay keeps SEARCH as its parent
    // (REPAIR-R1 P2-N1): the NavigationController pushes on top of the search
    // layer, so Back returns to the results — never skips to the root. The
    // no-originRoot case cannot express that, so it is skipped here.
    const searchParent = navigation.current().tab === "search";
    const origin = searchParent
      ? undefined
      : ROOT_TABS.includes(rootTab) ? (rootTab as Route["tab"]) : undefined;
    if (page === "note") {
      // R4 (C): an existing note opens DIRECTLY EDITABLE — "直接可编辑" means
      // the editor is editable without a first toggle; the keyboard is NOT
      // forced (fields focus per their own UX). opts.edit === false is the
      // explicit read-mode escape hatch; every ordinary entry omits opts.
      // A search result is a reading intent even when the ordinary note-open
      // default is editable. Input still starts only from an explicit tap.
      const editable = (opts?.noteSearch?.query || opts?.noteHeading) ? false : opts?.edit !== false;
      navigation.pushDetail({ tab: "knowledge", detail: (editable ? NOTE_EDIT_PREFIX : "") + (id || "") }, { originRoot: origin, retainDetail: opts?.linked });
      // An explicit newer open/search supersedes any pending old heading.
      // Back does not use open(), so retained-page position is left alone.
      if (!opts?.noteHeading && noteHeadings.current.has(navigation.current())) {
        noteHeadings.current.delete(navigation.current());
        refreshNoteIntent(version => version + 1);
      }
      if (opts?.noteSearch?.query) {
        noteSearches.current.set(navigation.current(), { ...opts.noteSearch });
        // Reusing the CURRENT route preserves its React key, so the external
        // store's current-reference snapshot alone cannot redraw new metadata.
        refreshNoteIntent(version => version + 1);
      }
      if (opts?.noteHeading) {
        noteHeadings.current.set(navigation.current(), { ...opts.noteHeading });
        noteSearches.current.delete(navigation.current());
        refreshNoteIntent(version => version + 1);
      }
      return;
    }
    if (page === "new-note") {
      // R4 (C): an ordinary create goes STRAIGHT into the new note in edit
      // mode — no decorative "新的想法" intermediary. (The deep-link route
      // knowledge/detail="new" still renders StillNewNote for restored
      // navigation state; ordinary product flow never sees it.)
      if (creatingNoteRef.current) return; // one bounded single-flight owner
      creatingNoteRef.current = true;
      const creatingOrigin = navigation.current();
      let retired = false;
      const stopWatching = navigation.subscribe(() => {
        if (navigation.current() !== creatingOrigin) retired = true;
      });
      void (async () => {
        try {
          const vaults = await managedVault.list();
          const selected = vaults.items.find(vault => vault.localVaultId === vaults.selectedVaultId && vault.migrationState === "ready");
          if (!selected && vaults.items.some(vault => vault.migrationState === "ready")) throw Error("请先在笔记中选择一个知识库。");
          const note = selected ? await managedVault.create(selected.localVaultId, "新笔记", "") : await api.localNoteAdd("新笔记", "", []);
          const route = selected ? managedNoteRoute(selected.localVaultId, note.noteId) : note.noteId;
          if (selected) window.dispatchEvent(new Event("luckyray:managed-vault-change"));
          else localDataStore.publish("note");
          // The durable note remains saved; a covered/retired origin no
          // longer owns navigation or an automatic entry into editing.
          if (retired || navigation.current() !== creatingOrigin || navigating.current) return;
          navigation.pushDetail({ tab: "knowledge", detail: NOTE_EDIT_PREFIX + route }, { originRoot: origin });
        } catch (e: any) {
          toast.error(failureCopy(e, "新建笔记失败。"));
        } finally {
          stopWatching();
          creatingNoteRef.current = false;
        }
      })();
      return;
    }
    if (page === "asset") {
      navigation.pushDetail({ tab: "library", detail: id || "" }, { originRoot: origin });
      if (opts?.assetPreview) {
        assetPreviews.current.set(navigation.current(), opts.assetPreview);
        // Navigation can publish synchronously; metadata must trigger its own render.
        refreshAssetPreview(version => version + 1);
      }
      return;
    }
    if (page === "run") { navigation.pushDetail({ tab: "ai", detail: id || "" }, { originRoot: origin }); return; }
    if (page === "inbox-detail") {
      const owner = (ROOT_TABS.includes(rootTab) ? rootTab : "settings") as Route["tab"];
      navigation.pushDetail({ tab: owner, detail: "entry:" + (id || "") });
      return;
    }
    // Settings-family pages attach to the CURRENT root, so Back returns to
    // wherever the user actually was (the authority demo's behaviour).
    const owner = (ROOT_TABS.includes(rootTab) ? rootTab : "settings") as Route["tab"];
    const detail = page === "connect" ? "connect-computer" : page;
    navigation.pushDetail({ tab: owner, detail });
  };

  // R4 (C): one bounded owner preventing a double-tap from creating two
  // notes (the async create window).
  const creatingNoteRef = useRef(false);

  const nav: StillNav = {
    conn, open,
    back: () => { back(); },
    registerOverlay: (dismiss) => overlayStack.push(dismiss),
    mode, setMode, reduced, setReduced,
  };

  const currentRootRoute = () => navigation.current() === stack[0] && navigation.snapshot().length === 1;
  const canSwipeRoot = () => currentRootRoute() && !top && !editingText && !lshIme && !overlayStack.depth() && !navigating.current;
  const navigateRootSwipe = (direction: SwipeDirection) => {
    if (!canSwipeRoot()) return;
    const next = rootSwipeTarget(rootTab, direction);
    if (next) open(next);
  };
  const navigateLshSwipe = (direction: SwipeDirection, backOwner: () => void) => {
    if (!currentRootRoute() || rootTab !== 'ai' || top || editingText || lshIme || navigating.current || !overlayStack.isOnly(backOwner)) return;
    const next = rootSwipeTarget(rootTab, direction);
    if (next) open(next);
  };
  const rootSwipe = useHorizontalSwipe(navigateRootSwipe, { disabled: Boolean(top) || editingText || lshIme, canStart: canSwipeRoot, systemEdgeInset: 16 });

  const rootView =
    rootTab === "home" ? <StillHome key={"root-" + rootTab} />
    : rootTab === "library" ? null
    : rootTab === "knowledge" ? <StillKnowledge key={"root-" + rootTab} conn={conn} active={!top} />
    : rootTab === "ai" ? null
    : <StillSettingsRoot key={"root-" + rootTab} conn={conn} />;

  return (
    <StillNavContext.Provider value={nav}>
      <RootSwipeContext.Provider value={{ canNavigate: canSwipeRoot, navigate: navigateRootSwipe, navigateLsh: navigateLshSwipe }}>
      <div ref={appRef} className="st-app" data-mode={mode} data-text-entry={editingText || (rootTab === "ai" && lshIme) ? "true" : undefined} data-reduced={reduced ? "true" : undefined}>
        <LocalNoteImportBridge />
        <div
          data-swipe-owner="root" {...rootSwipe} style={{touchAction:"pan-y"}}
          className={"st-root-stage" + (top && !(leaving && pages.length === 1) ? " is-under" : "") + (leaving && pages.length === 1 ? " is-revealing" : "") + (maskUnderlay ? " is-masked" : "")}
          aria-hidden={!!top || undefined}
        >
          {libraryVisited.current ? <div key="retained-library" hidden={rootTab !== "library"} style={{ height: "100%" }}>
            <StillLibrary conn={conn} active={rootTab === "library"} />
          </div> : null}
          {agentVisited.current ? <div key="retained-agent" hidden={rootTab !== "ai"} style={{ height: "100%" }}>
            <StillAgent conn={conn} active={rootTab === "ai" && !top} />
          </div> : null}
          {rootTab !== "library" && rootTab !== "ai" ? <div key={rootTab} className="st-crossfade" style={{ height: "100%" }}>{rootView}</div> : null}
          <HomeCapture root={rootTab} onCapture={() => open("capture")} />
          <TabBar value={rootTab} onChange={(r) => open(r)} />
        </div>
        {pages.map((page, i) => (
          <PageLayer
            key={page.key}
            depth={i}
            current={i === pages.length - 1}
            covered={i === pages.length - 2 && !leaving}
            buried={i < pages.length - 2}
            masked={i !== pages.length - 1 && maskUnderlay}
            entered={i === pages.length - 1 ? entered : true}
            leaving={i === pages.length - 1 && leaving}
            revealing={i === pages.length - 2 && leaving}
            onExited={finishBack}
            onSettled={i === pages.length - 1 ? () => setMaskedKey(page.key) : undefined}
          >
            {renderScene(page, i === pages.length - 1, page.assetPreview, page.noteSearch, page.noteHeading)}
          </PageLayer>
        ))}
        <StillToast />
      </div>
    </RootSwipeContext.Provider>
    </StillNavContext.Provider>
  );
}

// Route objects are stable references while they sit in the stack; the key map
// gives the view layer a stable React key without touching the authority.
const routeKeys = new WeakMap<object, number>();
let nextKey = 1;
function routeKey(r: Route): number {
  let k = routeKeys.get(r);
  if (!k) { k = nextKey++; routeKeys.set(r, k); }
  return k;
}

function renderScene(page: Scene, current = true, assetPreview?: AssetPreview, noteSearch?: NoteSearchTarget, noteHeading?: NoteHeadingIntent) {
  switch (page.name) {
    case "note": return <StillNote id={page.id || ""} startInEdit={page.startInEdit} current={current} search={noteSearch} heading={noteHeading} />;
    case "new-note": return <StillNewNote />;
    case "capture": return <StillCapture />;
    case "inbox-detail": return <StillInboxDetail id={page.id || ""} />;
    case "asset": return <StillAsset id={page.id || ""} preview={assetPreview} />;
    case "search": return <StillSearch />;
    case "run": return <StillRun id={page.id || ""} />;
    case "connect": return <StillConnect />;
    case "inbox": return <StillInboxPage />;
    case "preferences": return <StillPreferences />;
    case "appearance": return <StillAppearance />;
    case "storage": return <StillStorage />;
    case "diagnostics": return <StillDiagnostics />;
    case "recovery": return <StillRecoveryPage />;
    default: return <StillNote id={page.id || ""} startInEdit={page.startInEdit} current={current} search={noteSearch} heading={noteHeading} />;
  }
}

/** Still toast: the SAME toastStore authority, the Still surface. Only the
 *  most recent message renders (duplicate bursts collapse in the store). */
function StillToast() {
  const items = useSyncExternalStore(
    (fn) => toastStore.subscribe(fn),
    () => toastStore.snapshot()
  );
  const last = items[items.length - 1];
  if (!last) return null;
  return <div className="st-toast" role="status">{last.message}</div>;
}
