/** Pure extraction from desktop GraphPage.tsx / graph.ts at 200433932c46.
 * Mobile changes only input plumbing; preserve search, force and scene semantics. */
import type { GraphSeed, GraphSeedNode, GraphType, GraphViewState, GraphEdgeKind, GraphEdgeDirection } from './graphTypes.ts';
import { graphGroupMatches, normalizeGraphColorGroups, normalizeGraphSections } from './graphPresentation.ts';

export const TYPE_COLORS: Record<GraphType,string> = {material:'#7f9dad',note:'#d6dbe1',tag:'#77aaa0',web:'#b69c74'};
export const DEGREE_COLORS = ['#8e99a3','#96a3ad','#91aab2','#8eafb0','#93b6b0','#9abdb7','#a3c2be','#b1c8c5','#c1d0ce','#d5dfdd'];
export const GRAPH_DEFAULTS = {filters:{material:false,note:true,tag:false,web:false}, showIsolated:true, nearbyFilter:false, nearbyDepth:1 as const,
 colorMode:'type' as const, showArrows:false,showLabels:true,labelReveal:.45,nodeSize:6,edgeWidth:1,
 centerForce:50,repulsionForce:50,linkAttraction:50,linkLength:180,nodeSpacing:50,scale:1,panX:0,panY:0};
export function clampGraphNumber(value: unknown, fallback: number, min: number, max: number): number {return typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;}
export function normalizeGraphFilters(filters: GraphViewState['filters']): Record<GraphType,boolean> {
 return !filters?{...GRAPH_DEFAULTS.filters}:{material:filters.material??true,note:filters.note??true,tag:filters.tag??true,web:filters.web??true};
}
export function normalizeGraphView(view: GraphViewState = {}) {
 const legacy=clampGraphNumber(50+(clampGraphNumber(view.forceStrength,1,0,3)-1)*25,50,0,100);
 return {...GRAPH_DEFAULTS,filters:normalizeGraphFilters(view.filters),colorGroups:normalizeGraphColorGroups(view.colorGroups),sections:normalizeGraphSections(view.sections),
 showIsolated:view.showIsolated??true,nearbyFilter:view.nearbyFilter??false,nearbyDepth:view.nearbyDepth===2?2 as const:1 as const,
 colorMode: ['default','type','degree'].includes(view.colorMode||'')?view.colorMode!:'type' as const,showArrows:view.showArrows??false,showLabels:view.showLabels??true,
 labelReveal:clampGraphNumber(view.labelReveal,.45,0,1.6),nodeSize:clampGraphNumber(view.nodeSize,6,3,12),edgeWidth:clampGraphNumber(view.edgeWidth,1,.5,4),
 centerForce:clampGraphNumber(view.centerForce,legacy,0,100),repulsionForce:clampGraphNumber(view.repulsionForce,legacy,0,100),linkAttraction:clampGraphNumber(view.linkAttraction,legacy,0,100),
 linkLength:clampGraphNumber(view.linkLength,180,64,360),nodeSpacing:clampGraphNumber(view.nodeSpacing,50,0,100),
 scale:clampGraphNumber(view.scale,1,.025,12),panX:clampGraphNumber(view.panX,0,-1e6,1e6),panY:clampGraphNumber(view.panY,0,-1e6,1e6)};
}
export type GraphSettings = ReturnType<typeof normalizeGraphView>;
export function graphAnchoredControlValue(value:number,minimum:number,maximum:number,defaultValue:number) {
 const normalized=clampGraphNumber(value,50,0,100)/100;
 return minimum+(maximum-minimum)*Math.pow(normalized,Math.log((defaultValue-minimum)/(maximum-minimum))/Math.log(.5));
}
export function graphForceParameters(view: Pick<GraphSettings,'repulsionForce'|'linkAttraction'|'centerForce'|'linkLength'|'nodeSpacing'>, playing=false) {
 return {repulsion:100*graphAnchoredControlValue(view.repulsionForce,.35,5,1),attraction:graphAnchoredControlValue(view.linkAttraction,.3,4.6,1),
 restLength:view.linkLength,centerPull:.02*graphAnchoredControlValue(view.centerForce,.28,4.2,1),collisionGap:graphAnchoredControlValue(view.nodeSpacing,2,104,14),
 damping:.6,alphaDecay:playing?.005:1-Math.pow(.001,1/300)};
}
export const graphEdgeKey=(a:number,b:number)=>`${Math.min(a,b)}:${Math.max(a,b)}`;
export function isMissingGraphNode(node:GraphSeedNode) {return node.status==='missing'||!!node.missingTarget||!!(node.entityId?.startsWith('missing-real-vault:')||node.entityId?.startsWith('real-vault-missing:'));}
export function graphNodeRadiusForLinks(links:number,missing=false) {return missing?3.6:3.6+Math.min(3.4,links<=1?0:Math.sqrt(Math.max(0,links-1))*.85);}
export function collectGraphNeighborhood(adjacency:Map<number,Set<number>>,rootId:number,depth:1|2) {
 const result=new Set([rootId]);let frontier=new Set([rootId]);
 for(let level=0;level<depth&&frontier.size;level++){const next=new Set<number>();for(const id of frontier)for(const n of adjacency.get(id)||[]){if(result.has(n))continue;result.add(n);next.add(n);}frontier=next;}return result;
}
/** Adapter passes paths explicitly; no desktop entity-ID parser or host bridge. */
export type GraphPathResolver = (node:GraphSeedNode)=>string|null;
export const graphNodePath:GraphPathResolver=node=>node.relativePath||(node.entityId?.startsWith('real-vault-asset:')?node.entityId.slice('real-vault-asset:'.length):null);
export type GraphSearchResult = {kind:'folder';key:string;label:string;path:string;nodeKeys:string[]}|{kind:'document';key:string;label:string;path:string;node:GraphSeedNode};
export function buildGraphSearchResults(nodes:GraphSeedNode[],query:string,pathOf:GraphPathResolver=graphNodePath):GraphSearchResult[] {
 const q=query.trim().toLocaleLowerCase();if(!q)return[];const folders=new Map<string,Set<string>>();
 for(const node of nodes){if(node.type!=='note')continue;const path=pathOf(node);if(!path)continue;const parts=path.split('/').filter(Boolean);parts.pop();for(let i=1;i<=parts.length;i++){const p=parts.slice(0,i).join('/');let keys=folders.get(p);if(!keys)folders.set(p,keys=new Set());keys.add(node.key);}}
 const folderResults:GraphSearchResult[]=[...folders].filter(([p])=>p.toLocaleLowerCase().includes(q)).sort(([a],[b])=>a.localeCompare(b,'zh-CN')).map(([path,keys])=>({kind:'folder',key:`folder:${path}`,label:path.split('/').pop()||path,path,nodeKeys:[...keys]}));
 const docs:GraphSearchResult[]=nodes.filter(n=>n.type==='note'&&(n.label.toLocaleLowerCase().includes(q)||pathOf(n)?.toLocaleLowerCase().includes(q))).map(node=>({kind:'document',key:node.key,label:node.label,path:pathOf(node)||'',node}));
 return [...folderResults,...docs].slice(0,12);
}
export function graphSearchScopeKeys(result:GraphSearchResult,seed:GraphSeed) {
 const keys=new Set(result.kind==='folder'?result.nodeKeys:[result.node.key]);if(result.kind==='document'){const byId=new Map(seed.nodes.map(n=>[n.id,n]));for(const [a,b] of seed.edges){if(a!==result.node.id&&b!==result.node.id)continue;const n=byId.get(a===result.node.id?b:a);if(n)keys.add(n.key);}}return keys;
}
export type GraphFilteredNode = GraphSeedNode & {links:number;r:number;hidden:boolean;dimmed:boolean;color:string};
export type GraphFilteredEdge = {a:GraphFilteredNode;b:GraphFilteredNode;kind:GraphEdgeKind;direction:GraphEdgeDirection;relatedToFocus:boolean;dimmed:boolean};
export type GraphSceneOptions = {scopeKeys?:Set<string>|null; selectedId?:number|null; hoveredId?:number|null;draggingId?:number|null;contextId?:number|null;nodeColor?:string;accent?:string;pathOf?:GraphPathResolver};
function mixHex(foreground:string,background:string,weight:number){const f=foreground.replace(/^#/,''),b=background.replace(/^#/,'');if(!/^[0-9a-f]{6}$/i.test(f)||!/^[0-9a-f]{6}$/i.test(b))return foreground;return '#'+[0,2,4].map(i=>Math.round(parseInt(f.slice(i,i+2),16)*weight+parseInt(b.slice(i,i+2),16)*(1-weight)).toString(16).padStart(2,'0')).join('');}
export function filteredGraph(seed:GraphSeed,settings:GraphSettings,options:GraphSceneOptions={}) {
 const degree=new Map<number,number>(),tags=new Map<number,string[]>(),original=new Map(seed.nodes.map(n=>[n.id,n]));
 for(const [a,b]of seed.edges){degree.set(a,(degree.get(a)||0)+1);degree.set(b,(degree.get(b)||0)+1);const left=original.get(a),right=original.get(b);if(left?.type==='tag'&&right)tags.set(b,[...(tags.get(b)||[]),left.label]);if(right?.type==='tag'&&left)tags.set(a,[...(tags.get(a)||[]),right.label]);}
 const nodes:GraphFilteredNode[]=seed.nodes.map(n=>{const links=degree.get(n.id)||0;const group=settings.colorGroups.find(g=>graphGroupMatches(g.query,n.label,(options.pathOf||graphNodePath)(n)||'',tags.get(n.id)||[]));
 const base=options.nodeColor||'#f2f3f5';const tones={note:'#f2f3f5',material:'#c5cad1',tag:'#9198a2',web:'#707780'};
 const color=isMissingGraphNode(n)?'#59606a':group?group.color:settings.colorMode==='degree'?DEGREE_COLORS[Math.min(links,DEGREE_COLORS.length-1)]:settings.colorMode==='default'||n.type==='note'?base:mixHex(options.accent||'#7c8aff',tones[n.type],n.type==='material'?.16:n.type==='tag'?.32:.1);
 return {...n,links,r:graphNodeRadiusForLinks(links,isMissingGraphNode(n)),hidden:false,dimmed:false,color};});
 const byId=new Map(nodes.map(n=>[n.id,n])),visibleNodes=nodes.filter(n=>settings.filters[n.type]&&(!options.scopeKeys||options.scopeKeys.has(n.key))),visibleIds=new Set(visibleNodes.map(n=>n.id)),adjacency=new Map<number,Set<number>>(),visibleEdges:GraphFilteredEdge[]=[];
 for(const[a,b]of seed.edges){if(!visibleIds.has(a)||!visibleIds.has(b))continue;const left=byId.get(a),right=byId.get(b);if(!left||!right)continue;visibleEdges.push({a:left,b:right,kind:seed.edgeKinds?.[graphEdgeKey(a,b)]||'relation',direction:seed.edgeDirections?.[graphEdgeKey(a,b)]||'undirected',relatedToFocus:false,dimmed:false});if(!adjacency.has(a))adjacency.set(a,new Set());if(!adjacency.has(b))adjacency.set(b,new Set());adjacency.get(a)!.add(b);adjacency.get(b)!.add(a);}
 const nearbyFocusId=settings.nearbyFilter?(options.hoveredId??options.selectedId??options.contextId??null):null;
 const activeFocusId=options.draggingId??options.hoveredId??nearbyFocusId??options.selectedId??null;
 const connectedIds=new Set<number>();if(activeFocusId!==null){connectedIds.add(activeFocusId);for(const id of adjacency.get(activeFocusId)||[])connectedIds.add(id);}
 const nearbyIds=nearbyFocusId!==null?collectGraphNeighborhood(adjacency,nearbyFocusId,settings.nearbyDepth):connectedIds;
 for(const node of nodes){const isolated=(adjacency.get(node.id)?.size||0)===0,preserve=!!options.scopeKeys||options.selectedId===node.id||nearbyFocusId===node.id;
 node.hidden=!visibleIds.has(node.id)||(!settings.showIsolated&&isolated&&!preserve)||(nearbyFocusId!==null&&!nearbyIds.has(node.id));node.dimmed=node.hidden||(activeFocusId!==null&&!connectedIds.has(node.id));}
 for(const edge of visibleEdges){edge.relatedToFocus=activeFocusId!==null&&(edge.a.id===activeFocusId||edge.b.id===activeFocusId);edge.dimmed=edge.a.hidden||edge.b.hidden||(activeFocusId!==null&&!edge.relatedToFocus);}
 return {nodes,visibleNodes,visibleEdges,adjacency,connectedIds,nearbyFocusId,activeFocusId,tags,
 renderedNodes:visibleNodes.filter(n=>!n.hidden),renderedEdges:visibleEdges.filter(e=>!e.a.hidden&&!e.b.hidden)};
}
export const GRAPH_EDGE_WIDTHS:Record<GraphEdgeKind,number>={relation:.86,'wiki-link':1,tag:.76,embed:.9,'embed-document':.94,'embed-asset':.94,'embed-vault-asset':.82,web:.78};
/** Eligibility only. Actual mutations must be explicit and revision-checked by the local vault adapter. */
export function isEditableGraphRelationPair(a:GraphSeedNode|null|undefined,b:GraphSeedNode|null|undefined) {
 if(!a||!b||a.key===b.key||a.status==='missing'||b.status==='missing'||a.type==='web'||b.type==='web')return false;
 return a.type==='tag'?(b.type==='material'||b.type==='note'):b.type==='tag'?(a.type==='material'||a.type==='note'):false;
}
export function isEditableGraphBodyRelationPair(a:GraphSeedNode|null|undefined,b:GraphSeedNode|null|undefined) {
 if(!a||!b||a.key===b.key||a.status==='missing'||b.status==='missing'||!a.entityId||!b.entityId)return false;
 return (a.type==='note'&&(b.type==='note'||b.type==='material'))||(a.type==='material'&&b.type==='note');
}
export function graphNodesAreConnected(edges:GraphSeed['edges'],a:GraphSeedNode,b:GraphSeedNode) {return edges.some(([x,y])=>Math.min(x,y)===Math.min(a.id,b.id)&&Math.max(x,y)===Math.max(a.id,b.id));}
