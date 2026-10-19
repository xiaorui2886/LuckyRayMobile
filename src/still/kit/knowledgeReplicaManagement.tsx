import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../services/client";
import { dataStore } from "../../services/dataStore";
import { syncCoordinator } from "../../services/syncCoordinator";
import type { KnowledgeReplicaLibrary } from "../../services/knowledgeReplica";
import { Option } from "./StillImports";

/** Settings within the existing library sheet; not another page/list/search. */
export function KnowledgeReplicaManagement({instance, vault, connected, onChanged}: {
  instance: string; vault: string; connected: boolean; onChanged: () => void;
}) {
  const [libraryState, setLibrary] = useState<KnowledgeReplicaLibrary | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const version = useSyncExternalStore(fn => dataStore.subscribe(fn), () => dataStore.getVersion());
  const sync = useSyncExternalStore(fn => syncCoordinator.subscribe(fn), () => syncCoordinator.snapshot());
  const generation = useRef(0), locked = useRef(false);
  const ownerRef = useRef(`${instance}|${vault}`), mounted = useRef(true);
  ownerRef.current = `${instance}|${vault}`;
  const library = libraryState?.instanceId === instance && libraryState.vaultId === vault ? libraryState : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (sync.status === "syncing") return;
    const token = ++generation.current;
    setLoaded(false);
    void api.contentReplicaLibraries(instance).then(rows => {
      if (generation.current !== token) return;
      setLibrary(rows.find(row => row.instanceId === instance && row.vaultId === vault) ?? null);
      setLoaded(true); setError("");
    }).catch(() => { if (generation.current === token) { setError("无法读取手机保存状态，请重试。"); setLoaded(true); } });
    return () => { generation.current++; };
  }, [instance, vault, version, connected, sync.status, sync.error]);
  async function control(action: "start" | "pause" | "resume") {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    const owner = `${instance}|${vault}`;
    try {
      await api.contentReplicaControl(instance, vault, action);
      if (!mounted.current || owner !== ownerRef.current) return;
      dataStore.bump(); onChanged(); syncCoordinator.wake();
    } catch { if (mounted.current && owner === ownerRef.current) setError(action === "start" ? "请连接电脑并打开这个知识库，再确认保存。" : "设置未能保存，请重试。"); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  const selected = library?.confirmed === true;
  const complete = Boolean(library?.metadataReady && library.ready === library.total && !library.failed && !library.unverified);
  return <>
    <p className="st-sheet-caption">手机保存</p>
    {selected ? <>
      <p className="st-sheet-copy" role="status">{library.metadataReady && library.ready === library.total && !library.failed && !library.unverified
        ? `正文已保存 · ${library.ready} 篇`
        : `正文已保存 ${library.ready} / ${library.total} 篇${library.metadataReady ? "" : " · 正在读取笔记目录"}${library.failed ? ` · ${library.failed} 篇暂未完成` : ""}${library.unverified ? ` · ${library.unverified} 篇待确认` : ""}`}</p>
      <p className="st-sheet-copy">{library.waitingCurrent ? "电脑已切换知识库。手机正文和修改仍保留；电脑打开这个库后会自动补齐。"
        : library.writeState !== "granted" ? "当前未获写入授权。已保存正文仍可阅读，既有修改会保留。"
        : !connected ? "电脑暂未连接，已保存正文可以阅读和编辑，连接后自动同步。"
        : "修改先保存到手机，再自动同步到电脑。"}附件仍按需加载。</p>
      {!complete || library.paused ? <Option label={library.paused ? "继续保存剩余正文" : "暂停保存剩余正文"} icon={library.paused ? "refresh" : "stop"} onClick={() => { if (!busy) void control(library.paused ? "resume" : "pause"); }} /> : null}
      {library.failed > 0 && !library.paused ? <Option label="重试未完成正文" icon="refresh" onClick={() => { if (!busy) void control("resume"); }} /> : null}
      {!complete || library.paused ? <p className="st-sheet-copy">{library.paused ? "批量保存已暂停；笔记修改和实时更新不受影响。" : "其余正文会在连接时后台补齐，无需逐篇打开。"}</p> : null}
    </> : <>
      <p className="st-sheet-copy">{library ? "此前保存的正文仍保留，请确认继续使用此知识库。原有暂停设置不会自动恢复。" : "将这个电脑知识库的正文保存在手机。断线后仍使用原列表、搜索和编辑。"}</p>
      {loaded && connected ? <Option label={busy ? "正在确认…" : "在手机保存此知识库"} icon="monitor" onClick={() => { if (!busy) void control("start"); }} /> : <p className="st-sheet-copy">{loaded ? "连接电脑后可确认保存此知识库。" : "正在读取保存状态…"}</p>}
    </>}
    {error ? <p className="st-sheet-copy" role="alert">{error}</p> : null}
  </>;
}
