// Human-readable failure copy (UI-REFRESH-R1).
//
// The product surface must never show a raw error string (Rust error enums,
// `fetch failed`, JSON blobs). This maps the known failure shapes to short
// Chinese sentences and falls back to a calm generic line. The original
// detail is still available to the developer/diagnostics section, which reads
// the error directly rather than through this helper.

const RULES: { test: RegExp; copy: string }[] = [
  { test: /REVISION_CONFLICT|409/i, copy: "这篇笔记在电脑上已更新，你的修改已保留。" },
  { test: /CURSOR_TOO_OLD|RESYNC_REQUIRED|410/i, copy: "连接状态已重置，正在重新同步。" },
  { test: /PAIRING_REQUIRED|REVOKED|401/i, copy: "电脑授权已失效，请重新连接。" },
  { test: /DISCONNECTED|ECONNREFUSED|fetch failed|network|Network/i, copy: "连不上电脑，请检查电脑与局域网。" },
  { test: /SOURCE_CHANGED|CANCELLED/i, copy: "连接已改变，请重新打开。" },
  { test: /UPGRADE|404/i, copy: "电脑版本暂不支持这项内容，请更新电脑端。" },
  { test: /RESOURCE_UNAVAILABLE|PREVIEW_UNAVAILABLE/i, copy: "文件暂时不可用，请在电脑上检查原文件。" },
  { test: /TOO_LARGE|64\s?MiB|64MB/i, copy: "附件太大，单个不能超过 64 MB。" },
  { test: /ENOSPC|no space/i, copy: "手机存储空间不足。" },
  { test: /timed?\s?out|timeout/i, copy: "操作超时，请重试。" },
];

/** Map an unknown failure to a short user-facing sentence. */
export function failureCopy(error: unknown, fallback = "操作没有完成，请重试。"): string {
  const raw = typeof error === "string" ? error : String((error as any)?.message ?? error ?? "");
  for (const rule of RULES) {
    if (rule.test.test(raw)) return rule.copy;
  }
  return fallback;
}

/** True when a failure is worth offering a retry for. */
export function failureIsRetryable(error: unknown): boolean {
  const raw = typeof error === "string" ? error : String((error as any)?.message ?? error ?? "");
  return /DISCONNECTED|ECONNREFUSED|fetch failed|network|timeout|timed?\s?out|REVISION_CONFLICT/i.test(raw);
}
