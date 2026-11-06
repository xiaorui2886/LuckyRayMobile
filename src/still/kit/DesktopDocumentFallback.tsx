import { useState } from "react";
import { fileFormat } from "./mediaTilePure";

/** A content thumbnail is not a full document reader. Absent previews still
 * identify the real file and retain the original, explicit open action. */
export function DesktopDocumentFallback({ cached, busy, disabled, message, onOpen, name = "", preview = "", local = false }: {
  cached: boolean; busy: boolean; disabled: boolean; message: string; onOpen: () => void;
  name?: string; preview?: string; local?: boolean;
}) {
  const [failedPreview, setFailedPreview] = useState("");
  const showPreview = Boolean(preview && failedPreview !== preview);
  return <div className="st-asset-area st-document-fallback">
    {showPreview ? <img className="st-document-cover" src={preview} alt={`${name} 内容缩略预览`} draggable={false} onError={() => setFailedPreview(preview)} /> : null}
    {name ? <div className="st-document-identity"><strong>{fileFormat(name, "other")}</strong><p>{name}</p></div> : null}
    <p>{showPreview ? "内容缩略预览，不代表完整正文" : "此文件暂不支持正文预览"}</p>
    <p>{local ? "原文件保存在本机，可使用其他应用打开。" : cached ? "原文件已保存到手机，可使用其他应用打开。" : "可按需获取原文件，再使用其他应用打开。"}</p>
    <button type="button" disabled={busy || disabled} onClick={onOpen}>
      {busy ? "正在获取原文件…" : local ? "打开原文件" : cached ? "打开已缓存文件" : "获取并打开原文件"}
    </button>
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
