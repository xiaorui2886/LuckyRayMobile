// SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R1 — VISUAL QA build only (never
// shipped). Renders the REAL Knowledge page state component (the same
// `DesktopKnowledgeStatus` the product renders inside the view) across every
// canonical phase at 360/392. No copy is appended behind the view: these are
// the real production states through the real component.
import React from "react";
import { createRoot } from "react-dom/client";
import { CollectionView } from "../../src/presentation/still01/Views";
import { Button } from "../../src/still/kit/StillImports";
import { KnowledgeBrowseController, type KnowledgeBrowseSnapshot } from "../../src/still/kit/knowledgeBrowseController";
import "../../src/presentation/still01/still.css";

// The REAL status component, straight from the production page module.
import { DesktopKnowledgeStatus } from "../../src/still/kit/desktopKnowledgeStatus";

type Note = { id: string; title: string; body: string; source: "desktop"; meta: string; state: string; notebook: string };

const notes: Note[] = [
  { id: "desktop:A:v:n1", title: "会议记录：一季度规划", body: "", source: "desktop", meta: "notes/meetings/q1.md", state: "synced", notebook: "LuckyRay 知识库" },
  { id: "desktop:A:v:n2", title: "部署手册", body: "", source: "desktop", meta: "ops/deploy.md", state: "synced", notebook: "LuckyRay 知识库" },
  { id: "desktop:A:v:n3", title: "读书笔记", body: "", source: "desktop", meta: "personal/books.md", state: "synced", notebook: "LuckyRay 知识库" },
];

function snap(over: Partial<KnowledgeBrowseSnapshot>): KnowledgeBrowseSnapshot {
  return {
    phase: "idle", instanceId: "A", vaultId: "v", vaultName: "LuckyRay 知识库",
    query: "", rows: [], nextAfterId: null, hasMore: false,
    loadingMore: false, errorCode: "", remoteCode: "",
    ...over,
  };
}

const STATES: Array<{ name: string; snap: KnowledgeBrowseSnapshot; notes: Note[] }> = [
  { name: "kb-desktop-ready", snap: snap({ phase: "ready", hasMore: true, nextAfterId: "n3", rows: notes.map((n, i) => ({ instanceId: "A", vaultId: "v", noteId: `n${i + 1}`, title: n.title, parentRelativePath: n.meta, revision: "r" })) }), notes: withPreviews(notes) },
  { name: "kb-desktop-no-body", snap: snap({ phase: "ready", rows: notes.slice(0, 2).map((n, i) => ({ instanceId: "A", vaultId: "v", noteId: `n${i + 1}`, title: n.title, parentRelativePath: n.meta, revision: "r" })) }), notes: withFallback(notes.slice(0, 2)) },
  { name: "kb-desktop-loading-more", snap: snap({ phase: "loading-more", hasMore: true, rows: notes.map((n, i) => ({ instanceId: "A", vaultId: "v", noteId: `n${i + 1}`, title: n.title, parentRelativePath: n.meta, revision: "r" })), nextAfterId: "n3" }), notes: withPreviews(notes) },
  { name: "kb-desktop-loading", snap: snap({ phase: "loading" }), notes: [] },
  { name: "kb-desktop-empty", snap: snap({ phase: "ready", rows: [] }), notes: [] },
  { name: "kb-desktop-not-granted", snap: snap({ phase: "not-granted", remoteCode: "GRANT_REQUIRED" }), notes: [] },
  { name: "kb-desktop-temporarily-unavailable", snap: snap({ phase: "temporarily-unavailable", remoteCode: "SERVICE_UNAVAILABLE" }), notes: [] },
  { name: "kb-desktop-unsupported", snap: snap({ phase: "unsupported" }), notes: [] },
  { name: "kb-desktop-offline", snap: snap({ phase: "offline" }), notes: [] },
];

/** R4 (B): the row meta is the BODY PREVIEW from note_cache (or the truthful
 *  fallback) — mirroring exactly what the page renders per preview store. */
function withPreviews(rows: typeof notes): typeof notes {
  return rows.map((n, i) => ({ ...n, meta: `这是第 ${i + 1} 篇笔记的缓存正文预览…` }));
}
function withFallback(rows: typeof notes): typeof notes {
  return rows.map((n) => ({ ...n, meta: "正文尚未缓存" }));
}

function Frame({ s }: { s: (typeof STATES)[number] }) {
  const items = s.notes.map((n) => ({
    id: n.id, title: n.title, body: n.body, source: "desktop" as const,
    meta: n.meta, state: "synced" as const, notebook: n.notebook,
  }));
  return (
    <section className="case" data-name={s.name}>
      <h2>{s.name}</h2>
      <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
        <CollectionView
          domain="knowledge"
          source="desktop"
          onSource={() => {}}
          query=""
          onQuery={() => {}}
          onFilter={undefined}
          onNew={() => {}}
          onBrowse={() => {}}
          onRefresh={() => {}}
          notes={items}
          assets={[]}
          open={() => {}}
          paired
          connected={s.snap.phase !== "offline"}
          list={false}
          onList={() => {}}
          filterLabel={s.snap.vaultName ? `当前知识库 · ${s.snap.vaultName}` : "电脑知识库"}
          disableNew
          hideFilter
          statusSlot={<DesktopKnowledgeStatus snapshot={s.snap} onConnect={() => {}} />}
          loadMoreSlot={s.snap.hasMore || s.snap.phase === "loading-more" ? (
            <div style={{ padding: "10px 23px 4px" }}>
              <Button kind="quiet" disabled={s.snap.phase === "loading-more"} onClick={() => {}}>
                {s.snap.phase === "loading-more" ? "正在加载…" : "加载更多"}
              </Button>
            </div>
          ) : null}
        />
      </div>
    </section>
  );
}

function App() {
  return <div>{STATES.map((s) => <Frame key={s.name} s={s} />)}</div>;
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
