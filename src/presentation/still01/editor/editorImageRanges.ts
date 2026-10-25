import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { wikiSyntax } from '../../../still/kit/wikiSyntax.ts';
import type { NoteResource } from '../../../services/noteResourceSession.ts';
export function editorImageRanges(doc:string, resources:NoteResource[]):{from:number;at:number;resource:NoteResource}[]{
 if(doc.length>250_000)return [];
 const parser=unified().use(remarkParse).use(remarkGfm).use(wikiSyntax(doc,new Map()));
 const tree=parser.runSync(parser.parse(doc));const found:{from:number;at:number;resource:NoteResource}[]=[];
 const byTarget=new Map(resources.filter(r=>r.status==='resolved'&&r.mimeType?.startsWith('image/')).map(r=>[r.target,r]));
 const definitions=new Map<string,string>();
 const collect=(node:any)=>{if(node.type==='definition'&&typeof node.identifier==='string'&&typeof node.url==='string')definitions.set(node.identifier.toLowerCase(),node.url);node.children?.forEach(collect)};
 collect(tree);
 const visit=(node:any)=>{if(found.length>=24)return;
  const url=typeof node.url==='string'?node.url:node.type==='imageReference'?definitions.get(String(node.identifier).toLowerCase()):undefined;
  if(['image','imageReference'].includes(node.type)&&typeof url==='string'){
   let target=url;try{target=decodeURIComponent(target)}catch{}
   const resource=byTarget.get(url)||byTarget.get(target);
   if(resource&&Number.isInteger(node.position?.start?.offset)&&Number.isInteger(node.position?.end?.offset))found.push({from:node.position.start.offset,at:node.position.end.offset,resource});
  }
  if(!['code','inlineCode','html'].includes(node.type))node.children?.forEach(visit);
 };
 visit(tree);return found;
}
