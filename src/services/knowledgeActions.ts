export type CacheLibrary = { instanceId: string; vaultId: string; name: string; cachedCount: number; clearableCount: number; protectedCount: number; paused: boolean };
export type ImportReceipt = { requestId: string; status: "imported" | "error" | "cancelled"; noteId?: string; title?: string; error?: string; source: "picker" | "view" };
export type UploadTarget = { instanceId: string; vaultId: string; name: string; writeGranted: boolean; directories: string[] };
/** Synchronous lock and incarnation fence: cancellation/ABA never revive an old receipt. */
export class KnowledgeActionGate {
  private epoch = 0;
  private locked = false;
  private scope = "";
  update(scope: string) { if (scope !== this.scope) { this.scope = scope; this.cancel(); } }
  cancel() { this.epoch++; this.locked = false; }
  start(): number | null { if (this.locked) return null; this.locked = true; return this.epoch; }
  current(token: number) { return token === this.epoch; }
  finish(token: number) { if (this.current(token)) this.locked = false; }
}

/** Native diagnostics are never user-facing text (and may contain provider detail). */
export function noteImportFailure(error: unknown): string {
  const messages: Record<string, string> = {
    NOTE_IMPORT_EXTENSION_UNSUPPORTED: "仅支持 .md、.markdown 和 .txt 文件。",
    NOTE_IMPORT_ENCODING_UNSUPPORTED: "文件编码不支持，请另存为 UTF-8 文本后重试。",
    NOTE_IMPORT_TOO_LARGE: "文件超过 4 MiB，请选择较小的文件。",
    NOTE_IMPORT_PERMISSION_DENIED: "没有读取权限，请重新选择文件并允许读取。",
    NOTE_IMPORT_QUEUE_FULL: "待导入文件较多，请稍后再试。",
    NOTE_IMPORT_READ_TIMEOUT: "读取文件超时，请检查文件是否已下载到手机后重试。",
    NOTE_IMPORT_UNREADABLE: "文件无法读取，请先在文件应用中下载后重新选择。",
    NOTE_IMPORT_PICKER_UNAVAILABLE: "无法打开文件选择器，请稍后重试。",
    NOTE_IMPORT_PICKER_BUSY: "文件选择器已打开，请先完成当前选择。",
  };
  return typeof error === "string" && Object.prototype.hasOwnProperty.call(messages, error) ? messages[error] : "文件无法读取，请重新选择。";
}
