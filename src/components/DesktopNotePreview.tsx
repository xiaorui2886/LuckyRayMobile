import { createContext, useContext, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../services/client";
import CachedMedia from "./CachedMedia";
import { NoteResourceSession, type ResourceView } from "../services/noteResourceSession";
import { wikiSyntax } from "../still/kit/wikiSyntax";
import type { WikiReference } from "../still/kit/knowledgeRelations";
import { readingSourcePositions } from "../presentation/still01/editor/noteReadingPosition";
import { readingFindPositions } from "../still/kit/readingFindPositions";
import type { ReadingFind } from "../still/kit/NoteReadingContent";

export default function DesktopNotePreview({ instance, vault, note, content, resources, online = true, onWikiLink, find }: {instance: string; vault: string; note: string; content: string; resources: any[]; online?: boolean; onWikiLink?: (reference: WikiReference) => void; find?: ReadingFind}) {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  const canFetch = online && visible;
  const resourceByTarget = new Map(resources.map(resource => [resource.target, resource]));
  function resolve(target: string) {
    try { return resourceByTarget.get(target) || resourceByTarget.get(decodeURIComponent(target)); } catch { return undefined; }
  }
  const references = new Map<string, WikiReference>();
  // Stable component types are essential: new img/a function identities remount
  // every attachment on an unrelated parent update and restart its download.
  return <PreviewContext.Provider value={{instance, vault, note, resources, online:canFetch, references, onWikiLink}}>
    <div className="note-reading"><Markdown skipHtml remarkPlugins={[remarkGfm, wikiSyntax(content, references)]} rehypePlugins={[readingSourcePositions, readingFindPositions(content, find?.ranges || [], find?.index || 0)]}
      urlTransform={(url, key, node) => node.properties?.["data-wiki-start"] !== undefined && references.has(url) ? url : resolve(url)?.resourceId || (key !== "src" && /^https?:\/\//i.test(url) ? url : "")}
      components={previewComponents}>{content}</Markdown></div>
  </PreviewContext.Provider>;
}
type PreviewState = {instance:string;vault:string;note:string;resources:any[];online:boolean;references:Map<string,WikiReference>;onWikiLink?: (reference:WikiReference)=>void};
const PreviewContext=createContext<PreviewState|null>(null);
function PreviewImage({src,alt}:any){
  const ctx=useContext(PreviewContext)!;
  const resource=ctx.resources.find(r=>r.resourceId===src);
  return resource ? <ScopedNoteMedia ctx={ctx} resource={resource}/> : <span>{alt || "附件"}（尚未获取或不可访问）</span>;
}
function PreviewLink({children,href,node}:any){
  const ctx=useContext(PreviewContext)!;
  const reference=node?.properties?.["data-wiki-start"]!==undefined && href ? ctx.references.get(href):undefined;
  if(reference)return ctx.onWikiLink ? <button type="button" className="st-wiki-link" data-note-source-start={reference.from} data-note-source-end={reference.to}
    onClick={()=>ctx.onWikiLink?.(reference)}>{children}</button>:<span>{children}</span>;
  const resource=ctx.resources.find(r=>r.resourceId===href);
  return resource ? <ScopedNoteMedia ctx={ctx} resource={resource}/> : href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>:<span>{children}</span>;
}
const previewComponents={img:PreviewImage,a:PreviewLink};
function ScopedNoteMedia({ctx,resource}:{ctx:PreviewState;resource:any}){
  // Real identity/version/access changes retire the old media. Transport
  // availability and unchanged descriptor objects do not blank the image.
  return <NoteMedia key={JSON.stringify([ctx.instance,ctx.vault,ctx.note,resource.resourceId,resource.version,resource.status,resource.mimeType])}
    instance={ctx.instance} vault={ctx.vault} note={ctx.note} resource={resource} online={ctx.online}/>;
}

function NoteMedia({instance, vault, note, resource, online}: {instance: string; vault: string; note: string; resource: any; online: boolean}) {
  const [{file, message, busy}, setView] = useState<ResourceView>({file: null, message: "", busy: false});
  const [expanded, setExpanded] = useState(false);
  const session = useRef<NoteResourceSession | null>(null);
  useEffect(() => {
    const reader = new NoteResourceSession({instance, vault, note}, resource, api, setView, online);
    session.current = reader;
    setView({file: null, message: "", busy: false});
    void reader.start();
    return () => { reader.retire(); if (session.current === reader) session.current = null; };
  }, [instance, vault, note, resource.resourceId, resource.version, resource.status, resource.mimeType]);
  useEffect(() => { session.current?.setOnline(online); }, [online]);
  const source = file ? convertFileSrc(file.path) : "";
  return <span style={{display: "block", margin: "12px 0"}}>
    {file?.mime.startsWith("image/") ? <img src={source} alt={resource.target} onClick={() => setExpanded(v => !v)} style={{maxWidth: expanded ? "none" : "100%", width: expanded ? "auto" : undefined}} /> :
      file && /^(video|audio)\//.test(file.mime) ? <CachedMedia instance={instance} id={resource.resourceId} vault={vault} note={note} version={file.path} mime={file.mime} /> : null}
    {!file && <span>{resource.target} · {resource.status === "resolved" ? online ? "按需获取" : "附件尚未缓存 · 请连接原电脑" : "文件缺失或尚未授权"}</span>}
    {!file && resource.status === "resolved" && <button disabled={busy || !online} onClick={() => void session.current?.download()}>{busy ? "获取中…" : "查看附件"}</button>}
    {file && !/^(image|video|audio)\//.test(file.mime) && <button onClick={() => void api.contentOpenResource(instance, resource.resourceId, vault, note).catch(() => setView(v => ({...v, message: "未找到可打开此文件的应用。"})))}>打开 {resource.target}</button>}
    {busy && !file && <button onClick={() => session.current?.cancel()}>取消</button>}
    {message && <span role="status">{message}</span>}
  </span>;
}
