// NoteEditor.tsx (M2.8 Standalone Knowledge & Autosave / STITCH-R6 visuals)
//
// Visual source: R6 `function noteEditor()` — back header with a save action,
// status line, borderless title/body editor, meta row, and a compact action
// row. Local and Desktop notes share this shell.
//
// Behaviour source: production, unchanged. Supports local Mobile-owned notes
// (id starts with "note-") with the single-flight debounced autosave
// coordinator, blur/unmount/background draft protection, tag management,
// pin/favorite, and deletion. Desktop synced notes continue using the
// revision-check fallback (isRevisionConflictError from the shared protocol).
import { useEffect, useRef, useState } from "react";
import { api } from "../services/client";
import { IconCheck } from "../components/icons";
import { BackHeader, Notice } from "../components/ui";
import { isRevisionConflictError } from "../../shared/protocol-v1/typescript/index.ts";
import { LocalNoteAutosaveCoordinator, type SaveStatus } from "../services/localNoteAutosave";
import { localDataStore, publishAfter } from "../services/localDataStore";

export default function NoteEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const isLocal = id.startsWith("note-");

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [pinned, setPinned] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [archived, setArchived] = useState(false);

  // Desktop note states
  const [revision, setRevision] = useState("");
  const [dirty, setDirty] = useState(false);

  // Autosave status
  const [saveState, setSaveState] = useState<SaveStatus>("saved");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // Coordinator ref (hydration correctness is handled deterministically in the field
  // sync effect below: a hydration echo never becomes a fake edit generation).
  const coordinatorRef = useRef<LocalNoteAutosaveCoordinator | null>(null);

  // Load Note and initialize coordinator
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (isLocal) {
          const n = await api.localNoteGet(id);
          if (alive) {
            setTitle(n.title ?? "");
            setContent(n.content ?? "");
            setTags(n.tags ?? []);
            setPinned(Boolean(n.pinned));
            setFavorite(Boolean(n.favorite));
            setArchived(Boolean(n.archived));

            const initialSnap = { title: n.title ?? "", content: n.content ?? "", tags: n.tags ?? [] };
            if (!coordinatorRef.current || coordinatorRef.current.getNoteId() !== id) {
              coordinatorRef.current?.dispose();
              coordinatorRef.current = new LocalNoteAutosaveCoordinator(
                id,
                initialSnap,
                async (snap) => {
                  await api.localNoteUpdate(id, snap.title, snap.content, snap.tags);
                  // M2.10 Scope D: a successful Local Note save invalidates
                  // local data consumers (Home recent/counts, lists, search).
                  localDataStore.publish("note");
                },
                1000
              );
              coordinatorRef.current.subscribe((st, err) => {
                setSaveState(st);
                if (err) setMsg("自动保存失败: " + err);
              });
            } else {
              coordinatorRef.current.resetBase(initialSnap);
            }
          }
        } else {
          const n = await api.noteGet(id);
          if (alive) {
            setTitle(n.title ?? "");
            setContent(n.content ?? "");
            setRevision(n.revision ?? "");
            setDirty(Boolean(n.dirty));
          }
        }
      } catch (e: any) {
        if (alive) setMsg("加载笔记失败: " + e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, isLocal]);

  // Update coordinator ONLY for real user edits (FIX-V2 P1-A hydration correctness).
  // The field-sync effect also fires for the hydration echo (React applies the loaded
  // fields through setState). When the fields equal the coordinator's committed base
  // snapshot and nothing is dirty, it is a hydration echo — NOT a user edit — and must
  // NOT create a fake edit generation / autosave / updated_at bump. Opening a note and
  // waiting > debounce with no user edit must produce ZERO save writes.
  useEffect(() => {
    if (!isLocal || !coordinatorRef.current) return;
    const snap = { title, content, tags };
    const cur = coordinatorRef.current.getLatestSnapshot();
    const unchanged =
      cur.title === snap.title &&
      cur.content === snap.content &&
      cur.tags.length === snap.tags.length &&
      cur.tags.every((t, i) => t === snap.tags[i]);
    if (unchanged && !coordinatorRef.current.isDirty()) {
      return;
    }
    coordinatorRef.current.updateSnapshot(snap);
  }, [title, content, tags, isLocal]);

  // Unmount / Visibility / Blur flush protection
  // Fire-and-forget flushes share the SAME single drain (FIX-V2 P1-A); rejections are
  // swallowed here because the status is already "error" and the UI shows it.
  useEffect(() => {
    if (!isLocal) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && coordinatorRef.current?.isDirty()) {
        void coordinatorRef.current.flush().catch(() => {});
      }
    };

    const handleWindowBlur = () => {
      if (coordinatorRef.current?.isDirty()) {
        void coordinatorRef.current.flush().catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
      // Unmount fires an already-required final drain; it must NOT be cancelled by
      // dispose() and keeps running to completion (FIX-V2 P1-A).
      if (coordinatorRef.current?.isDirty()) {
        void coordinatorRef.current.flush().catch(() => {});
      }
    };
  }, [isLocal]);

  // Handle explicit Manual Save
  async function handleManualSave() {
    setBusy(true);
    setMsg("");
    try {
      if (isLocal) {
        if (coordinatorRef.current) {
          await coordinatorRef.current.flush();
        }
        setMsg("已保存到本地笔记");
      } else {
        const updated = await api.noteUpdate(id, revision, content, title);
        setRevision(updated.revision);
        setDirty(false);
        setMsg("已同步 (rev " + updated.revision.slice(0, 8) + ")");
      }
    } catch (e: any) {
      if (isRevisionConflictError(e)) {
        setMsg("冲突：Desktop 端已修改此笔记。已保留本地修改为草稿，请刷新后重试。");
        setDirty(true);
      } else {
        setMsg("保存失败: " + e);
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveDesktopLocal() {
    setBusy(true);
    setMsg("");
    try {
      await api.noteLocalEdit(id, title, content);
      setDirty(true);
      setMsg("已本地保存（离线草稿，待推送）");
    } catch (e: any) {
      setMsg("本地保存失败: " + e);
    } finally {
      setBusy(false);
    }
  }

  async function refreshDesktopNote() {
    setBusy(true);
    try {
      const n = await api.noteRefresh(id);
      setTitle(n.title ?? "");
      setContent(n.content ?? "");
      setRevision(n.revision ?? "");
      setDirty(false);
      setMsg("已刷新");
    } catch (e: any) {
      setMsg("刷新失败: " + e);
    } finally {
      setBusy(false);
    }
  }

  async function toggleLocalPin() {
    if (!isLocal) return;
    try {
      // FIX-V1 P1-3D: publish only after the flag commit succeeds.
      await publishAfter("note", api.localNoteSetFlags(id, { pinned: !pinned }));
      setPinned(!pinned);
    } catch (e: any) {
      setMsg("操作失败: " + e);
    }
  }

  async function toggleLocalFavorite() {
    if (!isLocal) return;
    try {
      // FIX-V1 P1-3D: publish only after the flag commit succeeds.
      await publishAfter("note", api.localNoteSetFlags(id, { favorite: !favorite }));
      setFavorite(!favorite);
    } catch (e: any) {
      setMsg("操作失败: " + e);
    }
  }

  async function toggleLocalArchived() {
    if (!isLocal) return;
    try {
      // FIX-V1 P1-3D: publish only after the flag commit succeeds.
      await publishAfter("note", api.localNoteSetFlags(id, { archived: !archived }));
      setArchived(!archived);
    } catch (e: any) {
      setMsg("操作失败: " + e);
    }
  }

  async function deleteLocalNote() {
    if (!isLocal) return;
    if (!window.confirm("确定删除这条本地笔记？此操作不可撤销。")) return;
    try {
      // FIX-V1 P1-3D: publish only after the delete succeeds.
      await publishAfter("note", api.localNoteDelete(id));
      onBack();
    } catch (e: any) {
      setMsg("删除笔记失败: " + e);
    }
  }

  function addTag() {
    const trimmed = tagInput.trim().replace(/^#/, "");
    if (!trimmed) return;
    if (!tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput("");
  }

  function removeTag(tagToRemove: string) {
    setTags(tags.filter((t) => t !== tagToRemove));
  }

  async function handleBack() {
    if (isLocal && coordinatorRef.current?.isDirty()) {
      try {
        setBusy(true);
        await coordinatorRef.current.flush();
      } catch (e: any) {
        setMsg("退出保存失败，仍停留在编辑界面: " + e);
        setBusy(false);
        return; // Failed final flush stops navigation away per Task Card P1-1
      } finally {
        setBusy(false);
      }
    }
    onBack();
  }

  function handleFieldBlur() {
    if (isLocal && coordinatorRef.current?.isDirty()) {
      void coordinatorRef.current.flush().catch(() => {});
    }
  }

  const statusText = isLocal
    ? saveState === "saving"
      ? "正在保存…"
      : saveState === "unsaved"
        ? "未保存"
        : saveState === "error"
          ? "保存出错"
          : "已自动保存"
    : dirty
      ? "本地草稿 · 待同步"
      : "已同步";

  return (
    <>
      <BackHeader
        title={isLocal ? "本地笔记" : "电脑笔记"}
        onBack={handleBack}
        right={
          isLocal ? undefined : (
            <button className="nav-action accent" onClick={handleManualSave} disabled={busy} aria-label="立即保存">
              <IconCheck size={18} />
            </button>
          )
        }
      />

      <div className="editor-status" role="status">{statusText}</div>

      <input
        className="editor-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleFieldBlur}
        placeholder="笔记标题…"
      />

      <textarea
        className="editor-body"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onBlur={handleFieldBlur}
        placeholder="在此输入笔记内容（纯文本保存；Markdown 语法原样保留）"
      />

      {msg ? <Notice tone={saveState === "error" ? "danger" : "neutral"}>{msg}</Notice> : null}

      {/* Local-note secondary actions in normal document flow (REAL-DEVICE-
          UI-POLISH-R1): every capability stays discoverable right after the
          body — no artificial fold spacer, no gesture-hidden controls. */}
      {isLocal ? (
        <div className="note-actions">
          <div className="chip-scroll">
            <button
              className={"chip" + (pinned ? " active" : "")}
              onClick={toggleLocalPin}
              aria-pressed={pinned}
            >
              {pinned ? "已置顶" : "置顶"}
            </button>
            <button
              className={"chip" + (favorite ? " active" : "")}
              onClick={toggleLocalFavorite}
              aria-pressed={favorite}
            >
              {favorite ? "已收藏" : "收藏"}
            </button>
            {tags.map((t) => (
              <button key={t} className="chip active" onClick={() => removeTag(t)} title="点击移除标签">
                #{t} ✕
              </button>
            ))}
            <input
              className="chip"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="+ 标签"
              style={{ width: 86, color: "var(--tertiary)" }}
            />
          </div>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={handleManualSave} disabled={busy}>
              保存
            </button>
            <button className="quiet" onClick={toggleLocalArchived} disabled={busy}>
              {archived ? "恢复归档" : "归档"}
            </button>
            <button className="danger-btn" onClick={deleteLocalNote}>
              删除
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="editor-meta-row" style={{ marginTop: 14 }}>
            <span className="chip">rev {revision.slice(0, 8)}</span>
            {dirty ? <span className="chip danger">本地草稿</span> : null}
          </div>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="quiet" onClick={saveDesktopLocal} disabled={busy}>
              本地保存
            </button>
            <button className="quiet" onClick={refreshDesktopNote} disabled={busy}>
              刷新
            </button>
            <button className="primary" onClick={handleManualSave} disabled={busy}>
              推送并校验
            </button>
          </div>
        </>
      )}
    </>
  );
}
