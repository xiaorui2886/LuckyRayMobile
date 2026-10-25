/** Exact Desktop graph.ts build kernel + exact local helpers from 200433932c46.
 * Only bridge index TYPE declarations and identity encoders are test adapters;
 * normalized parity compares labels/types/directions/edge kinds, not encoded IDs.
 * No application bridge, network, desktop database, or user data is loaded. */
import {createRealVaultWikiTargetResolver,normalizeVaultRelativePath,parseWikiReferenceTarget,realVaultMissingDocumentLocation,stripMarkdownExtension} from '../../src/features/graph/core/wikiTargets.ts';
import type {GraphType,GraphSeedNode,GraphSeed,GraphEdge,GraphEdgeKind,GraphEdgeDirection} from '../../src/features/graph/core/graphTypes.ts';
type BridgeNotesVaultMarkdownIndexDocument={relativePath:string;fileName?:string;title?:string;mtime?:string;wikiLinks?:{target?:string;raw?:string}[];frontmatterTags?:string[]};
type BridgeNotesVaultMarkdownIndex={vaultId:string;documents:BridgeNotesVaultMarkdownIndexDocument[]};
const TYPE_LABELS:Record<GraphType,string>={material:'素材',note:'笔记',tag:'标签',web:'网页'};
const knowledgeTagCanonicalKey=(value:string)=>value.trim().normalize('NFC').toLowerCase();
const knowledgeDocumentNoteId=(ref:{vaultId:string;relativePath:string})=>`real-vault:${encodeURIComponent(ref.vaultId)}:${encodeURIComponent(ref.relativePath)}`;
const knowledgeTagIdentity=(vault:string,tag:string)=>`real-vault-tag:${encodeURIComponent(vault)}:${encodeURIComponent(knowledgeTagCanonicalKey(tag))}`;
function compactLabel(value: string | null | undefined, fallback: string) {
  const next = String(value || "").trim();
  return next || fallback;
}

function graphTimelineAt(value: string | null | undefined) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}




function graphEdgeKey(a: number, b: number) {
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}

export function mergeGraphEdgeDirection(
  current: GraphEdgeDirection | undefined,
  incoming: Exclude<GraphEdgeDirection, "bidirectional" | "undirected">,
): GraphEdgeDirection {
  if (!current) return incoming;
  if (current === "undirected" || current === "bidirectional" || current === incoming) return current;
  return "bidirectional";
}

function realVaultDocumentLabel(document: BridgeNotesVaultMarkdownIndexDocument) {
  const relativePath = normalizeVaultRelativePath(document.relativePath);
  return compactLabel(document.title, stripMarkdownExtension(document.fileName || relativePath.split("/").pop() || relativePath));
}

function normalizeRealVaultFrontmatterTag(value: string | null | undefined) {
  return (value || "").trim().replace(/^#+/, "").trim();
}

function realVaultDocumentEntityId(vaultId: string, relativePath: string) {
  return knowledgeDocumentNoteId({ vaultId, relativePath: normalizeVaultRelativePath(relativePath) });
}

function realVaultTagEntityId(vaultId: string, tagName: string) {
  return knowledgeTagIdentity(vaultId, tagName);
}

export type RealVaultGraphEmbedResolution =
  | { kind: "document"; relativePath: string }
  | { kind: "library-asset"; assetId: string; assetName: string }
  | { kind: "vault-asset"; relativePath: string; label: string };

type RealVaultGraphEmbedResolutionMap = Map<string, RealVaultGraphEmbedResolution[]>;

export function buildRealVaultGraphSeed(index: BridgeNotesVaultMarkdownIndex, embedResolutions: RealVaultGraphEmbedResolutionMap = new Map()): GraphSeed {
  const documents = (index.documents || [])
    .map((document) => ({ ...document, relativePath: normalizeVaultRelativePath(document.relativePath) }))
    .filter((document) => Boolean(document.relativePath));
  if (!documents.length) return { source: "empty", sourceKind: "real-vault", nodes: [], edges: [], edgeKinds: {}, edgeDirections: {} };

  const nodes: GraphSeedNode[] = [];
  const nodeIds = new Map<string, number>();
  const documentNodeIds = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const edgeKinds: Record<string, GraphEdgeKind> = {};
  const edgeDirections: Record<string, GraphEdgeDirection> = {};
  const edgesByKey = new Map<string, GraphEdge>();

  const addNode = (type: GraphType, entityId: string, label: string, timelineAt?: number, metadata?: Pick<GraphSeedNode, "status" | "missingTarget">) => {
    const key = `${type}:${entityId}`;
    const existing = nodeIds.get(key);
    if (existing !== undefined) {
      const existingNode = nodes[existing];
      if (timelineAt !== undefined && (existingNode.timelineAt === undefined || timelineAt < existingNode.timelineAt)) {
        existingNode.timelineAt = timelineAt;
      }
      return existing;
    }
    const id = nodes.length;
    nodes.push({ id, key, entityId, type, label: compactLabel(label, TYPE_LABELS[type]), timelineAt, ...metadata });
    nodeIds.set(key, id);
    return id;
  };

  const addEdge = (a: number | undefined, b: number | undefined, kind: GraphEdgeKind) => {
    if (a === undefined || b === undefined || a === b) return;
    const key = graphEdgeKey(a, b);
    const existing = edgesByKey.get(key);
    if (existing) {
      const incoming = existing[0] === a && existing[1] === b ? "forward" : "reverse";
      edgeDirections[key] = mergeGraphEdgeDirection(edgeDirections[key], incoming);
      return;
    }
    const edge: GraphEdge = [a, b];
    edgesByKey.set(key, edge);
    edgeKinds[key] = kind;
    edgeDirections[key] = "forward";
    edges.push(edge);
  };

  for (const document of documents) {
    const relativePath = normalizeVaultRelativePath(document.relativePath);
    documentNodeIds.set(
      relativePath,
      addNode("note", realVaultDocumentEntityId(index.vaultId, relativePath), realVaultDocumentLabel(document), graphTimelineAt(document.mtime)),
    );
  }

  const resolveWikiTarget = createRealVaultWikiTargetResolver(documents);
  for (const document of documents) {
    const sourcePath = normalizeVaultRelativePath(document.relativePath);
    const sourceNodeId = documentNodeIds.get(sourcePath);
    const sourceTimelineAt = graphTimelineAt(document.mtime);
    for (const link of document.wikiLinks || []) {
      const rawTarget = link.target || link.raw || "";
      if (!parseWikiReferenceTarget(rawTarget).targetTitle) continue;
      const resolved = resolveWikiTarget(rawTarget, sourcePath);
      if (resolved) {
        addEdge(sourceNodeId, documentNodeIds.get(normalizeVaultRelativePath(resolved.relativePath)), "wiki-link");
        continue;
      }
      const missingTarget = realVaultMissingDocumentLocation(rawTarget, sourcePath, { defaultParent: "root" });
      if (!missingTarget || !missingTarget.title || !normalizeVaultRelativePath(missingTarget.relativePath)) continue;
      const missingNodeId = addNode(
        "note",
        `missing-real-vault:${encodeURIComponent(sourcePath.toLocaleLowerCase())}:${encodeURIComponent(missingTarget.relativePath.toLocaleLowerCase())}`,
        missingTarget.title,
        sourceTimelineAt,
        { status: "missing", missingTarget: { ...missingTarget, rawTarget, sourceRelativePath: sourcePath } },
      );
      addEdge(sourceNodeId, missingNodeId, "wiki-link");
    }

    for (const resolution of embedResolutions.get(sourcePath) || []) {
      if (resolution.kind === "document") {
        addEdge(sourceNodeId, documentNodeIds.get(normalizeVaultRelativePath(resolution.relativePath)), "embed-document");
      } else if (resolution.kind === "library-asset") {
        const assetNodeId = addNode("material", resolution.assetId, resolution.assetName, sourceTimelineAt);
        addEdge(sourceNodeId, assetNodeId, "embed-asset");
      } else {
        const vaultAssetNodeId = addNode(
          "material",
          `real-vault-asset:${normalizeVaultRelativePath(resolution.relativePath)}`,
          resolution.label,
          sourceTimelineAt,
        );
        addEdge(sourceNodeId, vaultAssetNodeId, "embed-vault-asset");
      }
    }

    const seenTags = new Set<string>();
    for (const rawTag of document.frontmatterTags || []) {
      const tagName = normalizeRealVaultFrontmatterTag(rawTag);
      const tagKey = knowledgeTagCanonicalKey(tagName);
      if (!tagKey || seenTags.has(tagKey)) continue;
      seenTags.add(tagKey);
      const tagNodeId = addNode("tag", realVaultTagEntityId(index.vaultId, tagName), tagName, sourceTimelineAt);
      addEdge(sourceNodeId, tagNodeId, "tag");
    }
  }

  return { source: "real", sourceKind: "real-vault", nodes, edges, edgeKinds, edgeDirections };
}

