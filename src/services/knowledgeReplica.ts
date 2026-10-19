/** Persisted scope and coverage only. Network, drafts and retries stay with
 * the existing Content sync coordinator/native transaction authority. */
export type KnowledgeReplicaLibrary = {
  instanceId: string;
  vaultId: string;
  name: string;
  confirmed: boolean;
  paused: boolean;
  waitingCurrent: boolean;
  writeState: "granted" | "readonly" | "revoked" | "unknown";
  metadataReady: boolean;
  total: number;
  ready: number;
  failed: number;
  unverified: number;
};
export type KnowledgeReplicaPage = {items: Array<{instanceId: string; vaultId: string; noteId: string; title: string; relativePath?: string; revision: string; content?: string; bodyOutdated?: boolean; dirty?: boolean; cachedDocument?: { content?: string } | null; serverDocument?: {revision?: string}}>; hasMore: boolean};
export type KnowledgeReplicaReader = {
  libraries(instance: string): Promise<KnowledgeReplicaLibrary[]>;
  notes(instance: string, vault: string, query: string, page: number): Promise<KnowledgeReplicaPage>;
};
