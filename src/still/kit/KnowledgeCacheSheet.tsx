import { knowledgeCacheClearBlocked } from "../../services/knowledgeCacheSafety";
import { desktopNotePrefetch } from "../../services/desktopNotePrefetch";
import { dataStore } from "../../services/dataStore";
import { sessionKnowledge } from "./knowledgeSession";
import { useEffect, useRef, useState } from "react";
import { api } from "../../services/client";
import { KnowledgeActionGate, type CacheLibrary } from "../../services/knowledgeActions";
import { Sheet, Option, Button } from "./StillImports";

export function KnowledgeCacheSheet({ onClose, registerOverlay }: { onClose: () => void; registerOverlay: (fn: () => void) => () => void }) {
  const [libraries, setLibraries] = useState<CacheLibrary[] | null>(null);
  const [selected, setSelected] = useState<CacheLibrary | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const gate = useRef(new KnowledgeActionGate()).current;
  useEffect(() => { let alive = true; api.contentCacheLibraries().then(rows => { if (alive) setLibraries(rows); }).catch(() => { if (alive) setNotice("暂时无法读取缓存，请关闭后重试。"); }); return () => { alive = false; gate.cancel(); }; }, [gate]);
  const close = () => { if (busy) return; gate.cancel(); onClose(); };
  async function clear() {
    if (!selected) return;
    if (document.querySelector(".st-note-surface") || knowledgeCacheClearBlocked()) {
      setNotice("请先保存并关闭正在编辑的笔记，再清理缓存。未完成的保存不会被丢弃。"); return;
    }
    const token = gate.start(); if (token === null) return;
    setBusy(true); setNotice("");
    try {
      desktopNotePrefetch.suspend();
      const result = await api.contentCacheClear(selected.instanceId, selected.vaultId);
      if (!gate.current(token)) return;
      sessionKnowledge().previews.clearScope(selected.instanceId, selected.vaultId);
      dataStore.bump();
      setSelected(null);
      setNotice(`已清理 ${result.clearedCount} 篇正文缓存，保留 ${result.protectedCount} 篇未同步等需保留的内容。自动下载正文缓存已暂停。`);
      const refreshed = await api.contentCacheLibraries();
      if (gate.current(token)) setLibraries(refreshed);
    } catch { if (gate.current(token)) setNotice("清理未完成，请重试。未同步内容仍保留。"); }
    finally { if (gate.current(token)) setBusy(false); gate.finish(token); }
  }
  return <Sheet title={selected ? "清理电脑知识库缓存？" : "电脑知识库缓存"} registerDismiss={registerOverlay} onClose={close} busy={busy}
    footer={selected ? <><Button kind="quiet" disabled={busy} onClick={() => { gate.cancel(); setSelected(null); }}>取消</Button><Button disabled={busy || !selected.clearableCount} onClick={() => void clear()}>{busy ? "清理中…" : "清理正文缓存"}</Button></> : undefined}>
    {selected ? <><p className="st-sheet-copy">{selected.name || "电脑知识库"} · {`电脑 · 尾号 ${selected.instanceId.slice(-6)}`}<br/>当前可清理约 {selected.clearableCount} 篇，保留 {selected.protectedCount} 篇未同步等需保留的内容。</p><p className="st-sheet-copy">清理时会重新检查数量，只清理这台电脑、这个知识库在手机保存且已同步的正文。本机笔记、电脑原件、附件、未同步修改和冲突不会删除。自动下载正文缓存将暂停；再次打开笔记仍可按需下载。</p></> : <><p className="st-sheet-copy">包含以前使用过的电脑与知识库。选择一个范围后确认清理。</p>{libraries?.map(item => <Option key={JSON.stringify([item.instanceId,item.vaultId])} label={item.name || "电脑知识库"} detail={`电脑 · 尾号 ${item.instanceId.slice(-6)} · ${item.cachedCount} 篇缓存 · 可清理 ${item.clearableCount} 篇`} icon="monitor" onClick={() => { setNotice(""); setSelected(item); }} />)}{libraries?.length === 0 ? <p className="st-sheet-copy">没有电脑知识库正文缓存。</p> : null}{!libraries && !notice ? <p className="st-sheet-copy">正在读取…</p> : null}</>}
    {notice ? <p className="st-sheet-copy" role="status">{notice}</p> : null}
  </Sheet>;
}
