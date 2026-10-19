import type { KnowledgeNavigationReader } from "../../services/knowledgeNavigationReader.ts";
import type { KnowledgeRelation } from "../../../shared/companion-services-v1/types.ts";
export type RelationScope = { instance: string; vault: string; note: string };
export type RelationSnapshot = RelationScope & {
  phase: "idle" | "loading" | "ready" | "offline" | "denied" | "unsupported" | "error";
  revision: string; items: KnowledgeRelation[];
};
export type WikiReference = { target: string; label: string; line: number; from: number; to: number; heading?: string };
export class KnowledgeRelations {
  private epoch = 0;
  private snap: RelationSnapshot;
  private client: Pick<KnowledgeNavigationReader, "relations">;
  private publish: (snapshot: RelationSnapshot) => void;
  constructor(scope: RelationScope, client: Pick<KnowledgeNavigationReader, "relations">, publish: (snapshot: RelationSnapshot) => void) {
    this.snap = { ...scope, phase: "idle", revision: "", items: [] }; this.client = client; this.publish = publish;
  }
  snapshot() { return this.snap; }
  retire() { ++this.epoch; }
  async load(online: boolean) {
    const token = ++this.epoch;
    const { instance, vault, note } = this.snap;
    const commit = (snapshot: RelationSnapshot) => { if (token === this.epoch) { this.snap = snapshot; this.publish(snapshot); } };
    if (!online) { commit({ ...this.snap, phase: "offline", items: [], revision: "" }); return; }
    commit({ ...this.snap, phase: "loading", items: [], revision: "" });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const items: KnowledgeRelation[] = [], cursors = new Set<string>();
        let after: string | undefined, revision: string | undefined;
        try {
          for (;;) {
            const page = await this.client.relations(instance, vault, note, { limit: 100, after });
            if (token !== this.epoch) return;
            if (revision !== undefined && revision !== page.revision) throw new Error("REVISION_CHANGED");
            revision = page.revision; items.push(...page.items);
            if (!page.hasMore) break;
            if (!page.nextAfter || cursors.has(page.nextAfter) || items.length > 100000) throw new Error("MALFORMED_RESPONSE");
            after = page.nextAfter; cursors.add(after);
          }
          commit({ instance, vault, note, phase: "ready", revision: revision || "", items }); return;
        } catch (error) {
          if (token !== this.epoch) return;
          if (attempt === 0 && (String((error as {code?: string})?.code) === "CURSOR_TOO_OLD" || String(error) === "Error: REVISION_CHANGED")) continue;
          throw error;
        }
      }
    } catch (error) {
      const code = String((error as { code?: string })?.code || error);
      const phase = ["GRANT_REQUIRED", "SCOPE_DENIED", "AUTH_REVOKED", "PAIRING_REQUIRED"].includes(code) ? "denied"
        : ["VERSION_UNSUPPORTED", "METHOD_NOT_ALLOWED"].includes(code) ? "unsupported" : "error";
      commit({ instance, vault, note, phase, revision: "", items: [] });
    }
  }
}
/** Use only the server's exact typed identities. No title or filesystem guess. */
export function resolveWikiReference(snapshot: RelationSnapshot, reference: WikiReference, revision: string, clean: boolean) {
  if (snapshot.phase !== "ready") return { kind: "unavailable" as const, noteIds: [] as string[] };
  if (!clean || !revision || snapshot.revision !== revision) return { kind: "stale" as const, noteIds: [] as string[] };
  const matches = snapshot.items.filter((item): item is Extract<KnowledgeRelation, {kind: "wikiLink"}> =>
    item.kind === "wikiLink" && item.line === reference.line && item.target === reference.target);
  // The protocol reports each occurrence; repeated identical links on one
  // line therefore legitimately have the same target and resolution.
  if (!matches.length || matches.some(item => item.status !== matches[0].status
    || JSON.stringify([...new Set(item.noteIds)].sort()) !== JSON.stringify([...new Set(matches[0].noteIds)].sort())))
    return { kind: "missing" as const, noteIds: [] as string[] };
  const match = matches[0], noteIds = [...new Set(match.noteIds)];
  if (match.status === "resolved" && noteIds.length === 1) return { kind: "resolved" as const, noteIds };
  if (match.status === "ambiguous" && noteIds.length > 1) return { kind: "ambiguous" as const, noteIds };
  return { kind: "missing" as const, noteIds: [] as string[] };
}
export function relationsStatus(phase: RelationSnapshot["phase"]) {
  if (phase === "loading" || phase === "idle") return "正在读取笔记链接…";
  if (phase === "offline") return "连接原电脑后可查看双向链接。";
  if (phase === "denied") return "未获笔记链接读取授权。";
  if (phase === "unsupported") return "当前电脑版本不支持双向链接。";
  if (phase === "error") return "笔记链接暂时无法读取，请稍后重试。";
  return "";
}
