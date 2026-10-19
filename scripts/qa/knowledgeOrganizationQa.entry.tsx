// KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.1 — VISUAL QA build only (never
// shipped). Renders the REAL product components for the new ORG states at
// 360/392: directory live / cached-offline, the fixed directory sheet, the
// move destination sheet, the Knowledge selection bar over NOTE rows, the
// in-scroll batch partial outcome, and the fail-closed conflict / no-grant
// states. No copy is invented here — every state is the production markup.
import React from "react";
import { createRoot } from "react-dom/client";
import { CollectionView, type NoteItem } from "../../src/presentation/still01/Views";
import { Button } from "../../src/still/kit/StillImports";
import { DirectorySheet } from "../../src/still/kit/directorySheet";
import { DirectoryStatusLine } from "../../src/still/kit/directoryStatusLine";
import { DesktopKnowledgeStatus } from "../../src/still/kit/desktopKnowledgeStatus";
import type { KnowledgeBrowseSnapshot } from "../../src/still/kit/knowledgeBrowseController";
import { literalSegments, bodyHitContext } from "../../src/still/kit/searchHit";
import type { DirectorySnapshot } from "../../src/still/kit/knowledgeDirectoryController";
import "../../src/presentation/still01/still.css";

const notes: NoteItem[] = [
  { id: "desktop:A:v:n1", title: "会议记录：一季度规划", body: "", source: "desktop", meta: "这是第 1 篇笔记的缓存正文预览…", state: "synced", notebook: "LuckyRay 知识库" },
  { id: "desktop:A:v:n2", title: "部署手册", body: "", source: "desktop", meta: "这是第 2 篇笔记的缓存正文预览…", state: "synced", notebook: "LuckyRay 知识库" },
  { id: "desktop:A:v:n3", title: "读书笔记", body: "", source: "desktop", meta: "正文尚未缓存", state: "synced", notebook: "LuckyRay 知识库" },
];

function dirSnap(over: Partial<DirectorySnapshot>): DirectorySnapshot {
  return {
    phase: "ready", instanceId: "A", vaultId: "v", directory: "Work", query: "",
    rows: notes.map((n, i) => ({
      instanceId: "A", vaultId: "v", noteId: `n${i + 1}`, title: n.title,
      relativePath: `Work/n${i + 1}.md`, revision: "r1", remoteRevision: "r2",
      dirty: false, conflict: false,
    })),
    page: 1, hasMore: false, source: "live", errorCode: "", identity: "dir|A|v|Work|",
    ...over,
  };
}

/** The EXACT page markup of the in-scroll partial outcome block (R1.2: the
 *  failure entries show the recognizable note TITLE + reason). */
function BatchOutcome({ succeeded, failures }: { succeeded: number; failures: Array<{ title: string; reason: string }> }) {
  return (
    <>
      <div className="st-kb-status is-danger" role="status" data-testid="org-batch-outcome">
        <span>移动部分完成：成功 {succeeded} 篇 · 未移动 {failures.length} 篇</span>
        <Button kind="quiet" onClick={() => {}}>知道了</Button>
      </div>
      <div className="st-kb-status" role="status">
        <span>{failures.slice(0, 3).map((f) => `「${f.title}」${f.reason}`).join("；")}</span>
      </div>
    </>
  );
}

function kbSnap(over) {
  return {
    phase: "ready", instanceId: "A", vaultId: "v", vaultName: "LuckyRay 知识库",
    query: "知识", rows: [], nextAfterId: null, hasMore: false,
    loadingMore: false, errorCode: "", remoteCode: "", certifiedVersion: null,
    ...over,
  };
}

const hitNotes = [
  {
    id: "desktop:A:v:h1", title: "知识库设计方案", body: "", source: "desktop",
    meta: "这是第 1 篇笔记的缓存正文预览…", state: "synced", notebook: "LuckyRay 知识库",
    titleHit: literalSegments("知识库设计方案", "知识库"),
  },
  {
    id: "desktop:A:v:h2", title: "部署手册", body: "", source: "desktop",
    meta: "正文尚未缓存", state: "synced", notebook: "LuckyRay 知识库",
    bodyHitLine: (() => {
      const hit = bodyHitContext("很长的缓存正文中知识库出现在这个位置的后方还有文字", "知识库");
      return hit ? { kind: "hit", segments: hit.segments } : undefined;
    })(),
  },
  {
    id: "desktop:A:v:h3", title: "读书笔记", body: "", source: "desktop",
    meta: "正文尚未缓存", state: "synced", notebook: "LuckyRay 知识库",
    bodyHitLine: { kind: "fallback", text: "匹配位置需打开笔记查看" },
  },
];

function App() {
  const live = dirSnap({});
  const cached = dirSnap({ source: "cache" });
  return (
    <div>
      {/* 1. directory live */}
      <section className="case" data-name="org-directory-live">
        <h2>org-directory-live</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView
            domain="knowledge" source="desktop" onSource={() => {}} query="" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={notes} assets={[]}
            open={() => {}} paired connected list={false} onList={() => {}}
            filterLabel="Work · 目录" disableNew hideFilter
            statusSlot={<DirectoryStatusLine snapshot={live} onConnect={() => {}} />}
            loadMoreSlot={null}
          />
        </div>
      </section>

      {/* 2. directory cached / offline */}
      <section className="case" data-name="org-directory-cached-offline">
        <h2>org-directory-cached-offline</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView
            domain="knowledge" source="desktop" onSource={() => {}} query="" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={notes} assets={[]}
            open={() => {}} paired connected={false} list={false} onList={() => {}}
            filterLabel="Work · 已缓存目录" disableNew hideFilter
            statusSlot={<DirectoryStatusLine snapshot={cached} onConnect={() => {}} />}
            loadMoreSlot={null}
          />
        </div>
      </section>

      {/* 3. the fixed directory sheet (one ROOT; vault = caption) */}
      <section className="case" data-name="org-directory-sheet">
        <h2>org-directory-sheet</h2>
        <div className="st-app" data-mode="light">
          <DirectorySheet
            registerOverlay={() => () => {}} onClose={() => {}}
            instanceId="A" vaultId="v" vaultName="LuckyRay 知识库" connected
            current="Work" onSelect={() => {}}
          />
        </div>
      </section>

      {/* 4. the move destination sheet */}
      <section className="case" data-name="org-move-destination">
        <h2>org-move-destination</h2>
        <div className="st-app" data-mode="light">
          <DirectorySheet
            registerOverlay={() => () => {}} onClose={() => {}}
            instanceId="A" vaultId="v" vaultName="LuckyRay 知识库" connected
            current="Docs" onSelect={() => {}}
            title="移动到目录" rootLabel="根目录（全部笔记）"
          />
        </div>
      </section>

      {/* 8. the fail-closed no-write-grant move sheet */}
      <section className="case" data-name="org-move-no-grant">
        <h2>org-move-no-grant</h2>
        <div className="st-app" data-mode="light">
          <DirectorySheet
            registerOverlay={() => () => {}} onClose={() => {}}
            instanceId="A" vaultId="v" vaultName="LuckyRay 知识库" connected
            current="（多选）" onSelect={() => {}}
            title="移动到目录" rootLabel="根目录（全部笔记）"
            notice="未获电脑知识库写入授权，无法移动"
          />
        </div>
      </section>

      {/* 5. the Knowledge selection bar over NOTE rows */}
      <section className="case" data-name="org-selection-bar">
        <h2>org-selection-bar</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView
            domain="knowledge" source="desktop" onSource={() => {}} query="" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={notes} assets={[]}
            open={() => {}} paired connected list={false} onList={() => {}}
            filterLabel="Work · 目录" disableNew hideFilter
            selecting
            selectedIds={notes.slice(0, 2).map((n) => n.id)}
            onLongPress={() => {}}
            selectionBar={{ count: 2, onCancel: () => {}, onOrganize: () => {}, organizeLabel: "移动" }}
            statusSlot={null}
            loadMoreSlot={null}
          />
        </div>
      </section>

      {/* 6. batch partial (in-scroll, product markup) */}
      <section className="case" data-name="org-batch-partial">
        <h2>org-batch-partial</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView
            domain="knowledge" source="desktop" onSource={() => {}} query="" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={notes} assets={[]}
            open={() => {}} paired connected list={false} onList={() => {}}
            filterLabel="Work · 目录" disableNew hideFilter
            statusSlot={<BatchOutcome succeeded={2} failures={[{ title: "部署手册", reason: "笔记已在电脑上被修改（版本冲突）" }]} />}
            loadMoreSlot={null}
          />
        </div>
      </section>

      {/* 7. revision conflict outcome (fail-closed copy) */}
      <section className="case" data-name="org-move-conflict">
        <h2>org-move-conflict</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView
            domain="knowledge" source="desktop" onSource={() => {}} query="" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={notes} assets={[]}
            open={() => {}} paired connected list={false} onList={() => {}}
            filterLabel="Work · 目录" disableNew hideFilter
            statusSlot={<BatchOutcome succeeded={0} failures={[{ title: "会议记录：一季度规划", reason: "先等待同步完成后再移动" }, { title: "部署手册", reason: "笔记已在电脑上被修改（版本冲突）" }]} />}
            loadMoreSlot={null}
          />
        </div>
      </section>
      {/* R1.5-A: directory sheet hydration states (fixture-keyed vaults). */}
      <section className="case" data-name="org-dir-sheet-hydrating">
        <h2>org-dir-sheet-hydrating</h2>
        <div className="st-app" data-mode="light">
          <DirectorySheet registerOverlay={() => () => {}} onClose={() => {}}
            instanceId="A" vaultId="v-hang" vaultName="LuckyRay 知识库" connected current="Work" onSelect={() => {}} />
        </div>
      </section>
      <section className="case" data-name="org-dir-sheet-hydrating-empty">
        <h2>org-dir-sheet-hydrating-empty</h2>
        <div className="st-app" data-mode="light">
          <DirectorySheet registerOverlay={() => () => {}} onClose={() => {}}
            instanceId="A" vaultId="v-hang-empty" vaultName="LuckyRay 知识库" connected current="" onSelect={() => {}} />
        </div>
      </section>
      <section className="case" data-name="org-dir-sheet-hydrated">
        <h2>org-dir-sheet-hydrated</h2>
        <div className="st-app" data-mode="light">
          <DirectorySheet registerOverlay={() => () => {}} onClose={() => {}}
            instanceId="A" vaultId="v-done" vaultName="LuckyRay 知识库" connected current="Work" onSelect={() => {}} />
        </div>
      </section>
      <section className="case" data-name="org-dir-sheet-unsynced">
        <h2>org-dir-sheet-unsynced</h2>
        <div className="st-app" data-mode="light">
          <DirectorySheet registerOverlay={() => () => {}} onClose={() => {}}
            instanceId="A" vaultId="v-off" vaultName="LuckyRay 知识库" connected={false} current="" onSelect={() => {}} />
        </div>
      </section>

      {/* R1.5-B: the Desktop New Note button enabled under write truth. */}
      <section className="case" data-name="org-desktop-new-enabled">
        <h2>org-desktop-new-enabled</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={notes} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew={false} hideFilter statusSlot={null} loadMoreSlot={null} />
        </div>
      </section>

      {/* R1.5-C: search fast-path states. */}
      <section className="case" data-name="org-search-idle">
        <h2>org-search-idle</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={notes} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew hideFilter statusSlot={<DesktopKnowledgeStatus snapshot={kbSnap({ query: "" })} onConnect={() => {}} />} loadMoreSlot={null} />
        </div>
      </section>
      <section className="case" data-name="org-search-searching">
        <h2>org-search-searching</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="知识" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={notes} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew hideFilter statusSlot={<DesktopKnowledgeStatus snapshot={kbSnap({ phase: "searching" })} onConnect={() => {}} />} loadMoreSlot={null} />
        </div>
      </section>

      {/* R1.5-D: proven literal hit presentation. */}
      <section className="case" data-name="org-search-title-hit">
        <h2>org-search-title-hit</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="知识库" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={[hitNotes[0]]} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew hideFilter statusSlot={null} loadMoreSlot={null} />
        </div>
      </section>
      {/* R1.6-A: the SAME hit states under the DARK theme (contrast pair). */}
      <section className="case" data-name="org-search-title-hit-dark">
        <h2>org-search-title-hit-dark</h2>
        <div className="st-app" data-mode="dark" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="知识库" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={[hitNotes[0]]} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew hideFilter statusSlot={null} loadMoreSlot={null} />
        </div>
      </section>
      <section className="case" data-name="org-search-body-hit-dark">
        <h2>org-search-body-hit-dark</h2>
        <div className="st-app" data-mode="dark" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="知识库" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={[hitNotes[1]]} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew hideFilter statusSlot={null} loadMoreSlot={null} />
        </div>
      </section>

      {/* R1.6-B: a transient pending Desktop-note row (created on Mobile,
          not yet canonically converged). */}
      <section className="case" data-name="org-pending-row">
        <h2>org-pending-row</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={[
              {
                id: "desktop:A:v:p1", title: "新笔记", body: "", source: "desktop",
                meta: "正文尚未缓存 · 待同步", state: "pending", notebook: "LuckyRay 知识库",
              },
              ...notes.slice(0, 2),
            ]} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew hideFilter statusSlot={null} loadMoreSlot={null} />
        </div>
      </section>

      <section className="case" data-name="org-search-body-hit">
        <h2>org-search-body-hit</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="知识库" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={[hitNotes[1]]} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew hideFilter statusSlot={null} loadMoreSlot={null} />
        </div>
      </section>
      <section className="case" data-name="org-search-unknown">
        <h2>org-search-unknown</h2>
        <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
          <CollectionView domain="knowledge" source="desktop" onSource={() => {}} query="知识库" onQuery={() => {}}
            onNew={() => {}} onBrowse={() => {}} onRefresh={() => {}} notes={[hitNotes[2]]} assets={[]} open={() => {}}
            paired connected list={false} onList={() => {}} filterLabel="当前知识库 · LuckyRay 知识库"
            disableNew hideFilter statusSlot={null} loadMoreSlot={null} />
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
