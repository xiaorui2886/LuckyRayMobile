// DesktopNoteEditor.tsx (STITCH-R6) — 电脑笔记编辑/阅读.
//
// Visual source: R6 desktop-note editor — back header with the read/edit
// toggle, editor status line, conflict card + version comparison, editor
// title/body, and attachment row.
//
// Behaviour source: production, unchanged. All conflict/dirty/attach/epoch
// logic stays intact, and readability still comes from the cached BODY
// provenance (noteProvenance) — never from the latest remote summary.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../services/client";
import { IconCamera, IconFile, IconImage } from "../components/icons";
import { EmptyState, Notice, BackHeader } from "../components/ui";
import { dataStore } from "../services/dataStore";
import { syncCoordinator } from "../services/syncCoordinator";
import { contentError } from "../components/DesktopLibrary";
import DesktopNotePreview from "../components/DesktopNotePreview";
import { cachedBodyNotice, cachedResources, hasReadableBody, missingBodyMessage, noteStatus } from "../services/noteProvenance";

export default function DesktopNoteEditor({route, onBack}: {route: string; onBack: () => void}) {
  const parts = route.split(":");
  const instance = decodeURIComponent(parts[1] || "");
  const vault = decodeURIComponent(parts[2] || "");
  const id = parts[3] || "";
  const [note, setNote] = useState<any>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState(true);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [showConflict, setShowConflict] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const owner = useRef(0);
  const editGeneration = useRef(0);
  const epoch = useRef(0);
  const pending = useRef(new Set<Promise<unknown>>());
  const failed = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = useRef({title: "", content: ""});
  const version = useSyncExternalStore(fn => dataStore.subscribe(fn), () => dataStore.getVersion());
  const backAction = useRef<() => Promise<void>>(async () => {});
  backAction.current = back;
  useEffect(() => {
    const listener = (event: Event) => {event.preventDefault(); void backAction.current();};
    window.addEventListener("luckyray:desktop-note-back", listener);
    return () => window.removeEventListener("luckyray:desktop-note-back", listener);
  }, []);

  useEffect(() => {
    const session = ++owner.current;
    editGeneration.current = 0; failed.current = false;
    epoch.current = 0;
    setNote(null); setMessage(""); setPreview(true);
    void api.contentNoteBegin(instance, vault, id).then(async cached => {
      if (session !== owner.current) return;
      epoch.current = cached.editorEpoch;
      setNote(cached); setTitle(cached.title); setContent(cached.content); draft.current = {title: cached.title, content: cached.content};
      const gen = editGeneration.current;
      try {
        const fresh = await api.contentNoteRefresh(instance, vault, id);
        if (session !== owner.current) return;
        setNote(fresh);
        if (gen === editGeneration.current && pending.current.size === 0) {
          setTitle(fresh.title); setContent(fresh.content); draft.current = {title: fresh.title, content: fresh.content};
        }
      } catch {
        // Decide readability from the CACHED BODY, never from the latest
        // summary: a metadata-only remote observation must not make a still
        // readable offline note look uncached.
        const missing = missingBodyMessage(cached);
        if (session === owner.current && missing) setMessage(missing);
      }
    }).catch(e => { if (session === owner.current) setMessage(contentError(e)); });
    return () => {
      owner.current++;
      if (syncTimer.current) clearTimeout(syncTimer.current);
      dataStore.bump();
      syncCoordinator.trigger();
    };
  }, [instance, vault, id]);

  useEffect(() => {
    if (!epoch.current) return;
    const session = owner.current;
    const gen = editGeneration.current;
    void api.contentNoteGet(instance, vault, id).then(value => {
      if (session !== owner.current) return;
      setNote(value);
      if (gen === editGeneration.current && pending.current.size === 0 && !failed.current) {
        setTitle(value.title); setContent(value.content); draft.current = {title: value.title, content: value.content};
      }
    }).catch(() => {});
  }, [version, instance, vault, id]);

  function edit(nextTitle: string, nextContent: string) {
    setTitle(nextTitle); setContent(nextContent); draft.current = {title: nextTitle, content: nextContent};
    const generation = ++editGeneration.current;
    const session = owner.current;
    setSaving(true); setMessage("");
    const request = api.contentNoteEdit({instance, vault, id, title: nextTitle, content: nextContent, epoch: epoch.current, generation})
      .then(value => {
        if (session === owner.current && generation === editGeneration.current) {failed.current = false; setNote(value);}
      }).catch(() => {
        if (session === owner.current && generation === editGeneration.current) {failed.current = true; setMessage("未能保存到手机，请保留此页并重试。");}
      }).finally(() => {
        pending.current.delete(request);
        if (session === owner.current && pending.current.size === 0) setSaving(false);
      });
    pending.current.add(request);
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => { syncCoordinator.trigger(); }, 700);
  }

  async function back() {
    if (attaching) return;
    await Promise.all(pending.current);
    if (failed.current) { setMessage("手机尚未保存成功，请重试保存后返回。"); return; }
    onBack();
  }
  async function resolve(copy: boolean) {
    await Promise.all(pending.current);
    if (failed.current) return;
    try {
      await api.contentNoteResolve(instance, vault, id, copy);
      const value = await api.contentNoteGet(instance, vault, id);
      setNote(value); setTitle(value.title); setContent(value.content); draft.current = {title: value.title, content: value.content};
      setShowConflict(false); dataStore.bump(); syncCoordinator.trigger();
      if (value.deleted) onBack();
    } catch (e) { setMessage(contentError(e)); }
  }
  async function remove() {
    await Promise.all(pending.current);
    if (failed.current) return;
    try { await api.contentNoteDelete(instance, vault, id); dataStore.bump(); syncCoordinator.trigger(); onBack(); }
    catch (e) { setMessage(contentError(e)); }
  }

  async function attach(kind: "image" | "photo" | "file") {
    if (attaching) return;
    setAttaching(true);
    const session = owner.current;
    try {
      await Promise.all(pending.current);
      if (failed.current) return;
      const result = await api.contentNoteAttach(instance, vault, id, kind);
      if (session !== owner.current || result.cancelled) return;
      const value = result.note;
      setNote(value); setTitle(value.title); setContent(value.content);
      draft.current = {title: value.title, content: value.content};
      dataStore.bump(); syncCoordinator.trigger();
    } catch (e) {
      if (session === owner.current) setMessage(String(e).includes("TOO_LARGE") ? "附件不能超过 64 MB。" : "附件未能加入笔记，请重试。");
    } finally { if (session === owner.current) setAttaching(false); }
  }

  // Readability comes from the cached BODY provenance (a dirty draft is
  // always readable); a bodyless remote summary must not disable the editor.
  const loaded = hasReadableBody(note);
  const staleNotice = cachedBodyNotice(note);
  return <>
    <BackHeader
      title="电脑笔记"
      backLabel="返回知识库"
      onBack={() => void back()}
      right={
        <button className="chip" disabled={!loaded} onClick={() => setPreview((v) => !v)}>
          {preview ? "编辑" : "阅读"}
        </button>
      }
    />

    <div className="editor-status" role="status">
      {saving
        ? "正在保存到手机…"
        : note
          // SAME authority as the list badge, so the two surfaces can never
          // disagree about the same note.
          ? noteStatus(note).headerLabel
          : "加载中…"}
    </div>

    {message ? <Notice tone="danger">{message}</Notice> : null}
    {/* Quiet, non-blocking: the cached body is readable, the Desktop has newer. */}
    {staleNotice ? <Notice>{staleNotice}</Notice> : null}
    {failed.current ? (
      <button className="primary btn-block" style={{ marginTop: 12 }} onClick={() => edit(draft.current.title, draft.current.content)}>
        重试保存
      </button>
    ) : null}

    {note?.conflictDocument ? (
      <div className="conflict">
        <b>手机和电脑都有修改</b>
        <p>两份内容都已保留。选择要保留的版本后，另一份会作为副本存下来。</p>
        <button className="quiet" onClick={() => setShowConflict((v) => !v)}>
          {showConflict ? "收起对比" : "查看两份并处理"}
        </button>
      </div>
    ) : null}

    {showConflict && note?.conflictDocument ? (
      <section aria-label="笔记冲突处理">
        <div className="conflict-version">
          <b>手机版本</b>
          <pre>{content}</pre>
        </div>
        <div className="conflict-version">
          <b>电脑版本</b>
          <pre>{note.conflictDocument.deleted ? "电脑已删除此笔记，或新建名称已被使用。" : note.conflictDocument.content ?? "等待获取电脑版本"}</pre>
        </div>
        <button className="primary btn-block" style={{ marginTop: 12 }} onClick={() => void resolve(true)}>
          把手机版本保留为副本
        </button>
        <button className="quiet btn-block" style={{ marginTop: 8 }} onClick={() => void resolve(false)}>
          采用电脑版本
        </button>
      </section>
    ) : null}

    {note ? (
      <input
        className="editor-title"
        aria-label="笔记标题"
        value={title}
        readOnly={preview || !loaded || attaching}
        onChange={(e) => edit(e.target.value, content)}
        placeholder="笔记标题…"
      />
    ) : null}

    {loaded && !preview ? (
      <div className="attach-bar" aria-label="插入附件" role="group">
        <button className="attach-action" disabled={attaching} onClick={() => void attach("image")}>
          <IconImage size={18} />
          <span>图片</span>
        </button>
        <button className="attach-action" disabled={attaching} onClick={() => void attach("photo")}>
          <IconCamera size={18} />
          <span>拍照</span>
        </button>
        <button className="attach-action" disabled={attaching} onClick={() => void attach("file")}>
          <IconFile size={18} />
          <span>文件</span>
        </button>
        {attaching ? <span className="attach-busy" role="status">正在加入附件…</span> : null}
      </div>
    ) : null}

    {loaded ? (
      preview ? (
        <DesktopNotePreview
          instance={instance}
          vault={vault}
          note={id}
          content={content}
          resources={cachedResources(note)}
        />
      ) : (
        <textarea
          className="editor-body"
          aria-label="笔记正文"
          value={content}
          disabled={attaching}
          onChange={(e) => edit(title, e.target.value)}
          spellCheck={false}
        />
      )
    ) : note ? (
      <EmptyState title="连接电脑后可获取正文" body="这篇笔记的正文还没有缓存到手机上。" />
    ) : null}

    {note ? (
      <div style={{ marginTop: 22 }}>
        {deleteConfirm ? (
          <>
            <Notice tone="danger">删除会在连接恢复后同步到电脑。尚未同步前，正文仍保存在手机。</Notice>
            <div className="btn-row">
              <button className="danger-btn" onClick={() => void remove()}>
                确认删除
              </button>
              <button className="quiet" onClick={() => setDeleteConfirm(false)}>
                取消
              </button>
            </div>
          </>
        ) : (
          <button className="danger-btn btn-block" onClick={() => setDeleteConfirm(true)}>
            删除这篇电脑笔记
          </button>
        )}
      </div>
    ) : null}
  </>;
}
