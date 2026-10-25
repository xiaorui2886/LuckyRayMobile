import { tableColumnWidths } from '../presentation/still01/editor/tableColumnWidths';
import { createContext, useContext, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightSyntax } from "../still/kit/highlightSyntax";
import { wikiSyntax } from "../still/kit/wikiSyntax";
import type { WikiReference } from "../still/kit/knowledgeRelations";
import { readingSourcePositions } from "../presentation/still01/editor/noteReadingPosition";
import { readingFindPositions } from "../still/kit/readingFindPositions";
import type { ReadingFind } from "../still/kit/NoteReadingContent";
import "./SafeNoteMarkdown.css";
import "../presentation/still01/editor/noteTypography.css";

type Props = { wikiStatus?: (reference: WikiReference) => "resolved" | "missing" | "ambiguous" | "unknown"; content: string; find?: ReadingFind; onWikiLink?: (reference: WikiReference) => void;
  resources?: any[]; renderResource?: (resource: any) => ReactNode };
const Context = createContext<(Props & { references: Map<string, WikiReference> }) | null>(null);
/** Shared, read-only Markdown presentation. Only scoped resource descriptors can
 * produce media; arbitrary remote/file/data URLs never become image sources. */
export function SafeNoteMarkdown(props: Props) {
  const references = new Map<string, WikiReference>();
  const targets = new Map((props.resources || []).map(resource => [resource.target, resource]));
  const resolve = (target: string) => {
    if (targets.has(target)) return targets.get(target);
    try { return targets.get(decodeURIComponent(target)); } catch { return undefined; }
  };
  return <Context.Provider value={{ ...props, references }}><div className="note-reading st-safe-note-markdown">
    <Markdown skipHtml remarkPlugins={[remarkGfm, wikiSyntax(props.content, references), highlightSyntax(props.content)]}
      rehypePlugins={[readingSourcePositions, readingFindPositions(props.content, props.find?.ranges || [], props.find?.index || 0)]}
      urlTransform={(url, key, node) => node.properties?.["data-wiki-start"] !== undefined && references.has(url)
        ? url : resolve(url)?.resourceId || (key !== "src" && /^https?:\/\//i.test(url) ? url : "")}
      components={components}>{props.content}</Markdown>
  </div></Context.Provider>;
}
function Image({ src, alt }: any) {
  const ctx = useContext(Context)!;
  const resource = ctx.resources?.find(item => item.resourceId === src);
  return resource && ctx.renderResource ? ctx.renderResource(resource) : <span>{alt || "附件"}（尚未获取或不可访问）</span>;
}
function Link({ children, href, node }: any) {
  const ctx = useContext(Context)!;
  const reference = node?.properties?.["data-wiki-start"] !== undefined && href ? ctx.references.get(href) : undefined;
  if (reference) return ctx.onWikiLink ? <button type="button" className={"st-wiki-link is-" + (ctx.wikiStatus?.(reference) || "unknown")}
    data-note-source-start={reference.from} data-note-source-end={reference.to}
    onClick={() => ctx.onWikiLink?.(reference)}>{children}</button> : <span>{children}</span>;
  const resource = ctx.resources?.find(item => item.resourceId === href);
  return resource && ctx.renderResource ? ctx.renderResource(resource) : href
    ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>;
}
function Table({node,children,...props}:any){
  const text=(item:any):string=>item?.type==='text'?item.value||'':item?.tagName==='img'?String(item.properties?.alt||''):(item?.children||[]).map(text).join('');
  const rows:string[][]=[];
  const collect=(item:any)=>{if(item?.tagName==='tr')rows.push((item.children||[]).filter((child:any)=>child.tagName==='td'||child.tagName==='th').map(text));else for(const child of item?.children||[])collect(child)};
  collect(node);const widths=tableColumnWidths(rows);
  return <table {...props}><colgroup>{widths.map((width,index)=><col key={index} style={{width:width+'%'}}/>)}</colgroup>{children}</table>;
}
// Stable component types preserve attachment sessions across parent updates.
const components = { img: Image, a: Link, table: Table };
