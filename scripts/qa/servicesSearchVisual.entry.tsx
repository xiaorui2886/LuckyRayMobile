// SERVICES-SEARCH-R1 — VISUAL QA ONLY (never shipped).
//
// Renders the REAL product search-results presentation (the exact Row /
// SectionTitle / Button components and layout StillSearch uses, plus the
// canonical 电脑结果 section over RemoteSearchSnapshot states) inside the
// real `.st-app` frame with production still.css, at 360px and 392px
// (MI8-like). Synthetic titles/URLs/snippets only.
import React from "react";
import { createRoot } from "react-dom/client";
import { Header, IconButton, Row, SectionTitle, Button, SearchField, Empty } from "../../src/presentation/still01/Still";
import { DesktopResultsSection } from "../../src/still/kit/desktopResultsSection.tsx";
import type { RemoteSearchSnapshot, SearchHit } from "../../src/still/kit/searchServicesController.ts";
import "../../src/presentation/still01/still.css";

const hits: SearchHit[] = [
  { domain: "materials", assetId: "a-1", title: "一张非常长的桌面素材标题——深色主题海报最终交付版本-包含完整图层信息.png", subtitle: "来自桌面同步" },
  { domain: "knowledge", vaultId: "v-1", noteId: "n-1", title: "知识笔记：项目复盘会议记录", path: "工作/2026/复盘 会议记录总结长期标题路径.md", snippet: "这是一段很长的知识库摘要片段，用于验证 360px 与 392px 视口下的换行、截断与触摸目标表现是否正常，包含中英文混排 keywords and phrases." },
  { domain: "materials", assetId: "a-2", title: "logo.png" },
];

const mk = (over: Partial<RemoteSearchSnapshot>): RemoteSearchSnapshot => ({
  phase: "ready", query: "海报", instanceId: "desktop-c8ba8c9baff7ba65c4fc26824740c544",
  permissionRevision: 4, hits: [], nextCursor: null, recovered: false, ...over,
});

const CASES: Array<{ name: string; remote: RemoteSearchSnapshot; localRows?: number; localLoading?: boolean }> = [
  { name: "query-pending", remote: mk({ phase: "waiting-catalog" }), localLoading: true },
  { name: "local-only", remote: mk({ phase: "not-granted" }), localRows: 2 },
  {
    name: "mixed-local-desktop",
    remote: mk({ hits: hits.slice(0, 2), nextCursor: "c1" }),
    localRows: 1,
  },
  { name: "mixed-desktop-material-knowledge", remote: mk({ hits, nextCursor: "c2" }) },
  { name: "not-granted", remote: mk({ phase: "not-granted" }) },
  { name: "temporarily-unavailable", remote: mk({ phase: "temporarily-unavailable" }) },
  { name: "no-results", remote: mk({ hits: [] }) },
  { name: "desktop-next-page-loading", remote: mk({ hits: hits.slice(0, 1), nextCursor: "c2", phase: "loading-more" }) },
  { name: "recovered-410", remote: mk({ hits: hits.slice(0, 2), recovered: true }) },
  { name: "unpaired", remote: mk({ phase: "unpaired" }) },
  { name: "offline", remote: mk({ phase: "offline" }) },
  { name: "unsupported", remote: mk({ phase: "unsupported" }) },
];

function Section({ c }: { c: { name: string; remote: RemoteSearchSnapshot; localRows?: number; localLoading?: boolean } }) {
  const r = c.remote;
  return (
    <section className="case" data-name={c.name}>
      <h2>{c.name}</h2>
      <div className="st-view">
        <Header title="搜索" left={<IconButton icon="back" label="返回上一页" onClick={() => {}} />} />
        <div className="st-scroll">
          <SearchField value="海报" onChange={() => {}} placeholder="搜索手机和电脑上的内容" />
          {c.localLoading ? null : null}
          {c.localRows ? (
            <>
              <SectionTitle>本机笔记</SectionTitle>
              <Row title="本机笔记标题（较长的示例）" meta="本机笔记" onClick={() => {}} />
            </>
          ) : null}
          <DesktopResultsSection
            remote={r}
            localCount={c.localRows ?? 0}
            onOpenHit={() => {}}
            onLoadMore={() => {}}
          />
          {c.name === "no-results" ? <Empty title="没有找到相关内容" body="本机与电脑上都没有包含「海报」的内容。" /> : null}
        </div>
      </div>
    </section>
  );
}

function App() {
  const w = window.innerWidth;
  const density = w <= 360 ? "compact" : w >= 520 ? "wide" : "regular";
  return (
    <div className="st-app" data-mode="light" data-density={density}>
      {CASES.map((c) => <Section key={c.name} c={c} />)}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
