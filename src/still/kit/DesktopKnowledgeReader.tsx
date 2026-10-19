import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import DesktopNotePreview from "../../components/DesktopNotePreview";
import { api } from "../../services/client";
import { sessionKnowledge } from "./knowledgeSession";
import { KnowledgeRelations, relationsStatus, resolveWikiReference, type RelationSnapshot, type WikiReference } from "./knowledgeRelations";
import type { ReadingFind } from "./NoteReadingContent";

export function DesktopKnowledgeReader(props: {
  instance: string; vault: string; note: string; content: string; resources: any[]; panelOnly?: boolean;
  online: boolean; revision: string; clean: boolean; onNavigate: (noteId: string, isCurrent: () => boolean) => Promise<void>;
  find?: ReadingFind;
}) {
  const { instance, vault, note, online, revision, clean } = props;
  const navigation = sessionKnowledge().navigation;
  const authority = useSyncExternalStore(navigation.subscribe, () => navigation.authorityKey(instance, "relations"),
    () => navigation.authorityKey(instance, "relations"));
  const scopeKey = JSON.stringify([instance, vault, note]);
  const [reload, setReload] = useState(0);
  const requestKey = JSON.stringify([scopeKey, online, revision, clean, authority, reload]);
  const [snapshot, setSnapshot] = useState<RelationSnapshot & { requestKey?: string }>({ instance, vault, note, phase: "idle", items: [], revision: "" });
  const [expanded, setExpanded] = useState(Boolean(props.panelOnly));
  const [notice, setNotice] = useState("");
  const [choice, setChoice] = useState<{ reference: WikiReference; noteIds: string[]; requestKey: string } | null>(null);
  const [labels, setLabels] = useState<Record<string, { title: string; path: string }>>({});
  const generation = useRef(0);
  const reader = useRef<KnowledgeRelations | null>(null);
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const requestRef = useRef(requestKey); requestRef.current = requestKey;
  const navigateBusy = useRef(false);
  const current = snapshot.requestKey === requestKey && snapshot.instance === instance && snapshot.vault === vault && snapshot.note === note;
  const relations = current ? snapshot : { instance, vault, note,
    phase: navigation.denied(instance, "relations") ? "denied" as const : online ? "idle" as const : "offline" as const,
    items: [], revision: "" };
  const activeChoice = choice?.requestKey === requestKey ? choice : null;
  const canNavigate = online && clean && relations.phase === "ready" && Boolean(revision) && relations.revision === revision;
  const backlinks = relations.items.filter(item => item.kind === "backlink");
  const uniqueBacklinks = [...new Map(backlinks.map(item => [item.sourceNoteId, item])).values()];
  const ambiguousBacklinks = new Set(backlinks.filter(item => item.status === "ambiguous").map(item => item.sourceNoteId));

  useEffect(() => {
    const token = ++generation.current;
    setChoice(null); setNotice(""); setLabels({});
    const controller = new KnowledgeRelations({ instance, vault, note }, navigation,
      value => { if (generation.current === token && requestRef.current === requestKey) setSnapshot({ ...value, requestKey }); });
    reader.current = controller;
    void controller.load(online);
    return () => { ++generation.current; controller.retire(); if (reader.current === controller) reader.current = null; };
  }, [instance, vault, note, online, revision, clean, reload, authority]);

  const candidateKey = JSON.stringify([...new Set([...(activeChoice?.noteIds || []), ...(expanded ? uniqueBacklinks.map(item => item.sourceNoteId) : [])])]);
  useEffect(() => {
    let alive = true;
    const ids: string[] = JSON.parse(candidateKey);
    // Local cache metadata only; opening the exact note owns any body fetch.
    void (async () => {
      for (let offset = 0; offset < ids.length; offset += 8) {
        if (!alive) return;
        const rows = await Promise.all(ids.slice(offset, offset + 8).map(async id => {
          try {
            const result = await api.contentNoteGet(instance, vault, id);
            if (!result || result.noteId !== id || result.vaultId !== vault || result.deleted) return null;
            return [id, { title: result.title || id, path: result.relativePath || "" }] as const;
          } catch { return null; }
        }));
        if (!alive || scopeRef.current !== scopeKey) return;
        setLabels(previous => ({ ...previous, ...Object.fromEntries(rows.filter(row => row !== null)) }));
      }
    })();
    return () => { alive = false; };
  }, [instance, vault, scopeKey, candidateKey]);

  async function navigate(id: string) {
    if (navigateBusy.current) return;
    if (!canNavigate || requestRef.current !== requestKey || scopeRef.current !== scopeKey || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return;
    navigateBusy.current = true;
    try { await props.onNavigate(id, () => requestRef.current === requestKey && scopeRef.current === scopeKey
      && navigation.authorityKey(instance, "relations") === authority && !navigation.denied(instance, "relations")); }
    finally { navigateBusy.current = false; }
  }
  function follow(reference: WikiReference) {
    const result = resolveWikiReference(relations, reference, revision, clean);
    setChoice(null);
    if (result.kind === "resolved") { setNotice(""); void navigate(result.noteIds[0]); }
    else if (result.kind === "ambiguous") { setNotice("有多篇同名笔记，请选择要打开的一篇。"); setChoice({ reference, noteIds: result.noteIds, requestKey }); }
    else if (result.kind === "stale") setNotice("正文与电脑端链接版本暂不一致，请同步完成后重试。");
    else if (result.kind === "missing") setNotice(reference.heading
      ? `电脑尚未解析「${reference.target}」的标题链接。可以在笔记列表中查找目标笔记。`
      : `未找到「${reference.target}」对应的笔记。`);
    else setNotice(relationsStatus(relations.phase));
  }
  const renderChoice = (id: string, backlink = false) => <button type="button" key={id} className="st-relation-row" disabled={!canNavigate}
    onClick={() => {
      if (backlink) {
        if (!canNavigate || !uniqueBacklinks.some(item => item.sourceNoteId === id)) return;
      } else if (!activeChoice || !resolveWikiReference(relations, activeChoice.reference, revision, clean).noteIds.includes(id)) return;
      void navigate(id);
    }}>
    <strong>{labels[id]?.title || `笔记 ${id}`}</strong>
    <small>{labels[id]?.path || "此电脑知识库中的笔记"}{backlink && ambiguousBacklinks.has(id) ? " · 同名链接，可能引用此笔记" : ""}</small>
  </button>;
  return <>
    {props.panelOnly ? <section aria-label="此笔记的内部链接">
      <h3 className="st-links-heading">链接到</h3>
      {!clean ? <p className="st-folder-status">修改同步后可打开内部链接。</p> : null}
      {relations.phase === "ready" ? relations.items.filter(item => item.kind === "wikiLink").map((item, index) => item.kind === "wikiLink" ?
        <button type="button" className="st-relation-row" key={index} disabled={!canNavigate}
          onClick={() => follow({ target: item.target, label: item.target, line: item.line, from: 0, to: 0 })}>{item.target}</button> : null) : null}
      {relations.phase === "ready" && !relations.items.some(item => item.kind === "wikiLink") ? <p className="st-folder-status">还没有内部链接。输入 [[笔记名]] 建立链接。</p> : null}
    </section> : <DesktopNotePreview {...props} onWikiLink={follow} />}
    {notice && current ? <div className="st-relations-notice" role="status">{notice}
      {activeChoice ? <button type="button" onClick={() => { setChoice(null); setNotice(""); }}>取消选择</button> : null}
    </div> : null}
    {activeChoice ? <div className="st-relations-picker" aria-label="选择链接目标">{activeChoice.noteIds.map(id => renderChoice(id))}</div> : null}
    {props.panelOnly ? <section className="st-note-relations" aria-label="双向链接">
      <button type="button" className="st-relations-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        引用此笔记{relations.phase === "ready" ? ` · ${uniqueBacklinks.length}` : ""}<span aria-hidden="true">{expanded ? " −" : " +"}</span>
      </button>
      {expanded ? <div>
        {relations.phase === "ready" ? uniqueBacklinks.length ? uniqueBacklinks.map(item => renderChoice(item.sourceNoteId, true))
          : <p className="st-folder-status">还没有其他笔记引用此笔记。</p>
          : <p className="st-folder-status" role="status">{relationsStatus(relations.phase)}</p>}
        {online && relations.phase !== "loading" ? <button type="button" className="st-relations-refresh" onClick={() => {
          const key = requestKey;
          void navigation.refresh(instance).catch(() => {}).then(() => { if (requestRef.current === key) setReload(value => value + 1); });
        }}>刷新链接</button> : null}
      </div> : null}
    </section> : null}
  </>;
}
