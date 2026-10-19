// Explicit user intent only. Native owns the durable operation/source/editor
// CAS. This caller owns the UI epoch and never publishes a stale receipt.
export type PausedDraft = { operationPaused?: boolean; pausedOperationId?: string; titleNeedsCorrection?: boolean; dirty?: boolean; deleted?: boolean; conflictDocument?: unknown; editorEpoch?: number; draftGeneration?: number };
export type RecoveryScope = { instance: string; vault: string; id: string };
export function openNoteDeletion(note: PausedDraft | null, open: (sheet: "state" | "delete") => void): void {
  open(note?.operationPaused ? "state" : "delete");
}
export function pausedRecoveryError(error: unknown): string {
  const code = String(error).replace(/^Error: /, "");
  if (code === "CONTENT_OPERATION_PENDING") return "旧重命名请求的同步结果尚未确认，笔记未删除，草稿和原请求已保留。请在来源与状态中查看同步结果，处理暂停后再删除；不会自动建立新请求。";
  if (code === "CONTENT_OPERATION_PAUSED") return "笔记未删除，草稿和原请求已保留。请先在来源与状态中处理同步暂停，再删除。";
  if (code === "CONTENT_TITLE_REQUIRED") return "标题和正文已保存在手机，请填写有效标题后再建立新请求。";
  if (code === "CONTENT_ATTACHMENTS_PENDING") return "草稿已保留，请等待附件发布完成后再建立新请求。";
  if (code === "CONTENT_EDITOR_CHANGED" || code === "CONTENT_OPERATION_CHANGED") return "草稿或待发请求已改变，请重新查看来源与状态后再操作。";
  if (code === "CONTENT_SOURCE_CHANGED" || code === "CONTENT_DISCONNECTED") return "连接已改变，草稿和原请求已保留，请重新打开此笔记。";
  return "尚未确认恢复结果，请重新查看此笔记的来源与状态；不会自动重复建立请求。";
}
export async function resumePausedDraft(
  scope: RecoveryScope, draft: PausedDraft | null,
  effects: { isCurrent: () => boolean; resume: (input: RecoveryScope & { pausedOpId: string; epoch: number; generation: number }) => Promise<unknown>; publish: (value: any) => void },
): Promise<boolean> {
  if (!effects.isCurrent() || !draft || !draft.operationPaused || !draft.dirty || draft.deleted
    || draft.conflictDocument || draft.titleNeedsCorrection || !draft.pausedOperationId
    || !Number.isSafeInteger(draft.editorEpoch) || (draft.editorEpoch ?? 0) <= 0
    || !Number.isSafeInteger(draft.draftGeneration) || (draft.draftGeneration ?? -1) < 0) return false;
  const value = await effects.resume({ ...scope, pausedOpId: draft.pausedOperationId!, epoch: draft.editorEpoch!, generation: draft.draftGeneration! });
  if (!effects.isCurrent()) return false;
  effects.publish(value);
  return true;
}
