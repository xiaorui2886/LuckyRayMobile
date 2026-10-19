// MATERIAL-LIBRARY-INSTANT-R1 — VISUAL QA ONLY (never shipped).
// Renders the REAL product Library frame (.st-app + production still.css +
// the real MediaTile / CollectionView composition) across the card-required
// states at 360px/392px with synthetic data.
import React from "react";
import { createRoot } from "react-dom/client";
import { CollectionView, SettingsView } from "../../src/presentation/still01/Views";
import "../../src/presentation/still01/still.css";

type Tile = { id: string; title: string; src: string; kind: "image" | "video" | "document"; source: "local" | "desktop"; meta: string };

const longName = "一张非常长的素材标题——深色主题海报最终交付版本-包含完整图层与色彩管理信息-来自桌面同步.png";
const local: Tile[] = [
  { id: "local:a1", title: "本机照片.png", src: "", kind: "image", source: "local", meta: "图片 · 本机" },
  { id: "local:b2", title: "本机视频.mp4", src: "", kind: "video", source: "local", meta: "视频 · 本机" },
  { id: "local:c3", title: longName, src: "", kind: "image", source: "local", meta: "图片 · 本机" },
];
const desktopLoaded: Tile[] = [
  { id: "d1", title: "download.jpeg", src: "", kind: "image", source: "desktop", meta: "图片 · 电脑缓存" },
  { id: "d2", title: "100-cancel-fixture.txt", src: "", kind: "document", source: "desktop", meta: "文档 · 电脑缓存" },
  { id: "d3", title: longName, src: "", kind: "image", source: "desktop", meta: "图片 · 电脑缓存" },
];
// R7: a wider synthetic page so drag-select over many tiles is visible.
const desktopMany: Tile[] = [
  { id: "m1", title: "海报-A.png", src: "", kind: "image", source: "desktop", meta: "图片 · 电脑缓存" },
  { id: "m2", title: "海报-B.png", src: "", kind: "image", source: "desktop", meta: "图片 · 电脑缓存" },
  { id: "m3", title: "视频-C.mp4", src: "", kind: "video", source: "desktop", meta: "视频 · 电脑缓存" },
  { id: "m4", title: "文档-D.txt", src: "", kind: "document", source: "desktop", meta: "文档 · 电脑缓存" },
  { id: "m5", title: "图-E.jpg", src: "", kind: "image", source: "desktop", meta: "图片 · 电脑缓存" },
  { id: "m6", title: "图-F.jpg", src: "", kind: "image", source: "desktop", meta: "图片 · 电脑缓存" },
];

type QaCase = {
  name: string;
  source: "local" | "desktop";
  assets: Tile[];
  filterLabel: string;
  list?: boolean;
  connected?: boolean;
  note?: string;
  /** REPAIR-R5: multi-select state, entered by long press. */
  selecting?: boolean;
  selectedIds?: string[];
  onLongPress?: boolean;
  /** REPAIR-R6: the fixed selection action bar, as the page passes it. */
  selectionBar?: { count: number; busy?: boolean; onCancel: () => void; onOrganize: () => void };
  /** R7 五: the cold-loading skeleton (no retained rows). */
  coldLoading?: boolean;
  /** R7 五: retained rows + refreshing keeps the sync copy, never a skeleton. */
  retained?: boolean;
  refreshing?: boolean;
};

const CASES: QaCase[] = [
  { name: "local-loaded", source: "local", assets: local, filterLabel: "3 项" },
  { name: "desktop-loaded", source: "desktop", assets: desktopLoaded, filterLabel: "全部素材", connected: true, note: "电脑缓存 · 已加载" },
  { name: "instant-local-to-desktop-retained", source: "desktop", assets: desktopLoaded, filterLabel: "全部素材", connected: true, note: "同帧保留（无空白帧）" },
  { name: "instant-desktop-to-local-retained", source: "local", assets: local, filterLabel: "3 项", note: "同帧保留（无空白帧）" },
  { name: "desktop-refreshing-rows-visible", source: "desktop", assets: desktopLoaded, filterLabel: "全部素材", connected: true, retained: true, refreshing: true, note: "后台刷新中 · 行仍可见" },
  { name: "initial-loading-no-rows", source: "local", assets: [], filterLabel: "加载中" },
  { name: "settled-empty", source: "local", assets: [], filterLabel: "0 项" },
  { name: "offline-cached", source: "desktop", assets: desktopLoaded, filterLabel: "全部素材", connected: false, note: "已缓存内容（离线）" },
  { name: "mixed-thumb-state", source: "local", assets: local, filterLabel: "3 项", list: true },
  // REPAIR-R5: the permanent 选择素材 button is gone; these prove the
  // long-press selection state renders correctly in BOTH layouts, and that the
  // toolbar has no select control at either width.
  // REPAIR-R6: the selection cases now also pass the FIXED action bar the page
  // renders between the search field and the scroll region.
  { name: "selection-grid", source: "desktop", assets: desktopLoaded, filterLabel: "全部素材", connected: true, selecting: true, selectedIds: ["d1", "d3"], onLongPress: true, selectionBar: { count: 2, onCancel: () => {}, onOrganize: () => {} }, note: "长按进入多选（网格）· 固定操作栏" },
  { name: "selection-list", source: "desktop", assets: desktopLoaded, filterLabel: "全部素材", connected: true, list: true, selecting: true, selectedIds: ["d2"], onLongPress: true, selectionBar: { count: 1, busy: false, onCancel: () => {}, onOrganize: () => {} }, note: "长按进入多选（列表）· 固定操作栏" },
  { name: "selection-busy-empty", source: "desktop", assets: desktopLoaded, filterLabel: "全部素材", connected: true, selecting: true, selectedIds: [], onLongPress: true, selectionBar: { count: 0, busy: true, onCancel: () => {}, onOrganize: () => {} }, note: "0 项 + busy：整理所选应禁用" },
  // R7 (B1): a held long press dragged across several tiles — the swept tiles
  // join the selection, nothing opens.
  { name: "drag-select-grid", source: "desktop", assets: desktopMany, filterLabel: "全部素材", connected: true, selecting: true, selectedIds: ["m1", "m2", "m3", "m4"], onLongPress: true, selectionBar: { count: 4, onCancel: () => {}, onOrganize: () => {} }, note: "长按后拖动连续多选（网格）" },
  // R7 五: the cold-loading skeleton in both layouts, plus the retained
  // refresh copy that must NOT become a skeleton.
  { name: "cold-loading-skeleton-grid", source: "desktop", assets: [], filterLabel: "全部素材", connected: true, coldLoading: true, note: "冷加载骨架（网格）" },
  { name: "cold-loading-skeleton-list", source: "desktop", assets: [], filterLabel: "全部素材", connected: true, coldLoading: true, list: true, note: "冷加载骨架（列表）" },
];

function Frame({ c }: { c: QaCase }) {
  return (
    <section className="case" data-name={c.name}>
      <h2>{c.name}</h2>
      <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
        <CollectionView
          domain="library"
          source={c.source}
          onSource={() => {}}
          query=""
          onQuery={() => {}}
          onFilter={() => {}}
          onNew={() => {}}
          onBrowse={() => {}}
          onRefresh={() => {}}
          notes={[]}
          assets={c.assets}
          open={() => {}}
          paired={true}
          connected={c.connected ?? false}
          list={Boolean(c.list)}
          onList={() => {}}
          filterLabel={c.filterLabel}
          selecting={c.selecting}
          selectedIds={c.selectedIds}
          onLongPress={c.onLongPress ? () => {} : undefined}
          onDragSelect={() => {}}
          selectionBar={c.selectionBar}
          coldLoading={c.coldLoading}
          retained={c.retained}
          refreshing={c.refreshing}
        />
        {c.note ? <div className="st-source-row st-source-quiet" style={{ padding: "8px 23px" }}>{c.note}</div> : null}
      </div>
    </section>
  );
}

function MyPage() {
  return (
    <section className="case" data-name="my-page">
      <h2>my-page</h2>
      <div className="st-app" data-mode="light" data-density={window.innerWidth <= 360 ? "compact" : "regular"}>
        <SettingsView open={() => {}} connected={false} mode="light" />
      </div>
    </section>
  );
}

function App() {
  return <div>{CASES.map((c) => <Frame key={c.name} c={c} />)}<MyPage /></div>;
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
