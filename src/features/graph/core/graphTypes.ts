/** Portable desktop graph data contract, desktop 200433932c46, services/graph.ts.
 * IDs belong to one seed; stable keys identify nodes across rebuilds. */
export type GraphType = 'material' | 'note' | 'tag' | 'web';
export type GraphEdge = [number, number];
export type GraphEdgeKind = 'relation' | 'wiki-link' | 'tag' | 'embed' | 'embed-document' | 'embed-asset' | 'embed-vault-asset' | 'web';
export type GraphEdgeDirection = 'forward' | 'reverse' | 'bidirectional' | 'undirected';
export type GraphMissingTarget = { relativePath: string; parentPath: string; fileName: string; title: string; rawTarget: string; sourceRelativePath: string };
export type GraphSeedNode = { id: number; key: string; entityId?: string | null; label: string; type: GraphType; timelineAt?: number; status?: 'missing'; missingTarget?: GraphMissingTarget;
  /** Mobile-local metadata adapters may supply these without changing seed semantics. */
  relativePath?: string; tags?: string[];
};
export type GraphSeed = { nodes: GraphSeedNode[]; edges: GraphEdge[]; source: 'real' | 'empty'; sourceKind?: 'real-vault'; edgeKinds?: Record<string, GraphEdgeKind>; edgeDirections?: Record<string, GraphEdgeDirection> };
export type GraphViewState = {
  spatialVersion?: number; colorGroups?: { query: string; color: string }[]; sections?: Record<string, boolean>;
  filters?: Record<GraphType, boolean>; showIsolated?: boolean; nearbyFilter?: boolean; nearbyDepth?: 1 | 2;
  colorMode?: 'default' | 'type' | 'degree'; showArrows?: boolean; showLabels?: boolean; labelReveal?: number;
  textOpacity?: number; nodeSize?: number; edgeWidth?: number; forceStrength?: number; centerForce?: number;
  repulsionForce?: number; linkAttraction?: number; linkLength?: number; nodeSpacing?: number;
  scale?: number; panX?: number; panY?: number;
};
