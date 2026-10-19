import { NoteActionIcon } from '../presentation/still01/editor/NoteActionIcon';
import { wikiChoices } from "./kit/wikiChoices";
import { settleReadingMode } from "../presentation/still01/editor/readingModeTransition";
// STILL-01.1 — Note read/edit on the Still NoteSurface.
//
// The authority surface (NoteSurface) renders the tree; the behaviour is the
// UNCHANGED production logic ported from the legacy screens (kept as rollback
// sources): LocalNoteAutosaveCoordinator for 本机 notes (single-flight
// debounced autosave, hydration-echo guard, blur/visibility/unmount flush),
// and the epoch/generation Desktop editor for 电脑 notes (contentNoteBegin/
// Refresh/Edit, pending drain before Back, conflict resolve, attachments).
// Read→edit keeps the SAME mounted session; pin/favorite/tags/archive/delete
// moved into the Still More/State sheets.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NoteSurface, Sheet, Option, Button, SearchField, Row, Header, IconButton, type NoteState } from "./kit/StillImports";
import { resumePausedDraft, pausedRecoveryError, openNoteDeletion } from "../services/pausedNoteRecovery";
import { api } from "../services/client";
import { LocalNoteAutosaveCoordinator, type SaveStatus } from "../services/localNoteAutosave";
import { localDataStore, publishAfter } from "../services/localDataStore";
import { dataStore } from "../services/dataStore";
import { syncCoordinator } from "../services/syncCoordinator";
import { DurablePublishDebounce } from "../services/durablePublishDebounce";
import { canAdoptKnowledgeBody } from "../services/knowledgeIncomingDraft";
import { KnowledgeEditingSession, editingHintLabel, type EditingHint } from "../services/knowledgeEditingSession";
import { beginDesktopNote, DesktopNoteOpener } from "../services/desktopNoteBegin";
import { contentError } from "../components/DesktopLibrary";
import { noteStatus, hasReadableBody, missingBodyMessage, cachedResources } from "../services/noteProvenance";
import { DesktopKnowledgeReader } from "./kit/DesktopKnowledgeReader";
import { stillNoteState } from "../presentation/still01/host";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { sessionKnowledge } from "./kit/knowledgeSession";
import "./kit/noteSearch.css";
import "./kit/noteExperience.css";
import { ScopedNoteSwitcher, type NoteSwitcherProps } from "./kit/noteSwitcher";
import { desktopNoteRoute, type NoteSearchTarget } from "./kit/noteSearch";
import { orchestrateDesktopCreate, type CreateScope } from "./kit/desktopCreate";
import { DirectorySheet } from "./kit/directorySheet";
import { parentOf, type MoveAuthority } from "./kit/knowledgeOrganizationController";

/** R1.6.1-2: the parent of a cached relativePath, fail-safe to ROOT. */
function parentOfSafe(relativePath: unknown): string {
  return typeof relativePath === "string" && relativePath ? parentOf(relativePath) : "";
}

/** R1.6.1-2: a safe one-line local preview of freshly saved content. */
function safePreviewLine(content: string): string {
  return content.split(String.fromCharCode(10)).join(" ")
    .split(String.fromCharCode(13)).join(" ")
    .split(String.fromCharCode(9)).join(" ")
    .replace(/ +/gu, " ").trim().slice(0, 40);
}
import { useStillNav } from "./StillShell";
import { MobileCmEditor, type CmEditorHandle } from "../presentation/still01/editor/MobileCmEditor";
import { forgetCmView } from "../presentation/still01/editor/cmEditorSessions";
import { NoteReadingContent } from "./kit/NoteReadingContent";
import { EditorToolbarSheet } from "./kit/EditorToolbarSheet";
import { LocalKnowledgeReader } from "./kit/LocalKnowledgeReader";
import { usePageCurrent, useRetainedPage } from "../presentation/still01/PageLayer";
import type { NoteBodyFocusRequest } from "../presentation/still01/editor/noteTapEditing";

type Mode = "read" | "edit";
type SheetName = "" | "more" | "state" | "conflict" | "tag" | "format" | "delete" | "switcher" | "attach" | "rename" | "move" | "relations" | "toolbar" | "browser";

/** The live editor host inside the CURRENT (top) Still page layer. */
function pageEditorHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.st-detail-stage[data-current="true"] .st-note-editor');
}
/** The CURRENT page's CM handle (the adapter stores it on the host). */
function pageEditorHandle(): CmEditorHandle | null {
  const host = pageEditorHost();
  return (host as (HTMLElement & { __cmHandle?: CmEditorHandle }) | null)?.__cmHandle ?? null;
}
function pageTitleInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('.st-detail-stage[data-current="true"] .st-note-title');
}
/** Formatting annotates selected user text; it must never replace it with only a template. */
function formatInsertion(marker: string, selected: string): string {
  if (!selected) return marker;
  return marker === "\n[链接文字](https://)"
    ? `\n[${selected}](https://)`
    : marker + selected;
}
/**
 * CM6-EDITOR-R1: the editor-activity predicate. The original matched the
 * event/target itself (a textarea); the CM contentDOM is a DESCENDANT of the
 * .st-note-editor host, so both the element and its ancestors count. The
 * title input keeps its direct match.
 */
/** CM6-EDITOR-R1: the FULL owner scope key — sourceKind + instance/vault/note. */
function cmScope(sourceKind: "local" | "desktop", instance: string, vault: string, note: string): string {
  return ["cm", sourceKind, instance, vault, note].join("|");
}
function isEditorElement(el: Element | null): boolean {
  if (!el) return false;
  if (el.matches?.(".st-note-title")) return true;
  return Boolean(el.matches?.(".st-note-editor") || el.closest?.(".st-note-editor"));
}

export function StillNote({ id, startInEdit, current = true, search }: { id: string; startInEdit?: boolean; current?: boolean; search?: NoteSearchTarget }) {
  const liveCurrent = usePageCurrent(current);
  const isLocal = id.startsWith("note-");
  return isLocal
    ? <LocalStillNote id={id} startInEdit={startInEdit} current={liveCurrent} search={search} />
    : <DesktopStillNote route={id} startInEdit={startInEdit} current={liveCurrent} search={search} />;
}

/** Explicitly scoped search; the local surface never mixes Desktop rows. */
export function NoteSwitcherSheet(props: NoteSwitcherProps) {
  return <ScopedNoteSwitcher {...props} />;
}

// ---------------------------------------------------------------------------
// 本机 notes — LocalNoteAutosaveCoordinator authority
// ---------------------------------------------------------------------------

function LocalStillNote({ id, startInEdit, current, search }: { id: string; startInEdit?: boolean; current: boolean; search?: NoteSearchTarget }) {
  const [searchTarget, setSearchTarget] = useState(search);
  const { open, back, registerOverlay } = useStillNav();
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [pinned, setPinned] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [archived, setArchived] = useState(false);
  const [mode, setMode] = useState<Mode>(startInEdit ? "edit" : "read");
  const [sourceMode, setSourceMode] = useState(false);
  const [bodyFocus, setBodyFocus] = useState<NoteBodyFocusRequest>();
  // A reused route keeps this save owner; only a NEW incoming search intent
  // changes reading mode/target. Back and local previous/next do not replay it.
  useEffect(() => {
    if (!search) return;
    setSearchTarget(search); setBodyFocus(undefined); setMode("read");
  }, [search]);
  const [saveState, setSaveState] = useState<SaveStatus>("saved");
  const [saveMsg, setSaveMsg] = useState("");
  const [sheet, setSheet] = useState<SheetName>("");
  const [tagInput, setTagInput] = useState("");
  const [formatSel, setFormatSel] = useState<{ start: number; end: number } | null>(null);
  const coordinator = useRef<LocalNoteAutosaveCoordinator | null>(null);
  const editingActivity = useRef(0);
  const localComposing = useRef(false);
  const dirtyRef = useRef(false);
  const failedRef = useRef(false);
  const backRef = useRef<() => void>(() => {});
  const currentRef = useRef(current);
  const currentGeneration = useRef(0);
  if (currentRef.current !== current) currentGeneration.current += 1;
  currentRef.current = current;
  useEffect(() => () => { currentRef.current = false; currentGeneration.current += 1; }, []);
  backRef.current = () => void guardedBack();

  // Guarded Back: a failed flush blocks leaving (same contract as the legacy
  // editor — "保存失败，禁止悄悄离开编辑页").
  async function guardedBack() {
    if (!currentRef.current) return;
    const generation = currentGeneration.current;
    const c = coordinator.current;
    if (c?.isDirty() || failedRef.current) {
      try {
        await c?.flush();
        failedRef.current = false;
      } catch {
        setSaveState("error");
        setSaveMsg("退出保存失败，仍停留在编辑界面");
        return;
      }
    }
    if (currentRef.current && generation === currentGeneration.current) back();
  }

  // The Android back chain asks the note first via this window event.
  useEffect(() => {
    if (!current) return;
    const listener = (event: Event) => {
      if (!currentRef.current) return;
      event.preventDefault(); backRef.current();
    };
    window.addEventListener("luckyray:desktop-note-back", listener);
    return () => window.removeEventListener("luckyray:desktop-note-back", listener);
  }, [current]);



  useEffect(() => {
    const start = (event: Event) => { if (currentRef.current && isEditorElement(event.target as Element)) localComposing.current = true; };
    const end = () => { localComposing.current = false; };
    document.addEventListener("compositionstart", start, true);
    document.addEventListener("compositionend", end, true);
    return () => { document.removeEventListener("compositionstart", start, true); document.removeEventListener("compositionend", end, true); };
  }, []);

  // Load + initialize the coordinator.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const n = await api.localNoteGet(id);
        if (!alive) return;
        setTitle(n.title ?? "");
        setContent(n.content ?? "");
        setTags(n.tags ?? []);
        setPinned(Boolean(n.pinned));
        setFavorite(Boolean(n.favorite));
        setArchived(Boolean(n.archived));
        const snap = { title: n.title ?? "", content: n.content ?? "", tags: n.tags ?? [] };
        if (!coordinator.current || coordinator.current.getNoteId() !== id) {
          coordinator.current?.dispose();
          coordinator.current = new LocalNoteAutosaveCoordinator(
            id,
            snap,
            async (s) => {
              await api.localNoteUpdate(id, s.title, s.content, s.tags);
              localDataStore.publish("note");
            },
            1000
          );
          coordinator.current.subscribe((st, err) => {
            setSaveState(st);
            failedRef.current = st === "error";
            if (err) setSaveMsg("自动保存失败: " + err);
          });
        } else {
          coordinator.current.resetBase(snap);
        }
        setLoaded(true);
      } catch (e: any) {
        if (alive) { setSaveMsg("加载笔记失败: " + failureCopy(e, "")); setLoaded(true); }
      }
    })();
    return () => { alive = false; };
  }, [id]);

  // CM6-EDITOR-R1: leaving this local note DESTROYS its retained editor.
  useEffect(() => () => { forgetCmView(cmScope("local", "", "", id)); }, [id]);

  // Only real user edits reach the coordinator (the hydration echo must not
  // create a fake edit generation / autosave / updated_at bump).
  useEffect(() => {
    const c = coordinator.current;
    if (!c) return;
    const snap = { title, content, tags };
    const cur = c.getLatestSnapshot();
    const unchanged =
      cur.title === snap.title && cur.content === snap.content &&
      cur.tags.length === snap.tags.length && cur.tags.every((t, i) => t === snap.tags[i]);
    if (unchanged && !c.isDirty()) return;
    dirtyRef.current = true;
    c.updateSnapshot(snap);
  }, [title, content, tags]);

  // Unmount / visibility / blur flush protection (single shared drain).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && coordinator.current?.isDirty()) {
        void coordinator.current.flush().catch(() => {});
      }
    };
    const onBlur = () => {
      if (coordinator.current?.isDirty()) void coordinator.current.flush().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      if (coordinator.current?.isDirty()) void coordinator.current.flush().catch(() => {});
    };
  }, []);

  async function guardEdit(): Promise<boolean> {
    if (!currentRef.current) return false;
    const generation = currentGeneration.current;
    const c = coordinator.current;
    if (failedRef.current) { setSaveState("error"); return false; }
    if (c?.isDirty()) {
      try { await c.flush(); dirtyRef.current = false; }
      catch { setSaveState("error"); return false; }
    }
    return currentRef.current && generation === currentGeneration.current;
  }

  async function enterReading() {
    await settleReadingMode({
      isCurrent: () => currentRef.current,
      isComposing: () => Boolean(localComposing.current || pageEditorHandle()?.isComposing() || pageEditorHandle()?.compositionStarted()),
      activity: () => currentGeneration.current + editingActivity.current,
      flush: guardEdit,
      hasUnsaved: () => Boolean(coordinator.current?.isDirty() || failedRef.current),
      commit: () => { editingActivity.current += 1; setBodyFocus(undefined); setMode("read"); },
    });
  }

  async function toggleFlag(flag: "pinned" | "favorite" | "archived") {
    const current = flag === "pinned" ? pinned : flag === "favorite" ? favorite : archived;
    try {
      await publishAfter("note", api.localNoteSetFlags(id, { [flag]: !current }));
      if (flag === "pinned") setPinned((v) => !v);
      if (flag === "favorite") setFavorite((v) => !v);
      if (flag === "archived") setArchived((v) => !v);
    } catch (e: any) {
      setSaveMsg(failureCopy(e, "操作失败"));
    }
  }

  async function remove() {
    if (!currentRef.current) return;
    const generation = currentGeneration.current;
    try {
      await publishAfter("note", api.localNoteDelete(id));
      if (currentRef.current && generation === currentGeneration.current) back();
    } catch (e: any) {
      setSaveMsg(failureCopy(e, "删除笔记失败"));
    }
  }

  function insertFormat(marker: string) {
    if (!currentRef.current) return;
    const generation = currentGeneration.current;
    const handle = pageEditorHandle();
    if (handle) {
      if (handle.isComposing() || handle.compositionStarted()) return;
      // CM6-EDITOR-R1: the format insertion is a USER transaction — it
      // enters history and flows through the normal onChange → coordinator
      // save chain exactly once, with the caret after the formatted text.
      const pos = formatSel ?? handle.getSelection();
      const insertion = formatInsertion(marker, handle.getValue().slice(pos.start, pos.end));
      handle.focus();
      handle.replaceRange(insertion, pos);
      setSheet("");
      return;
    }
    const el = pageEditorHost() as HTMLTextAreaElement | null;
    const pos = formatSel ?? (el ? { start: el.selectionStart ?? content.length, end: el.selectionEnd ?? content.length } : { start: content.length, end: content.length });
    const insertion = formatInsertion(marker, content.slice(pos.start, pos.end));
    const next = content.slice(0, pos.start) + insertion + content.slice(pos.end);
    setContent(next);
    setSheet("");
    setTimeout(() => {
      if (!currentRef.current || generation !== currentGeneration.current) return;
      const editor = pageEditorHost() as HTMLTextAreaElement | null;
      if (editor) { editor.focus(); editor.setSelectionRange(pos.start + insertion.length, pos.start + insertion.length); }
    }, 0);
  }

  if (!loaded) {
    return <div className="st-view"><Header title="笔记" /></div>;
  }

  const state: NoteState = saveState === "error" ? "error" : "local";
  const savedLabel = mode === "edit"
    ? (saveState === "saving" ? "正在保存…" : saveState === "unsaved" ? "未保存" : saveState === "error" ? (saveMsg || "保存出错") : "已自动保存")
    : "本机笔记";

  return (
    <>
      <NoteSurface
        title={title}
        body={content}
        notebook="本机笔记"
        state={state}
        mode={mode}
        savedLabel={savedLabel}
        onBack={() => void guardedBack()}
        onBrowse={async () => { if (await guardEdit()) setSheet("browser"); }}
        onMore={() => setSheet("more")}
        onNew={async () => { if (await guardEdit()) open("new-note"); }}
        onEdit={(offset) => {
          if (!currentRef.current) return;
          editingActivity.current += 1;
          if (offset !== undefined) setBodyFocus({ scope: cmScope("local", "", "", id), offset });
          setMode("edit");
        }}
        onRead={() => void enterReading()}
        onRelations={() => setSheet("relations")}
        onChange={(t, b) => { editingActivity.current += 1; setTitle(t); setContent(b); setSaveMsg(""); }}
        onCommand={command => { pageEditorHandle()?.runCommand(command); }}
        onFormat={() => {
          const handle = pageEditorHandle();
          if (handle) {
            if (handle.isComposing() || handle.compositionStarted()) return;
            setFormatSel(handle.getSelection()); setSheet("format"); return;
          }
          const el = pageEditorHost() as HTMLTextAreaElement | null;
          setFormatSel(el ? { start: el.selectionStart ?? content.length, end: el.selectionEnd ?? content.length } : null);
          setSheet("format");
        }}
        onSearch={() => setSheet("switcher")}
        onState={() => setSheet("state")}
        readingContent={<NoteReadingContent scope={cmScope("local", "", "", id)} body={content} title={title}
          search={searchTarget} onSearchChange={setSearchTarget} onDismissSearch={() => setSearchTarget(undefined)}>{find =>
          <LocalKnowledgeReader source={id} content={content} current={current && !sheet} find={find} registerOverlay={registerOverlay}
            onNavigate={async (noteId, isCurrent) => {
              if (!(await guardEdit()) || !currentRef.current || !isCurrent()) return;
              if (noteId !== id) open("note", noteId, { edit: false, linked: true });
            }} />}</NoteReadingContent>}
        bodyEditor={<MobileCmEditor
          sourceMode={sourceMode}
          scope={cmScope("local", "", "", id)}
          wikiLoader={query => wikiChoices(query)} assistActive={current && !sheet && mode === "edit"}
          value={content}
          search={searchTarget}
          onDismissSearch={() => setSearchTarget(undefined)}
          onChange={(next) => { editingActivity.current += 1; setContent(next); setSaveMsg(""); }}
          placeholderText=""
          focusRequest={bodyFocus}
        />}
      />
      {sheet === "relations" ? <Sheet title="笔记链接" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
        <LocalKnowledgeReader panelOnly source={id} content={content} current={current} find={{ body: content, ranges: [], index: 0 }} registerOverlay={registerOverlay}
          onNavigate={async (noteId, isCurrent) => {
            if (!(await guardEdit()) || !currentRef.current || !isCurrent()) return;
            setSheet(""); if (noteId !== id) open("note", noteId, { edit: false, linked: true });
          }} />
      </Sheet> : null}
      {sheet === "more" ? (
        <Sheet title={title || "笔记"} registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <Option label="重命名" iconSlot={<NoteActionIcon name="rename" size={23}/>} onClick={() => {
            if (!currentRef.current) return;
            const generation = currentGeneration.current;
            setSheet(""); setMode("edit");
            setTimeout(() => { if (currentRef.current && generation === currentGeneration.current) pageTitleInput()?.focus(); }, 60);
          }} />
          <Option label={pinned ? "取消置顶" : "置顶笔记"} iconSlot={<NoteActionIcon name="pin" size={23}/>} onClick={() => { void toggleFlag("pinned"); setSheet(""); }} />
          <Option label={favorite ? "取消收藏" : "收藏笔记"} iconSlot={<NoteActionIcon name="heart" size={23}/>} onClick={() => { void toggleFlag("favorite"); setSheet(""); }} />
          <Option label="标签" iconSlot={<NoteActionIcon name="tag" size={23}/>} onClick={() => setSheet("tag")} />
          <Option label={archived ? "取消归档" : "归档"} iconSlot={<NoteActionIcon name="archive" size={23}/>} onClick={() => { void toggleFlag("archived"); setSheet(""); }} />
          <Option label={sourceMode ? "退出源码模式" : "源码模式"} iconSlot={<NoteActionIcon name="code" size={23}/>} selected={sourceMode} onClick={() => {
            if (!loaded || !current) return;
            const editor = pageEditorHandle();
            if (editor?.isComposing() || editor?.compositionStarted()) return;
            setSourceMode(value => !value); setMode("edit"); setSheet("");
          }} />
          <Option label="编辑工具栏" iconSlot={<NoteActionIcon name="tools" size={23}/>} onClick={() => setSheet("toolbar")} />
          <Option label="查看来源与状态" iconSlot={<NoteActionIcon name="info" size={23}/>} onClick={() => setSheet("state")} />
          <Option label="删除笔记" iconSlot={<NoteActionIcon name="trash" size={23}/>} danger onClick={() => setSheet("delete")} />
        </Sheet>
      ) : null}
      {sheet === "tag" ? (
        <Sheet title="标签" registerDismiss={registerOverlay} onClose={() => setSheet("")}
          footer={<Button onClick={() => {
            const t = tagInput.trim().replace(/^#/, "");
            if (t && !tags.includes(t)) { const next = [...tags, t]; setTags(next); coordinator.current?.updateSnapshot({ title, content, tags: next }); }
            setTagInput("");
            setSheet("");
          }}>完成</Button>}>
          <label className="st-field">标签名称
            <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} />
          </label>
          {tags.length ? <div style={{ marginTop: 10 }}>{tags.map((t) => (
            <Option key={t} label={"#" + t} icon="tag" onClick={() => {
              const next = tags.filter((x) => x !== t);
              setTags(next);
              coordinator.current?.updateSnapshot({ title, content, tags: next });
            }} />
          ))}</div> : null}
        </Sheet>
      ) : null}
      {sheet === "state" ? (
        <Sheet title="来源与状态" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <div className="st-metadata-row"><span>来源</span><b>本机笔记</b></div>
          <p className="st-sheet-copy">只保存在手机。本机笔记不会被界面自动变成电脑笔记。</p>
        </Sheet>
      ) : null}
      {sheet === "toolbar" ? <EditorToolbarSheet registerOverlay={registerOverlay} onClose={() => setSheet("")} /> : null}
      {sheet === "format" ? (
        <Sheet title="文本格式" retainEditorFocus registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          {([["小标题", "\n\n## "], ["无序列表", "\n- "], ["待办事项", "\n- [ ] "], ["引用", "\n> "], ["链接", "\n[链接文字](https://)"]] as const).map(([label, marker]) => (
            <Option key={label} label={label} icon={({"小标题":"heading","无序列表":"bullet","待办事项":"task","引用":"quote","链接":"link"} as Record<string,string>)[label]} onClick={() => insertFormat(marker)} />
          ))}
        </Sheet>
      ) : null}
      {sheet === "delete" ? (
        <Sheet title="删除这条内容？" registerDismiss={registerOverlay} onClose={() => setSheet("")}
          footer={<>
            <Button kind="quiet" onClick={() => setSheet("")}>取消</Button>
            <Button kind="danger" onClick={() => { setSheet(""); void remove(); }}>删除</Button>
          </>}>
          <p className="st-sheet-copy">只删除这条本机笔记，其他内容不受影响。</p>
        </Sheet>
      ) : null}
      {sheet === "switcher" || sheet === "browser" ? (
        <NoteSwitcherSheet variant={sheet === "browser" ? "browse" : "search"} currentRoute={id} key={sheet} onClose={() => setSheet("")} registerOverlay={registerOverlay} onPick={async (route, target, isCurrent) => {
          if (!(await guardEdit()) || !isCurrent()) return;
          setSheet("");
          if (route === id && !target) { setSearchTarget(undefined); setBodyFocus(undefined); setMode("read"); }
          else open("note", route, { noteSearch: target });
        }} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 电脑 notes — epoch/generation editor authority
// ---------------------------------------------------------------------------

function DesktopStillNote({ route, startInEdit, current, search }: { route: string; startInEdit?: boolean; current: boolean; search?: NoteSearchTarget }) {
  const retained = useRetainedPage();
  const [searchTarget, setSearchTarget] = useState(search);
  const { open, back, registerOverlay, conn } = useStillNav();
  const parts = route.split(":");
  const instance = decodeURIComponent(parts[1] || "");
  const vault = decodeURIComponent(parts[2] || "");
  const id = decodeURIComponent(parts[3] || "");
  const [note, setNote] = useState<any>(null);
  const [loadedNoteScope, setLoadedNoteScope] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<Mode>(startInEdit ? "edit" : "read");
  const [sourceMode, setSourceMode] = useState(false);
  const [bodyFocus, setBodyFocus] = useState<NoteBodyFocusRequest>();
  useEffect(() => {
    if (!search) return;
    setSearchTarget(search); setBodyFocus(undefined); setMode("read");
  }, [search]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [sheet, setSheet] = useState<SheetName>("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [formatSel, setFormatSel] = useState<{ start: number; end: number } | null>(null);
  // ORG-1B REPAIR-R1.1: single-note move (移动到目录) — canonical move through
  // the session's ONE injected Services client, gated on the REAL capability
  // truth and the note's own provenance facts.
  const [moveOpen, setMoveOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveAuthority, setMoveAuthority] = useState<MoveAuthority | null>(null);
  // ORG-1B REPAIR-R1.1: the move gate truth state (conn + capability).
  const [moveGate, setMoveGate] = useState<{ connected: boolean; authority: MoveAuthority | null } | null>(null);
  const session = sessionKnowledge();
  const orgCtrl = session.organization;
  // R1.6-B: a stable alias for the reconciliation paths below (the editor
  // closures already bind a local `session` variable for the owner counter).
  const session2 = session;
  const owner = useRef(0);
  const noteOpener = useRef<DesktopNoteOpener | null>(null);
  const editGeneration = useRef(0);
  const epoch = useRef(0);
  const displayedRevision = useRef("");
  const composing = useRef(false);
  const navigationActivity = useRef(0);
  const deferredIncoming = useRef(false);
  const pending = useRef(new Set<Promise<unknown>>());
  const failed = useRef(false);
  const publisher = useRef(new DurablePublishDebounce(() => syncCoordinator.wake()));
  const editingLease = useRef<KnowledgeEditingSession | null>(null);
  const [desktopEditing, setDesktopEditing] = useState(false);
  const [mobileEditingHint, setMobileEditingHint] = useState<{scope: string; hint: EditingHint}>({scope: "", hint: "disabled"});
  const connectedOwner = Boolean(conn?.paired && conn.identity?.instanceId === instance && conn.ws.state === "connected");
  const currentPage = useRef(current);
  const connectedPage = useRef(connectedOwner);
  const modeRef = useRef(mode);
  currentPage.current = current;
  connectedPage.current = connectedOwner;
  modeRef.current = mode;
  const draft = useRef({ title: "", content: "" });
  // The detail owns its route scope. A missing path is not evidence of ROOT.
  const scopeReady = loadedNoteScope === JSON.stringify([instance, vault, id])
    && hasReadableBody(note) && typeof note?.relativePath === "string" && Boolean(note.relativePath);
  const scopeParent = scopeReady ? parentOfSafe(note.relativePath) : "";
  const canUseScope = Boolean(current && scopeReady && conn?.paired && conn.identity?.instanceId === instance);
  const navigationScope = useRef({ key: "", generation: 0, active: false, parent: "" });
  const navigationKey = JSON.stringify([instance, vault, id, current, scopeReady, scopeParent, sheet, mode,
    conn?.paired, conn?.identity?.instanceId, conn?.ws.state]);
  if (navigationScope.current.key !== navigationKey) {
    navigationScope.current = { key: navigationKey, generation: navigationScope.current.generation + 1,
      active: canUseScope, parent: scopeParent };
  }
  const createBusy = useRef(false);
  useEffect(() => () => {
    navigationScope.current.active = false;
    navigationScope.current.generation += 1;
  }, []);

  async function guardNavigation(): Promise<boolean> {
    if (!navigationScope.current.active) { setMessage("请先等待当前笔记加载完成，或返回知识页确认所属电脑。"); return false; }
    const handle = pageEditorHandle();
    if (composing.current || handle?.isComposing() || handle?.compositionStarted()) return false;
    const token = navigationScope.current.generation + navigationActivity.current, generation = editGeneration.current;
    await Promise.all(pending.current);
    if (!navigationScope.current.active || token !== navigationScope.current.generation + navigationActivity.current
      || generation !== editGeneration.current) return false;
    if (failed.current) { setMessage("手机尚未保存成功，请重试保存后继续。"); return false; }
    return true;
  }

  async function openLinkedNote(noteId: string, isCurrent: () => boolean) {
    if (!isCurrent() || !/^[A-Za-z0-9_-]{1,160}$/.test(noteId) || !(await guardNavigation()) || !isCurrent()) return;
    if (noteId === id) { setMessage("链接指向当前笔记。"); return; }
    open("note", desktopNoteRoute(instance, vault, noteId));
  }

  async function browseCurrentNotes(variant: "browser" | "switcher" = "switcher") {
    if (await guardNavigation()) setSheet(variant);
  }

  async function createSiblingNote() {
    if (createBusy.current) return;
    createBusy.current = true;
    try {
      if (!(await guardNavigation())) return;
      const result = await orchestrateDesktopCreate({
        resolveAuthority: () => api.contentNoteCreateAuthority(instance, vault),
        create: (scope: CreateScope) => api.contentNoteCreate(scope.instance, scope.vault, "新笔记", scope.parent || undefined),
        currentness: {
          instance: () => instance, vault: () => vault,
          parent: () => navigationScope.current.parent,
          generation: () => navigationScope.current.generation + navigationActivity.current,
          // An authorized S1 local stage is usable offline. Native authority
          // still validates the exact selected owner/vault and write grant.
          connected: () => navigationScope.current.active,
        },
      });
      if (result.kind === "denied") { setMessage(failureCopy(result.reason, "当前知识库暂时无法新建笔记。")); return; }
      if (result.kind === "busy" || result.kind === "stale") return;
      session2.projection.upsert({ instanceId: result.scope.instance, vaultId: result.scope.vault,
        noteId: result.noteId, title: "新笔记", parent: result.scope.parent, pending: true, preview: "", origin: "create" });
      if (result.kind === "created-current") {
        open("note", desktopNoteRoute(result.scope.instance, result.scope.vault, result.noteId), { edit: true });
      }
    } finally { createBusy.current = false; }
  }
  function adoptIncoming(value: any, generation: number): void {
    // CM6-EDITOR-R1: the CM contentDOM is a DESCENDANT of .st-note-editor —
    // the predicate covers the element itself and its editor ancestors.
    const focused = isEditorElement(document.activeElement);
    if (canAdoptKnowledgeBody({current: currentPage.current, sameGeneration: generation === editGeneration.current,
      pending: pending.current.size, failed: failed.current, editing: modeRef.current === "edit", focused, composing: composing.current,
      draft: draft.current, incoming: value})) {
      deferredIncoming.current = false;
      displayedRevision.current = value.revision || "";
      setTitle(value.title); setContent(value.content);
      draft.current = {title: value.title, content: value.content};
    } else { deferredIncoming.current = true; }
  }
  useEffect(() => {
    const input = (event: Event) => currentPage.current && isEditorElement((event.target as Element) ?? null);
    const start = (event: Event) => { if (input(event)) { composing.current = true; navigationActivity.current += 1; } };
    const settle = (event: Event) => {
      if (!input(event)) return;
      if (event.type === "compositionend") composing.current = false;
      if (!deferredIncoming.current) return;
      const ownerToken = owner.current, generation = editGeneration.current;
      void Promise.all(pending.current).then(() => api.contentNoteGet(instance, vault, id)).then(value => {
        if (ownerToken === owner.current && currentPage.current) { setNote(value); adoptIncoming(value, generation); }
      }).catch(() => {});
    };
    document.addEventListener("compositionstart", start, true);
    document.addEventListener("compositionend", settle, true);
    document.addEventListener("blur", settle, true);
    return () => {
      document.removeEventListener("compositionstart", start, true);
      document.removeEventListener("compositionend", settle, true);
      document.removeEventListener("blur", settle, true);
    };
  }, [instance, vault, id, mode]);
  const version = useSyncExternalStore((fn) => dataStore.subscribe(fn), () => dataStore.getVersion());
  const sync = useSyncExternalStore(fn => syncCoordinator.subscribe(fn), () => syncCoordinator.snapshot());
  const desktopBusy = sync.desktopBusyNotes.includes(JSON.stringify([instance, vault, id])) && !note?.conflictDocument;
  const backRef = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    setDesktopEditing(false);
    const lease = new KnowledgeEditingSession({ instance, vault, note: id }, session2.editingEffects({
      isLive: scope => live && connectedPage.current && scope.instance === instance && scope.vault === vault && scope.note === id,
      observe: (_scope, editing) => setDesktopEditing(editing),
    }), current && !document.hidden && connectedOwner, (scope, hint) => {
      if (live) setMobileEditingHint({scope: JSON.stringify([scope.instance, scope.vault, scope.note]), hint});
    });
    editingLease.current = lease;
    const visibility = () => {
      lease.setVisible(currentPage.current && !document.hidden && connectedPage.current);
      if (document.hidden) setDesktopEditing(false);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      lease.retire();
      live = false;
      if (editingLease.current === lease) editingLease.current = null;
    };
    // Leaving edit mode retires the edited lease; the replacement remains read-only.
  }, [instance, vault, id, mode]);

  useEffect(() => {
    editingLease.current?.setVisible(current && !document.hidden && connectedOwner);
    if (!current || !connectedOwner) setDesktopEditing(false);
  }, [current, connectedOwner]);

  async function enterReading() {
    await settleReadingMode({
      isCurrent: () => currentPage.current && loaded && loadedNoteScope === JSON.stringify([instance, vault, id]),
      isComposing: () => Boolean(composing.current || pageEditorHandle()?.isComposing() || pageEditorHandle()?.compositionStarted()),
      activity: () => navigationScope.current.generation + navigationActivity.current + editGeneration.current,
      flush: async () => { await Promise.all(pending.current); if (failed.current) setMessage("手机尚未保存成功，请重试保存后继续。"); return !failed.current; },
      hasUnsaved: () => pending.current.size > 0 || failed.current,
      commit: () => { navigationActivity.current += 1; setBodyFocus(undefined); setMode("read"); },
    });
  }

  async function guardedBack() {
    if (!currentPage.current || sheet) return; // a sheet consumes Back first (overlayStack handles it)
    const token = navigationScope.current.generation + navigationActivity.current;
    await Promise.all(pending.current);
    if (!currentPage.current
      || token !== navigationScope.current.generation + navigationActivity.current) return;
    if (failed.current) { setMessage("手机尚未保存成功，请重试保存后返回。"); return; }
    back();
  }
  backRef.current = () => void guardedBack();

  useEffect(() => {
    const listener = (event: Event) => {
      if (!currentPage.current) return;
      event.preventDefault(); backRef.current();
    };
    window.addEventListener("luckyray:desktop-note-back", listener);
    return () => window.removeEventListener("luckyray:desktop-note-back", listener);
  }, []);

  // R1.6.2-4: after each sync round, ONE bounded LOCAL re-read of the exact
  // pending note refreshes the transient projection — an auto-copied title
  // (252 → 252（副本）) shows on the list immediately. Exact instance/vault/
  // noteId; parent preserved; no Desktop N+1 (the read is the local cache).
  useEffect(() => {
    if (version === 0) return;
    void api.contentNoteGet(instance, vault, id).then((value) => {
      if (!value) return;
      if (value.pendingKind !== "create" || !value.dirty) return; // only pending creates can be auto-renamed
      session2.projection.update(instance, vault, id, { title: value.title || "新笔记" });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    owner.current++;
    editGeneration.current = 0; failed.current = false;
    composing.current = false; deferredIncoming.current = false; displayedRevision.current = "";
    epoch.current = 0;
    setNote(null); setLoadedNoteScope(""); setMessage("");
    const opener = new DesktopNoteOpener(async (isAttemptCurrent) => {
      const session = ++owner.current;
      await beginDesktopNote({
        begin: () => api.contentNoteBegin(instance, vault, id),
        refresh: () => api.contentNoteRefresh(instance, vault, id),
      }, () => isAttemptCurrent() && session === owner.current && currentPage.current).then(async (loaded) => {
        if (!loaded || session !== owner.current) return;
        const { cached } = loaded;
        epoch.current = cached.editorEpoch;
        setLoadedNoteScope(JSON.stringify([instance, vault, id]));
        setNote(cached); setTitle(cached.title); setContent(cached.content);
        displayedRevision.current = cached.revision || "";
        draft.current = { title: cached.title, content: cached.content };
        if (loaded.refreshed) return; // cold path already obtained its baseline
        const gen = editGeneration.current;
        try {
          const fresh = await api.contentNoteRefresh(instance, vault, id);
          if (session !== owner.current) return;
          setNote(fresh);
          adoptIncoming(fresh, gen);
        } catch {
          // Readability comes from the CACHED BODY, never the latest summary.
          const missing = missingBodyMessage(cached);
          if (session === owner.current && missing) setMessage(missing);
        }
      }).catch((e) => { if (isAttemptCurrent() && session === owner.current && currentPage.current) setMessage(contentError(e)); });
    }, () => epoch.current !== 0);
    noteOpener.current = opener;
    opener.setCurrent(currentPage.current);
    return () => {
      opener.dispose();
      if (noteOpener.current === opener) noteOpener.current = null;
      owner.current++;
      publisher.current.dispose();
      // CM6-EDITOR-R1: leaving this note DESTROYS its retained editor —
      // the undo history/selection die with the scope (never leak into
      // another note, instance or the local source).
      forgetCmView(cmScope("desktop", instance, vault, id));
      dataStore.bump();
      syncCoordinator.wake();
    };
  }, [instance, vault, id]);

  useEffect(() => {
    if (!current) composing.current = false;
    noteOpener.current?.setCurrent(current);
  }, [current]);

  useEffect(() => {
    if (!epoch.current) return;
    const session = owner.current;
    const gen = editGeneration.current;
    void api.contentNoteGet(instance, vault, id).then((value) => {
      if (session !== owner.current) return;
      setNote(value);
      adoptIncoming(value, gen);
      // R1.6-B/R1.6.3-1/2 reconciliation: the ACK TARGET is recorded ONLY
      // when the CURRENT draft is CLEAN (dirty=false with a serverDocument)
      // — its serverDocument.revision IS this draft's target. A newer dirty
      // draft (create ack for B while the phone holds C) keeps pending=true
      // and NO target, so presence can never retire it. The projection is
      // KEPT until the LIST proves the authority revision EQUALS the target
      // (retireIfPresent) — no gap, no inequality guessing.
      if (value?.serverDocument && value?.pendingKind !== "create" && value?.dirty === false) {
        session2.projection.update(instance, vault, id, {
          pending: false,
          targetRemoteRevision: value.serverDocument.revision || undefined,
        });
        session2.desktop.fastRevalidate();
      }
    }).catch(() => {});
  }, [version, instance, vault, id, mode]);

  function edit(nextTitle: string, nextContent: string): Promise<boolean> {
    navigationActivity.current += 1;
    setTitle(nextTitle); setContent(nextContent);
    draft.current = { title: nextTitle, content: nextContent };
    const generation = ++editGeneration.current;
    const publishGeneration = publisher.current.begin();
    const session = owner.current;
    setSaving(true); setMessage("");
    const request = api.contentNoteEdit({ instance, vault, id, title: nextTitle, content: nextContent, epoch: epoch.current, generation, expectedRevision: displayedRevision.current })
      .then((value) => {
        // Every durable receipt in this session can wake native sync, even
        // while a newer input is saving. Only the latest receipt owns UI truth.
        if (session === owner.current) publisher.current.committed(publishGeneration);
        if (session === owner.current && generation === editGeneration.current) {
          failed.current = false; setNote(value);
          editingLease.current?.committed();
          // R1.6.1-2: ONLY a successful local save writes list truth — the
          // transient projection overlays the phone's saved title/preview
          // (upsert covers BOTH a pending create and an already-canonical
          // note; a FAILED save never reaches here, so the list keeps the
          // old truth).
          session2.projection.upsert({
            instanceId: instance,
            vaultId: vault,
            noteId: id,
            title: nextTitle,
            // The CURRENT parent stays authoritative (move owns the parent).
            parent: parentOfSafe(value?.relativePath),
            pending: value?.pendingKind === "create" || !value?.serverDocument,
            preview: safePreviewLine(nextContent),
            // R1.6.2-1/R1.6.3-1: a save on an ALREADY-CANONICAL note is an
            // EDIT overlay. The ACK TARGET is recorded ONLY once the exact
            // draft is clean/acknowledged (the returned note's own
            // serverDocument revision with pendingKind drained) — a dirty
            // draft carries NO target and can never retire. A pending create
            // keeps origin=create.
            origin: value?.pendingKind === "create" ? "create" : "edit",
            // A just-saved draft is DIRTY: NO ack target yet (the previous
            // serverDocument revision is NOT this draft's target). The
            // version-driven refresh records the target once clean.
            targetRemoteRevision: undefined,
            localGeneration: generation,
          });
        }
        return true;
      }).catch(() => {
        if (session === owner.current && generation === editGeneration.current) { failed.current = true; setMessage("未能保存到手机，请保留此页并重试。"); }
        return false;
      }).finally(() => {
        pending.current.delete(request);
        if (session === owner.current && pending.current.size === 0) setSaving(false);
      });
    pending.current.add(request);
    return request;
  }

  async function resolve(copy: boolean) {
    if (!currentPage.current) return;
    const pageGeneration = navigationScope.current.generation;
    await Promise.all(pending.current);
    if (failed.current) return;
    try {
      await api.contentNoteResolve(instance, vault, id, copy);
      const value = await api.contentNoteGet(instance, vault, id);
      setNote(value); setTitle(value.title); setContent(value.content);
      draft.current = { title: value.title, content: value.content };
      setSheet(""); dataStore.bump(); syncCoordinator.trigger();
      if (value.deleted && currentPage.current && pageGeneration === navigationScope.current.generation) back();
    } catch (e) { setMessage(contentError(e)); }
  }

  async function resumePaused() {
    if (resuming || !connectedPage.current) return;
    setResuming(true);
    const session = owner.current;
    try {
      await Promise.all(pending.current);
      if (failed.current || session !== owner.current) return;
      const generation = editGeneration.current;
      const currentDraft = await api.contentNoteGet(instance, vault, id);
      await resumePausedDraft({ instance, vault, id }, currentDraft, {
        isCurrent: () => session === owner.current && generation === editGeneration.current && currentPage.current && connectedPage.current,
        resume: input => api.contentNoteResumePaused(input),
        publish: value => { setNote(value); dataStore.bump(); syncCoordinator.wake(); },
      });
    } catch (e) { if (session === owner.current) setMessage(pausedRecoveryError(e)); }
    finally { if (session === owner.current) setResuming(false); }
  }

  async function remove() {
    if (!currentPage.current) return;
    const pageGeneration = navigationScope.current.generation;
    await Promise.all(pending.current);
    if (failed.current) return;
    try {
      await api.contentNoteDelete(instance, vault, id); dataStore.bump(); syncCoordinator.trigger();
      if (currentPage.current && pageGeneration === navigationScope.current.generation) back();
    }
    catch (e) {
      const code = String(e).replace(/^Error: /, "");
      if (code === "CONTENT_OPERATION_PAUSED" || code === "CONTENT_OPERATION_PENDING") { setSheet("state"); setMessage(pausedRecoveryError(e)); }
      else setMessage(contentError(e));
    }
  }

  async function attach(kind: "image" | "photo" | "file") {
    const session = owner.current;
    try {
      await Promise.all(pending.current);
      if (failed.current) return;
      const result = await api.contentNoteAttach(instance, vault, id, kind);
      if (session !== owner.current || result.cancelled) return;
      const value = result.note;
      setNote(value); setTitle(value.title); setContent(value.content);
      draft.current = { title: value.title, content: value.content };
      dataStore.bump(); syncCoordinator.trigger();
      editingLease.current?.committed();
    } catch (e) {
      if (session === owner.current) setMessage(String(e).includes("TOO_LARGE") ? "附件不能超过 64 MB。" : "附件未能加入笔记，请重试。");
    }
  }

  // -------------------------------------------------------------------------
  // ORG-1B REPAIR-R1.1 — single-note 移动到目录 (canonical knowledge.move).
  // Rename stays its own separate action; move never edits title or body.
  // -------------------------------------------------------------------------

  /** Every write-race guard runs BEFORE the destination sheet opens. */
  function openMoveSheet() {
    if (pending.current.size > 0 || saving || failed.current) {
      setSheet("");
      setMessage("正在保存到手机，请等这一版保存完成后再移动。");
      return;
    }
    if (note?.conflictDocument) { setSheet("conflict"); return; }
    if (note?.dirty) {
      setSheet("");
      setMessage("先等待同步完成后再移动。");
      return;
    }
    setSheet("");
    setMoveOpen(true);
  }

  /** The capability truth, resolved fresh while the sheet is open. */
  useEffect(() => {
    if (!moveOpen) { setMoveGate(null); return; }
    let alive = true;
    void (async () => {
      const cs = await api.connState().catch(() => null);
      if (!alive) return;
      // The CURRENT owner must still be the route's Desktop, live.
      const live = Boolean(cs?.paired && (cs as any)?.ws?.state === "connected"
        && cs?.identity?.instanceId === instance);
      if (!live) { setMoveGate({ connected: false, authority: null }); return; }
      const authority = await session.resolveMoveAuthority(instance);
      if (alive) setMoveGate({ connected: true, authority });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveOpen, instance]);

  function moveUnavailableCopy(gate: { connected: boolean; authority: MoveAuthority | null }): string {
    if (!gate.connected) return "电脑暂未连接，连接后才能移动笔记";
    const a = gate.authority;
    if (a && a.moveState !== "implemented") return "当前电脑版本不支持移动笔记";
    if (a && !a.writeGranted) return "未获电脑知识库写入授权，无法移动";
    if (a && a.vaultId && vault && a.vaultId !== vault) return "当前知识库已变化，请返回列表刷新后再试";
    return "";
  }

  async function runNoteMove(destination: string) {
    if (moving) return;
    // REPAIR-R1.3 (P1-1): the ROUTE-LIFETIME token is captured on the FIRST
    // line, BEFORE any await. Every async boundary below (connState,
    // resolveMoveAuthority, the second connState, the move itself) can
    // outlive the route — the user may have navigated to another note on the
    // SAME Desktop, whose cleanup already incremented this token. The
    // original token is the ONLY liveness identity: the presence of some
    // other `.st-detail-stage` proves nothing.
    const moveOwner = owner.current;
    const stillCurrent = () => owner.current === moveOwner;
    // Submit-time truth: connected + exact owner + real grant + proven
    // remote revision — any miss fails closed with ZERO move requests.
    const cs = await api.connState().catch(() => null);
    if (!stillCurrent()) return;
    const live = Boolean(cs?.paired && (cs as any)?.ws?.state === "connected"
      && cs?.identity?.instanceId === instance);
    if (!live) { toast.error("电脑暂未连接，连接后才能移动笔记"); return; }
    const authority = await session.resolveMoveAuthority(instance);
    // REPAIR-R1.2 (P1-1): the connection/owner can change WHILE the authority
    // resolution was pending — re-prove the current conn instance + connected
    // state (and the ORIGINAL route token) before anything is sent.
    if (!stillCurrent()) return;
    const cs2 = await api.connState().catch(() => null);
    if (!stillCurrent()) return;
    const stillLive = Boolean(cs2?.paired && (cs2 as any)?.ws?.state === "connected"
      && cs2?.identity?.instanceId === instance);
    if (!stillLive) { toast.error("电脑或所选范围已变化，已取消移动"); return; }
    if (authority.moveState !== "implemented") { toast.error("当前电脑版本不支持移动笔记"); return; }
    if (!authority.writeGranted) { toast.error("未获电脑知识库写入授权，无法移动"); return; }
    if (!authority.vaultId || authority.vaultId !== vault) { toast.error("当前知识库已变化，请返回列表刷新后再试"); return; }
    // The MOVE baseline is the LATEST REMOTE revision (the serverDocument
    // observation) — never the cached-body revision the editor bases on.
    const expectedRevision = note?.serverDocument?.revision || "";
    if (!expectedRevision) { toast.error("无法确认这篇笔记的最新版本，请刷新后再试。"); return; }
    if (note?.dirty) { toast.error("先等待同步完成后再移动。"); return; }
    const currentParent = note?.relativePath ? parentOf(String(note.relativePath)) : "";
    if (destination === currentParent) { setMoveOpen(false); toast.info("这篇笔记已在该目录"); return; }
    setMoving(true);
    const r = await orgCtrl.moveOne(session.moveDeps({
      // The ORIGINAL route token is the whole fence (R1.3: never a token
      // captured after an await, never a generic detail-stage DOM check).
      isLive: stillCurrent,
      onCommitted: (committed) => {
        // The two visible row authorities re-project in place — each NO-OPs
        // unless its CURRENT owner/vault is exactly the receipt's ORIGINAL
        // scope (a late A receipt can never touch B's rows) — a moved-out row
        // leaves the open directory immediately; the canonical retained row
        // re-parents. Nothing blanks, no per-note remote detail.
        session.directory.applyMoveReceipt(committed.instanceId, committed.vaultId, committed.noteId, committed.parentRelativePath, committed.revision);
        session.desktop.applyMoveReceipt(committed.instanceId, committed.vaultId, committed.noteId, committed.parentRelativePath, committed.revision);
      },
    }), {
      instanceId: instance, vaultId: authority.vaultId, noteId: id,
      expectedRevision, currentParent,
    }, destination);
    // REPAIR-R1.3 (P1-3): a stale completion applies NO UI for the dead
    // route — no toast, no sheet close, no note reread. The Desktop commit
    // and the original-scope DB receipt stay real.
    if (!stillCurrent()) return;
    setMoving(false);
    if (r.ok) {
      setMoveOpen(false);
      toast.success("已移动");
      // Metadata-only convergence of the mounted editor's own view. This
      // reread runs only AFTER the controller awaited the Mobile-local
      // receipt attempt, so it can no longer race the OLD path.
      void api.contentNoteGet(instance, vault, id).then((value) => {
        if (stillCurrent()) setNote(value);
      }).catch(() => {});
    } else {
      toast.error(r.reason || "移动失败");
    }
  }

  function insertFormat(marker: string) {
    const handle = pageEditorHandle();
    if (handle) {
      if (handle.isComposing() || handle.compositionStarted()) return;
      // CM6-EDITOR-R1: a USER transaction — history + the normal
      // onChange → edit() → durable publish chain, exactly once.
      const pos = formatSel ?? handle.getSelection();
      const insertion = formatInsertion(marker, handle.getValue().slice(pos.start, pos.end));
      handle.focus();
      handle.replaceRange(insertion, pos);
      setSheet("");
      return;
    }
    const el = pageEditorHost() as HTMLTextAreaElement | null;
    const pos = formatSel ?? (el ? { start: el.selectionStart ?? content.length, end: el.selectionEnd ?? content.length } : { start: content.length, end: content.length });
    const insertion = formatInsertion(marker, content.slice(pos.start, pos.end));
    edit(title, content.slice(0, pos.start) + insertion + content.slice(pos.end));
    setSheet("");
    setTimeout(() => {
      const editor = pageEditorHost() as HTMLTextAreaElement | null;
      if (editor) { editor.focus(); editor.setSelectionRange(pos.start + insertion.length, pos.start + insertion.length); }
    }, 0);
  }

  const loaded = hasReadableBody(note);
  // R1.6.1-5: in EDIT mode a routine pending (saved on the phone, waiting
  // for the background sync) maps to the NEUTRAL synced visual — the
  // underlying provenance is unchanged, READ mode and 来源与状态 keep the
  // real pending/offline truth, and errors/conflicts/metadata still surface.
  const provenanceState = failed.current ? "error" : stillNoteState(note, false);
  const needsAttention = note?.operationPaused || note?.titleNeedsCorrection;
  const state: NoteState = mode === "edit" && provenanceState === "pending" && !needsAttention ? "synced" : provenanceState;
  // R1.6-D: routine Desktop autosave/sync is QUIET — ordinary typing must
  // not flash 正在保存/已存到手机 states (and must not re-announce through
  // any live region on every keystroke). Real failures still show; the
  // 来源与状态 page keeps the full pending/offline truth.
  const savedLabel = needsAttention ? noteStatus(note).headerLabel : mode === "edit"
    ? (failed.current ? "尚未保存 · 请保留此页重试" : "电脑知识库")
    : note ? noteStatus(note).headerLabel : "电脑知识库";
  const desktopConflict = note?.conflictDocument
    ? { mine: content, theirs: note.conflictDocument.deleted ? "电脑端已删除此笔记" : note.conflictDocument.content ?? "等待获取电脑版本" }
    : null;

  return (
    <>
      <NoteSurface
        title={title}
        body={content}
        notebook={note?.vaultName || "LuckyRay 知识库"}
        // Hidden reading children stay mounted; currentPage/navigationScope
        // independently deny their input and late navigation authority.
        readingContent={(current || retained) && mode === "read" && loaded && loadedNoteScope === JSON.stringify([instance, vault, id]) ? <NoteReadingContent scope={cmScope("desktop", instance, vault, id)} body={content} title={title}
          search={searchTarget} onSearchChange={setSearchTarget} onDismissSearch={() => setSearchTarget(undefined)}>{find => <DesktopKnowledgeReader
          key={JSON.stringify([instance, vault, id, epoch.current])}
          instance={instance} vault={vault} note={id} content={content} resources={cachedResources(note)} online={connectedOwner}
          revision={displayedRevision.current} clean={!note?.dirty && !note?.bodyOutdated && !note?.conflictDocument
            && !deferredIncoming.current && !pending.current.size && !failed.current && content === note?.content}
          onNavigate={openLinkedNote} find={find}
        />}</NoteReadingContent> : undefined}
        state={state}
        mode={mode}
        savedLabel={savedLabel}
        onBack={() => void guardedBack()}
        onBrowse={() => void browseCurrentNotes("browser")}
        onMore={() => setSheet("more")}
        onNew={() => void createSiblingNote()}
        onEdit={(offset) => {
          if (!currentPage.current || !loaded || loadedNoteScope !== JSON.stringify([instance, vault, id])) return;
          if (offset !== undefined) setBodyFocus({ scope: cmScope("desktop", instance, vault, id), offset });
          setMode("edit");
        }}
        onRead={() => void enterReading()}
        onChange={(t, b) => edit(t, b)}
        onCommand={command => { pageEditorHandle()?.runCommand(command); }}
        onFormat={() => {
          const handle = pageEditorHandle();
          if (handle) {
            if (handle.isComposing() || handle.compositionStarted()) return;
            setFormatSel(handle.getSelection()); setSheet("format"); return;
          }
          const el = pageEditorHost() as HTMLTextAreaElement | null;
          setFormatSel(el ? { start: el.selectionStart ?? content.length, end: el.selectionEnd ?? content.length } : null);
          setSheet("format");
        }}
        onSearch={() => void browseCurrentNotes()}
        onState={() => setSheet(note?.conflictDocument ? "conflict" : "state")}
        onRelations={() => setSheet("relations")}
        onAttach={() => { const handle = pageEditorHandle(); if (handle?.isComposing() || handle?.compositionStarted()) return; setSheet("attach"); }}
        bodyEditor={<MobileCmEditor
          sourceMode={sourceMode}
          scope={cmScope("desktop", instance, vault, id)}
          wikiLoader={query => wikiChoices(query, {instance, vault})} assistActive={current && !sheet && mode === "edit"}
          imageScope={{instance, vault, note:id, resources:cachedResources(note), online:current && connectedOwner}}
          value={content}
          search={searchTarget}
          searchActive={current && mode === "edit"}
          onDismissSearch={() => setSearchTarget(undefined)}
          onChange={(next) => { void edit(title, next); }}
          placeholderText=""
          focusRequest={bodyFocus}
        />}
      />
      {sheet === "relations" ? <Sheet title="双向链接" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
        {current && loaded && loadedNoteScope === JSON.stringify([instance, vault, id]) ? <DesktopKnowledgeReader
          panelOnly instance={instance} vault={vault} note={id} content={content} resources={cachedResources(note)} online={connectedOwner}
          revision={displayedRevision.current} clean={!note?.dirty && !note?.bodyOutdated && !note?.conflictDocument
            && !deferredIncoming.current && !pending.current.size && !failed.current && content === note?.content}
          onNavigate={async (noteId, isCurrent) => { await openLinkedNote(noteId, isCurrent); }}
        /> : <p className="st-sheet-copy">笔记载入后可查看链接。</p>}
      </Sheet> : null}
      {message ? <div className="st-notice danger" role="status">{message}</div> : null}
      {desktopBusy ? <div className="st-notice" role="status">电脑正在编辑 · 你的修改已保存在手机，电脑保存后会自动继续同步</div> : null}
      {desktopEditing && !desktopBusy && !note?.conflictDocument ? <div className="st-notice" role="status">电脑正在编辑 · 编辑提示不影响手机保存</div> : null}
      {note?.createCollisionBlocked ? (
        <div className="st-notice danger" role="status">同名笔记过多，已暂停自动创建。修改标题后会重新尝试。</div>
      ) : null}
      {sheet === "more" ? (
        <Sheet title={title || "笔记"} registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          {loaded ? <Option label="重命名" iconSlot={<NoteActionIcon name="rename" size={23}/>} onClick={() => { setRenameValue(title); setRenameOpen(true); }} /> : null}
          {/* ORG-1B: an INDEPENDENT move action — rename stays its own path. */}
          <Option label="移动到目录" iconSlot={<NoteActionIcon name="folder" size={23}/>} onClick={() => { openMoveSheet(); }} />
          <Option label={sourceMode ? "退出源码模式" : "源码模式"} iconSlot={<NoteActionIcon name="code" size={23}/>} selected={sourceMode} onClick={() => {
            if (!loaded || !current) return;
            const editor = pageEditorHandle();
            if (editor?.isComposing() || editor?.compositionStarted()) return;
            setSourceMode(value => !value); setMode("edit"); setSheet("");
          }} />
          <Option label="编辑工具栏" iconSlot={<NoteActionIcon name="tools" size={23}/>} onClick={() => setSheet("toolbar")} />
          <Option label="查看来源与状态" iconSlot={<NoteActionIcon name="info" size={23}/>} onClick={() => setSheet("state")} />
          <Option label={note?.operationPaused ? "删除前先处理同步暂停" : "删除这篇电脑笔记"} iconSlot={<NoteActionIcon name="trash" size={23}/>} danger={!note?.operationPaused} onClick={() => openNoteDeletion(note, setSheet)} />
        </Sheet>
      ) : null}
      {sheet === "state" ? (
        <Sheet title="来源与状态" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <div className="st-metadata-row"><span>来源</span><b>电脑知识库</b></div>
          <div className="st-metadata-row"><span>编辑提示</span><b>{editingHintLabel(mode === "edit" && current && connectedOwner && !document.hidden && mobileEditingHint.scope === JSON.stringify([instance, vault, id]) ? mobileEditingHint.hint : "disabled")}</b></div>
          {message.includes("笔记未删除") ? <p className="st-sheet-copy" role="status">{message}</p> : null}
          {note?.createCollisionBlocked ? (
            <p className="st-sheet-copy" role="status">同名笔记过多，已暂停自动创建。修改标题后会重新尝试。</p>
          ) : null}
          {note?.titleNeedsCorrection ? <p className="st-sheet-copy" role="status">标题和正文已保存在手机。请填写有效标题后继续同步；不会替你修改标题。</p> : null}
          {note?.operationPaused ? <>
            <p className="st-sheet-copy">请先处理同步暂停，再删除此笔记；现在没有删除或丢弃任何草稿。</p>
            <p className="st-sheet-copy" role="status">旧重命名请求因空标题被拒绝，已暂停自动发送；草稿和原请求完整保留。服务端旧意图状态仍未知。下方操作会用当前有效标题和正文建立新的请求，保留原版本基线；桌面已有修改时将显示真实冲突，不会强制覆盖。</p>
            <Button disabled={resuming || saving || !connectedOwner || note.titleNeedsCorrection || Boolean(note.conflictDocument)} onClick={() => void resumePaused()}>使用当前草稿建立新请求</Button>
          </> : null}
          <p className="st-sheet-copy">
            {desktopBusy ? "电脑正在编辑 · 你的修改已保存在手机，电脑保存后会自动继续同步"
              : state === "metadata" ? "没有可读正文，不能当作空笔记覆盖电脑。正文尚未缓存，连接电脑获取完整笔记后才能重命名。"
              : state === "outdated" ? "手机中的正文仍可阅读；编辑基线保持缓存正文的 revision。"
              : state === "pending" ? "已经保存在手机，尚未同步到电脑。"
              : "当前缓存可阅读，实际状态来自 noteStatus()。"}
          </p>
          <Option label="查看电脑连接" icon="monitor" onClick={() => { setSheet(""); open("connect"); }} />
          <Option label="查看同步诊断" icon="info" onClick={() => { setSheet(""); open("diagnostics"); }} />
        </Sheet>
      ) : null}
      {sheet === "conflict" && desktopConflict ? (
        <Sheet title="保留两边的想法" registerDismiss={registerOverlay} onClose={() => setSheet("")}
          footer={<>
            <Button kind="quiet" onClick={() => void resolve(false)}>采用电脑版本</Button>
            <Button onClick={() => void resolve(true)}>保留手机副本</Button>
          </>}>
          <p className="st-sheet-copy">这篇笔记在手机和电脑上都有修改。先看看差异，不自动覆盖任何一边。</p>
          <div className="st-conflict-versions">
            <section><h3>手机上的版本</h3><p>{desktopConflict.mine}</p></section>
            <section><h3>电脑上的版本</h3><p>{desktopConflict.theirs}</p></section>
          </div>
        </Sheet>
      ) : null}
      {sheet === "toolbar" ? <EditorToolbarSheet registerOverlay={registerOverlay} onClose={() => setSheet("")} /> : null}
      {sheet === "format" ? (
        <Sheet title="文本格式" retainEditorFocus registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          {([["小标题", "\n\n## "], ["无序列表", "\n- "], ["待办事项", "\n- [ ] "], ["引用", "\n> "], ["链接", "\n[链接文字](https://)"]] as const).map(([label, marker]) => (
            <Option key={label} label={label} icon={({"小标题":"heading","无序列表":"bullet","待办事项":"task","引用":"quote","链接":"link"} as Record<string,string>)[label]} onClick={() => insertFormat(marker)} />
          ))}
        </Sheet>
      ) : null}
      {sheet === "attach" ? (
        <Sheet title="插入附件" registerDismiss={registerOverlay} onClose={() => setSheet("")}>
          <Option label="图片" icon="image" onClick={() => { setSheet(""); void attach("image"); }} />
          <Option label="拍照" icon="camera" onClick={() => { setSheet(""); void attach("photo"); }} />
          <Option label="文件" icon="file" onClick={() => { setSheet(""); void attach("file"); }} />
        </Sheet>
      ) : null}
      {sheet === "delete" ? (
        <Sheet title="删除这篇电脑笔记？" registerDismiss={registerOverlay} onClose={() => setSheet("")}
          footer={<>
            <Button kind="quiet" onClick={() => setSheet("")}>取消</Button>
            <Button kind="danger" onClick={() => { setSheet(""); void remove(); }}>删除</Button>
          </>}>
          <p className="st-sheet-copy">删除会在连接恢复后同步到电脑。尚未同步前，正文仍保存在手机。</p>
        </Sheet>
      ) : null}
      {renameOpen ? (
        <Sheet title="重命名" registerDismiss={registerOverlay} onClose={() => setRenameOpen(false)} busy={renaming}
          footer={<>
            <Button kind="quiet" onClick={() => setRenameOpen(false)}>取消</Button>
            <Button disabled={renaming || !renameValue.trim() || renameValue.trim() === title} onClick={() => {
              const next = renameValue.trim();
              setRenaming(true);
              // body bytes unchanged → the op pipeline commits kind:"rename"
              edit(next, content).then((ok) => {
                if (ok) { setRenameOpen(false); }
                else { setRenameValue(next); } // failure keeps the sheet + text
                setRenaming(false);
              });
            }}>重命名</Button>
          </>}>
          <label className="st-field">新标题
            <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          </label>
        </Sheet>
      ) : null}
      {/* ORG-1B: the move destination — ROOT + the existing synced
          directories ONLY (no create/rename); the truthful fail-closed
          notice shows while the capability is unproven or unavailable. */}
      {moveOpen ? (
        <DirectorySheet
          registerOverlay={registerOverlay}
          onClose={() => { if (!moving) setMoveOpen(false); }}
          instanceId={instance}
          vaultId={vault}
          vaultName={note?.vaultName || "LuckyRay 知识库"}
          connected={Boolean(moveGate?.connected)}
          current={note?.relativePath ? parentOf(String(note.relativePath)) : ""}
          title="移动到目录"
          rootLabel="根目录（全部笔记）"
          notice={moveGate ? (moveUnavailableCopy(moveGate) || undefined) : "正在确认电脑授权…"}
          onSelect={(dir) => { void runNoteMove(dir); }}
        />
      ) : null}
      {sheet === "switcher" || sheet === "browser" ? (
        <NoteSwitcherSheet variant={sheet === "browser" ? "browse" : "search"} currentRoute={desktopNoteRoute(instance, vault, id)} key={JSON.stringify([instance, vault, scopeParent, sheet])}
          scope={{ instance, vault, directory: "" }} enabled={canUseScope}
          onClose={() => setSheet("")} registerOverlay={registerOverlay}
          onPick={async (route, target, isCurrent) => {
            if (!(await guardNavigation()) || !isCurrent()) return;
            setSheet("");
            if (route === desktopNoteRoute(instance, vault, id) && !target) { setSearchTarget(undefined); setBodyFocus(undefined); setMode("read"); }
            else open("note", route, { noteSearch: target });
          }} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 新笔记 — the authority new-note composition, real creation
// ---------------------------------------------------------------------------

export function StillNewNote() {
  const { open, back, registerOverlay } = useStillNav();
  const [sheet, setSheet] = useState<"" | "switcher">("");
  const [busy, setBusy] = useState(false);
  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const note = await api.localNoteAdd("新笔记", "", []);
      localDataStore.publish("note");
      open("note", note.noteId, { edit: true });
    } catch (e: any) {
      toast.error(failureCopy(e, "新建笔记失败。"));
    } finally { setBusy(false); }
  }
  return (
    <>
      <div className="st-note-surface">
        <Header title="新的想法" left={<IconButton icon="knowledge" label="打开笔记列表" onClick={() => setSheet("switcher")} />}
          right={<IconButton icon="more" label="更多操作" onClick={() => setSheet("switcher")} />} />
        <div className="st-new-empty">
          <div>
            <p>留一点空白，<br />给还没有写下的想法。</p>
            <Button kind="quiet" onClick={() => void create()}>{busy ? "正在创建…" : "新建笔记"}</Button>
            <Button kind="quiet" onClick={() => setSheet("switcher")}>打开已有笔记</Button>
          </div>
        </div>
        <div className="st-reader-bottom">
          <div className="st-reader-tools">
            <IconButton icon="back" label="返回上一页" onClick={back} />
            <IconButton icon="search" label="查找笔记" onClick={() => setSheet("switcher")} />
            <IconButton icon="plus" label="新建笔记" onClick={() => void create()} />
            <IconButton icon="folder" label="浏览笔记" onClick={() => setSheet("switcher")} />
          </div>
        </div>
      </div>
      {sheet === "switcher" ? (
        <NoteSwitcherSheet onClose={() => setSheet("")} registerOverlay={registerOverlay} onPick={(route, target) => { setSheet(""); open("note", route, { noteSearch: target }); }} />
      ) : null}
    </>
  );
}
