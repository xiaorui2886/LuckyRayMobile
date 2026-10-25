/** Documents have no inline renderer. Never confuse absent preview with an empty file. */
export function DesktopDocumentFallback({ cached, busy, disabled, message, onOpen }: {
  cached: boolean; busy: boolean; disabled: boolean; message: string; onOpen: () => void;
}) {
  return <div className="st-asset-area st-document-fallback">
    <p>此文件暂不支持正文预览</p>
    <p>{cached ? "原文件已保存到手机，可使用其他应用打开。" : "可按需获取原文件，再使用其他应用打开。"}</p>
    <button type="button" disabled={busy || disabled} onClick={onOpen}>
      {busy ? "正在获取原文件…" : cached ? "打开已缓存文件" : "获取并打开原文件"}
    </button>
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
