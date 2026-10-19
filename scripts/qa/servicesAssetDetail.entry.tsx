// SERVICES-ASSET-DETAIL-R1 REPAIR-R2 — VISUAL QA ONLY (never shipped).
//
// Renders the REAL product component `ServicesSourceSection` (the exact one
// StillAsset uses) inside the REAL product frame — `.st-app` token scope,
// real production `Header` with its Back control, the caption and the
// bottom `.st-asset-actions` row — through React + the REAL production
// still.css, across every card-required state, with SYNTHETIC URLs only.

import React from "react";
import { createRoot } from "react-dom/client";
import { Header, IconButton, Button } from "../../src/still/kit/StillImports";
import { ServicesSourceSection } from "../../src/still/kit/servicesSourceSection";
import type { SourceBlockState } from "../../src/services/sourceBlock";
import type { PresentFeedback } from "../../src/services/presentationAction";
import "../../src/presentation/still01/still.css";

const LONG_URL =
  "https://design.example.com/works/%E6%B5%B7%E6%8A%A5%E8%AE%BE%E8%AE%A1-%E6%9C%80%E7%BB%88%E7%A8%BF?utm_source=client&id=8842&slide=12#%E8%AF%84%E8%AE%BA%E5%8C%BA";

type Case = {
  name: string;
  block: SourceBlockState;
  loading?: boolean;
  errorCode?: string;
  present: PresentFeedback | null;
  pending?: boolean;
  failed?: boolean; // show the retry affordance
};

const CASES: Case[] = [
  {
    name: "work-page-long-url",
    block: {
      kind: "page", label: "原作品页面", pageUrl: LONG_URL,
      siteOrigin: "https://design.example.com", captureKind: "web",
    },
    present: { tone: "ok", text: "电脑已接受，正在打开" },
  },
  {
    name: "capture-page",
    block: {
      kind: "page", label: "采集页面", pageUrl: "https://news.example.com/articles/5566?ref=app#img",
      siteOrigin: "https://news.example.com", captureKind: "web",
    },
    present: { tone: "warn", text: "已交给电脑处理，正在打开" },
  },
  {
    name: "generic-source",
    block: {
      kind: "page", label: "来源页面", pageUrl: "https://shop.example.net/item/9?q=%E6%B5%B7%E6%8A%A5",
      siteOrigin: "https://shop.example.net", captureKind: "unknown",
    },
    present: { tone: "error", text: "电脑拒绝了这次打开请求" },
  },
  {
    name: "no-source-import",
    block: { kind: "no-source", captureKind: "import" },
    present: { tone: "ok", text: "电脑已接受，正在打开" },
  },
  { name: "loading", block: { kind: "loading" }, loading: true, present: { tone: "pending", text: "正在请求电脑打开…" }, pending: true },
  {
    name: "grant-required-retry",
    block: { kind: "none" }, errorCode: "GRANT_REQUIRED", failed: true,
    present: { tone: "error", text: "还没有“在电脑打开”权限：请在电脑端 LuckyRay 设置中开启后重试。" },
  },
  {
    name: "offline-retry",
    block: { kind: "none" }, errorCode: "SERVICE_UNAVAILABLE", failed: true,
    present: { tone: "error", text: "电脑暂时连不上，请检查连接后重试。" },
  },
  {
    name: "presentation-pending",
    block: {
      kind: "page", label: "原作品页面", pageUrl: LONG_URL,
      siteOrigin: "https://design.example.com", captureKind: "web",
    },
    present: { tone: "pending", text: "正在请求电脑打开…" }, pending: true,
  },
  {
    name: "handoff-started",
    block: {
      kind: "page", label: "原作品页面", pageUrl: "https://design.example.com/works/77#top",
      siteOrigin: "https://design.example.com", captureKind: "web",
    },
    present: { tone: "warn", text: "已交给电脑处理，正在打开" },
  },
  {
    name: "refused",
    block: {
      kind: "page", label: "来源页面", pageUrl: "https://example.org/px?q=1",
      captureKind: "web",
    },
    present: { tone: "error", text: "电脑拒绝了这次打开请求" },
  },
];

function Frame({ c }: { c: Case }) {
  return (
    <section className="case" data-name={c.name}>
      <h2>{c.name}</h2>
      <div className="st-asset-view" style={{ position: "relative" }}>
        <Header title="电脑素材" left={<IconButton icon="back" label="返回素材库" onClick={() => {}} />}
          right={<IconButton icon="more" label="素材更多操作" onClick={() => {}} />} />
        <div className="st-asset-caption">
          <strong>一张很长的素材标题——深色主题海报最终交付版本-包含完整图层与色彩管理信息-来自桌面同步.png</strong>
          <small>图片 · 12.4 MB · 已缓存</small>
        </div>
        <ServicesSourceSection
          block={c.block}
          loading={Boolean(c.loading)}
          errorCode={c.errorCode}
          present={c.present}
          pendingPresent={Boolean(c.pending)}
          copyState="idle"
          onRetrySource={() => {}}
          onOpenBrowser={() => {}}
          onCopy={() => {}}
          onOpenDesktop={() => {}}
        />
        {/* the real bottom/action area of the desktop detail page */}
        <div className="st-asset-actions">
          <IconButton icon="share" label="素材更多操作" onClick={() => {}} />
          <IconButton icon="heart" label="收藏素材" onClick={() => {}} />
          <IconButton icon="info" label="素材信息" onClick={() => {}} />
        </div>
      </div>
    </section>
  );
}

function App() {
  // REPAIR-R4 R4-A: density derives from the REAL rendered viewport width
  // (window.innerWidth at render time — the shooter supplies no query), using
  // the EXACT production StillShell formula.
  const w = window.innerWidth;
  const density = w <= 360 ? "compact" : w >= 520 ? "wide" : "regular";
  return (
    <div className="st-app" data-mode="light" data-density={density}>
      {CASES.map((c) => <Frame key={`${c.name}@${w}`} c={c} />)}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
