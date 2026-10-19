// Capture.tsx (STITCH-R6) — 快速收集.
//
// Visual source: R6 `function capture()` — back header → text/link mode tabs →
// compose box + 保存到收集箱 → media actions (图片 / 拍照 / 文件) → the
// embedded Inbox list under a section title.
//
// Behaviour source: production, unchanged. The old screen mixed two interaction
// models in one grid: 文本/链接 selected an input type while 图片/拍照/文件
// executed immediately, all rendered as the same card. That distinction stays:
//  - a compact mode switch chooses the TEXT input type (文本 / 链接);
//  - a separate media action row handles 图片 / 拍照 / 文件, which really are
//    immediate actions.
//
// Every path still saves into the Mobile-owned Local Inbox first, paired or
// not. The capture-outbox backend stays preserved and undisplayed here.
import { useState } from "react";
import { api } from "../services/client";
import { IconCamera, IconFile, IconImage, IconLink, IconSearch } from "../components/icons";
import { syncCoordinator } from "../services/syncCoordinator";
import { localDataStore } from "../services/localDataStore";
import { failureCopy } from "../services/feedback";
import { toast } from "../services/toast";
import { BackHeader, SearchField, SectionTitle } from "../components/ui";
import Inbox from "./Inbox";

type Props = {
  go: (tab: any, detail?: string) => void;
  inboxTick?: number;
  /** Pushed child surface: Back returns to the initiating root. */
  onBack?: () => void;
  initialText?: string;
};

type ComposeKind = "text" | "link";

export default function Capture({ go, inboxTick, onBack, initialText = "" }: Props) {
  const [kind, setKind] = useState<ComposeKind>("text");
  const [text, setText] = useState(initialText);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [inboxReload, setInboxReload] = useState(0);
  const [query, setQuery] = useState("");

  /** Image / Photo / File — always into the Local Inbox (no pairing needed). */
  async function media(m: "image" | "photo" | "file") {
    setBusy(true);
    try {
      const r = await api.localInboxAddMedia(m);
      if (r?.cancelled) {
        toast.info("已取消");
      } else {
        toast.success(`已保存到手机 · ${r.fileName ?? m}`);
        setInboxReload((k) => k + 1);
        localDataStore.publish("inbox");
      }
      await syncCoordinator.refreshOutboxStatus();
    } catch (e: any) {
      toast.error(failureCopy(e, "收集失败，请重试。"));
    } finally {
      setBusy(false);
    }
  }

  /** Text / Link — always into the Local Inbox (no pairing needed). */
  async function add() {
    const value = kind === "text" ? text.trim() : link.trim();
    if (!value) {
      toast.warn(kind === "text" ? "先输入内容" : "先粘贴链接");
      return;
    }
    setBusy(true);
    try {
      await api.localInboxAdd(kind, text, link);
      toast.success("已保存到手机");
      setText("");
      setLink("");
      setInboxReload((k) => k + 1);
      localDataStore.publish("inbox");
      await syncCoordinator.refreshOutboxStatus();
    } catch (e: any) {
      toast.error(failureCopy(e, "保存失败，请重试。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <BackHeader
        title="收集"
        onBack={() => onBack?.()}
        right={
          <button className="nav-action" aria-label="本地搜索" onClick={() => go("search")}>
            <IconSearch size={18} />
          </button>
        }
      />

      <div className="capture-area">
        <div className="mode-tabs" role="tablist" aria-label="收集类型">
          <button
            role="tab"
            aria-selected={kind === "text"}
            className={"mode-tab" + (kind === "text" ? " active" : "")}
            onClick={() => setKind("text")}
          >
            文本
          </button>
          <button
            role="tab"
            aria-selected={kind === "link"}
            className={"mode-tab" + (kind === "link" ? " active" : "")}
            onClick={() => setKind("link")}
          >
            链接
          </button>
        </div>

        <div className="compose-box">
          {kind === "text" ? (
            <textarea
              className="compose-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="记下一条想法…"
            />
          ) : (
            <input
              className="text-field"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="粘贴链接…"
              inputMode="url"
            />
          )}
          <button className="primary btn-block" style={{ marginTop: 11 }} disabled={busy} onClick={add}>
            保存到收集箱
          </button>
        </div>

        <SectionTitle
          title="从设备添加"
          action={
            <button className="section-action" onClick={() => go("inbox")}>
              查看收集箱
            </button>
          }
        />

        {/* Media are immediate actions, never a second "input type". */}
        <div className="media-actions">
          <button className="media-action" disabled={busy} onClick={() => media("image")}>
            <IconImage size={18} />
            <span>图片</span>
          </button>
          <button className="media-action" disabled={busy} onClick={() => media("photo")}>
            <IconCamera size={18} />
            <span>拍照</span>
          </button>
          <button className="media-action" disabled={busy} onClick={() => media("file")}>
            <IconFile size={18} />
            <span>文件</span>
          </button>
        </div>
      </div>

      {/* The embedded Inbox surface flows naturally after the collect form
          (INTERACTION-CLOSURE-R1: no artificial fold spacer). */}
      <div>
        <SectionTitle title="收集箱" meta={<span className="subline"><IconLink size={12} /> 本机</span>} />

        <div className="tool-row">
          <SearchField value={query} onChange={setQuery} placeholder="在收集箱里搜索…" />
        </div>

        <Inbox
          go={go}
          tick={inboxTick}
          refreshKey={inboxReload}
          search={query}
          onChanged={() => syncCoordinator.refreshOutboxStatus()}
          onOpenNote={(noteId) => go("knowledge", noteId)}
          onOpenAsset={(assetId) => go("library", `local:${assetId}`)}
        />
      </div>
    </>
  );
}
