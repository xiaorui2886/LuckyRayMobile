// Human-readable failure copy (UI-REFRESH-R1).
//
// The product surface must never show a raw error string (Rust error enums,
// `fetch failed`, JSON blobs). This maps the known failure shapes to short
// Chinese sentences and falls back to a calm generic line. The original
// detail is still available to the developer/diagnostics section, which reads
// the error directly rather than through this helper.

const RULES: { test: RegExp; copy: string }[] = [
  { test: /MANAGED_SYNC_BINDING_AMBIGUOUS/i, copy: "这个知识库的同步关联重复，暂时只能阅读。请在知识库管理中核对来源，修改尚未写入。" },
  { test: /VAULT_BINDING_INVALID/i, copy: "这个知识库的同步关联不完整，暂时只能阅读。请在知识库管理中检查关联，修改尚未写入。" },
  { test: /MANAGED_VAULT_UNAVAILABLE/i, copy: "所选知识库暂时不可用，请返回知识库列表检查。" },
  { test: /VAULT_REQUEST_CHANGED/i, copy: "上次创建笔记库的结果尚未确认，请先用原名称重试，避免重复创建。" },
  { test: /VAULT_REQUEST_INVALID/i, copy: "创建笔记库的请求无效，请重试。" },
  { test: /VAULT_NAME_INVALID/i, copy: "笔记库名称需为 1–120 个字符，不能包含换行或控制字符。" },
  { test: /LINKED_IMPORT_(?:CAPABILITY|CONNECTION)|IMPORT_PLAN_UNSUPPORTED/i, copy: "链接迁移需要连接支持此功能的电脑。原库仍可编辑，请连接或更新电脑端后重新检查。" },
  { test: /LINKED_IMPORT_LEGACY_PARTIAL/i, copy: "已有部分旧版加入记录，原始内容已保留，请先核对两份内容，不会自动重新复制。" },
  { test: /LINKED_IMPORT_(?:SOURCE|PROOFS|PLAN|MAPPING)_CHANGED/i, copy: "笔记或链接计划已变化，原始内容保留，请重新检查计划。" },
  { test: /LINKED_IMPORT_(?:RESOURCE|UNRESOLVED|AMBIGUOUS)|IMPORT_PATH_CONFLICT/i, copy: "部分链接、附件或目标路径还需核对，原始内容保留，不会猜测或覆盖。" },
  { test: /LINKED_IMPORT_/i, copy: "链接加入计划尚未完成，原始内容保留，请核对连接和笔记链接后重新检查。" },
  { test: /VAULT_MIGRATION_RECOVERY_CONFLICT/i, copy: "部分笔记已整理，但来源后来发生变化。两份内容均已保留，请先核对差异；不会自动覆盖。" },
  { test: /VAULT_(NOTE_TRANSFER_PENDING|TRANSFER_PENDING)/i, copy: "上次加入同步库尚未完成，原始内容仍保留，请回到笔记库继续处理。" },
  { test: /VAULT_(NOTE_TRANSFERRED|TRANSFER_ALREADY_ADOPTED_ELSEWHERE)/i, copy: "这篇笔记已加入同步库，请从目标库继续编辑。原始内容仍保留。" },
  { test: /VAULT_IMPORT_(SOURCE_CHANGED|TARGET_CHANGED|INVALID)/i, copy: "导入来源或目标已变化，原始内容已保留，请重新选择笔记库。" },
  { test: /VAULT_MOVE_WAIT_FOR_SYNC/i, copy: "这篇笔记还有待同步的修改，请同步完成后再移动。" },
  { test: /VAULT_(MIGRATION_SOURCE_CHANGED|TRANSFER_SOURCE_CHANGED|TRANSFER_TARGET_CHANGED|TRANSFER_PLAN_INVALID)/i, copy: "笔记或目标库已变化，请重新检查计划后再确认。" },
  { test: /VAULT_TRANSFER_PENDING_DIFFERENT_TARGET/i, copy: "上次加入同步库尚未完成，请选择原目标库继续恢复。" },
  { test: /VAULT_TRANSFER_(BODY_MISSING|RESOURCES_INCOMPLETE)/i, copy: "部分正文或附件尚不完整，原始内容已保留，请补齐后重试。" },
  { test: /VAULT_REVISION_CONFLICT/i, copy: "本地笔记已变化，你的修改已保留，请重新打开后处理。" },
  { test: /VAULT_FOLDER_EXISTS/i, copy: "此目录已存在，请换一个名称。" },
  { test: /VAULT_FOLDER_NOT_FOUND/i, copy: "目标目录已变化，请重新选择。" },
  { test: /VAULT_PATH_INVALID/i, copy: "这个名称不能用作目录，请换一个名称。" },
  { test: /CONTENT_PAIRING_REVIEW_REQUIRED/i, copy: "重新配对后保留的未同步笔记需要恢复处理，暂不会自动上传。" },
  { test: /LIBRARY_READ_ONLY/i, copy: "这个库目前只读，修改未提交。" },
  { test: /REVISION_CONFLICT|409/i, copy: "这篇笔记在电脑上已更新，你的修改已保留。" },
  { test: /CURSOR_TOO_OLD|RESYNC_REQUIRED|410/i, copy: "连接状态已重置，正在重新同步。" },
  { test: /PAIRING_REQUIRED|REVOKED|401/i, copy: "电脑授权已失效，请重新连接。" },
  { test: /DISCONNECTED|ECONNREFUSED|fetch failed|network|Network/i, copy: "连不上电脑，请检查电脑与局域网。" },
  { test: /SOURCE_CHANGED/i, copy: "当前笔记库来源已变化，请重新选择笔记库。" },
  { test: /UPGRADE|404/i, copy: "电脑版本暂不支持这项内容，请更新电脑端。" },
  { test: /RESOURCE_UNAVAILABLE|PREVIEW_UNAVAILABLE/i, copy: "文件暂时不可用，请在电脑上检查原文件。" },
  { test: /TOO_LARGE|64\s?MiB|64MB/i, copy: "附件太大，单个不能超过 64 MB。" },
  { test: /ENOSPC|no space/i, copy: "手机存储空间不足。" },
  { test: /timed?\s?out|timeout/i, copy: "操作超时，请重试。" },
];

/** Map an unknown failure to a short user-facing sentence. */
export function failureCopy(error: unknown, fallback = "操作没有完成，请重试。"): string {
  if (isExpectedRequestCancellation(error)) return "操作已取消。";
  const raw = typeof error === "string" ? error : `${(error as any)?.code ?? ""} ${String((error as any)?.message ?? error ?? "")}`;
  for (const rule of RULES) {
    if (rule.test.test(raw)) return rule.copy;
  }
  return fallback;
}

/** True when a failure is worth offering a retry for. */
export function failureIsRetryable(error: unknown): boolean {
  const raw = typeof error === "string" ? error : `${(error as any)?.code ?? ""} ${String((error as any)?.message ?? error ?? "")}`;
  return /DISCONNECTED|ECONNREFUSED|fetch failed|network|timeout|timed?\s?out|REVISION_CONFLICT/i.test(raw);
}

/** For request owners only: suppress an obsolete request, not a real source failure.
 * A caller must also ensure the request belongs to an aborted/stale view lifecycle.
 */
export function isExpectedRequestCancellation(error: unknown): boolean {
  const value = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const raw = typeof error === "string" ? error : `${value?.code ?? ""} ${value?.message ?? ""}`;
  if (/SOURCE_CHANGED/i.test(raw)) return false;
  return value?.name === "AbortError" || /(?:^|[^A-Z0-9_])(?:[A-Z0-9]+_)*CANCELLED(?:$|[^A-Z0-9_])/i.test(raw);
}
