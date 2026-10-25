import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../services/client";
import CachedMedia from "./CachedMedia";
import { NoteResourceSession, type ResourceView } from "../services/noteResourceSession";
import type { WikiReference } from "../still/kit/knowledgeRelations";
import type { ReadingFind } from "../still/kit/NoteReadingContent";
import { SafeNoteMarkdown } from "./SafeNoteMarkdown";
import { NoteImagePreview } from "./NoteImagePreview";
import { noteMediaLabel } from "./noteMediaLabel";

type RegisterOverlay = (dismiss: () => void) => () => void;
type PreviewState = { localVaultId?: string; revision?: string; instance: string; vault: string; note: string; online: boolean; registerOverlay?: RegisterOverlay };
export default function DesktopNotePreview({ localVaultId, revision, instance, vault, note, content, resources, online = true, onWikiLink, wikiStatus, find, registerOverlay }: {
  localVaultId?: string; revision?: string; instance: string; vault: string; note: string; content: string; resources: any[]; online?: boolean;
  wikiStatus?: (reference: WikiReference) => "resolved" | "missing" | "ambiguous" | "unknown";
  onWikiLink?: (reference: WikiReference) => void; find?: ReadingFind; registerOverlay?: RegisterOverlay;
}) {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  const ctx = { localVaultId, revision, instance, vault, note, online: online && visible, registerOverlay };
  return <SafeNoteMarkdown content={content} resources={resources} find={find} wikiStatus={wikiStatus} onWikiLink={onWikiLink}
    renderResource={resource => <ScopedNoteMedia ctx={ctx} resource={resource} />} />;
}
function ScopedNoteMedia({ctx,resource}:{ctx:PreviewState;resource:any}){
  // Real identity/version/access changes retire the old media. Transport
  // availability and unchanged descriptor objects do not blank the image.
  return <NoteMedia key={JSON.stringify([ctx.localVaultId,ctx.revision,ctx.instance,ctx.vault,ctx.note,resource.resourceId,resource.version,resource.status,resource.mimeType,resource.localAttachmentId,resource.localOnly])}
    localVaultId={ctx.localVaultId} revision={ctx.revision} instance={ctx.instance} vault={ctx.vault} note={ctx.note} resource={resource} online={ctx.online} registerOverlay={ctx.registerOverlay}/>;
}

function NoteMedia({localVaultId, revision, instance, vault, note, resource, online, registerOverlay}: {localVaultId?: string; revision?: string; instance: string; vault: string; note: string; resource: any; online: boolean; registerOverlay?: RegisterOverlay}) {
  const [{file, message, busy}, setView] = useState<ResourceView>({file: null, message: "", busy: false});
  const label = noteMediaLabel(resource.target);
  const session = useRef<NoteResourceSession | null>(null);
  useEffect(() => {
    const reader = new NoteResourceSession({localVaultId, revision, instance, vault, note}, resource, api, setView, online);
    session.current = reader;
    setView({file: null, message: "", busy: false});
    void reader.start();
    return () => { reader.retire(); if (session.current === reader) session.current = null; };
  }, [localVaultId, revision, instance, vault, note, resource.resourceId, resource.version, resource.status, resource.mimeType, resource.localAttachmentId, resource.localOnly]);
  useEffect(() => { session.current?.setOnline(online); }, [online]);
  const source = file ? convertFileSrc(file.path) : "";
  return <span style={{display: "block", margin: "12px 0"}}>
    {file?.mime.startsWith("image/") ? <NoteImagePreview source={source} label={label} registerOverlay={registerOverlay} /> :
      localVaultId && file?.mime.startsWith("video/") ? <video controls src={source} /> : localVaultId && file?.mime.startsWith("audio/") ? <audio controls src={source} /> : file && /^(video|audio)\//.test(file.mime) ? <CachedMedia instance={instance} id={resource.resourceId} vault={vault} note={note} version={file.path} mime={file.mime} /> : null}
    {!file && <span>{label} · {resource.status === "resolved" ? localVaultId ? "附件尚未完整保存在本地" : online ? "按需获取" : "附件尚未缓存 · 请连接原电脑" : "文件缺失或尚未授权"}</span>}
    {!file && resource.status === "resolved" && <button disabled={busy || (!localVaultId && !online)} onClick={() => void session.current?.download()}>{busy ? "获取中…" : "查看附件"}</button>}
    {file && !/^(image|video|audio)\//.test(file.mime) && <button onClick={() => void (localVaultId ? api.managedVaultResourceOpen(localVaultId, note, resource.target, revision || "") : api.contentOpenResource(instance, resource.resourceId, vault, note)).catch(() => setView(v => ({...v, message: "未找到可打开此文件的应用。"})))}>打开 {label}</button>}
    {busy && !file && <button onClick={() => session.current?.cancel()}>取消</button>}
    {message && <span role="status">{message}</span>}
  </span>;
}
