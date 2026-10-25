/** Only the known native diagnostic is displayed. Provider errors/paths stay private. */
export function localNoteUploadFailure(error: unknown): string {
  const message = String(error);
  const code = "LOCAL_NOTE_UPLOAD_RESOURCES_UNSUPPORTED";
  if (message.includes(code)) {
    const generic = "笔记含暂不支持转移的附件或本机链接，未提交上传，本机原件保留。";
    const start = message.indexOf(`${code}:`);
    if (start < 0) return generic;
    try {
      const detail = JSON.parse(message.slice(start + code.length + 1));
      if (!Number.isSafeInteger(detail?.line) || detail.line < 1 || detail.line > 4_194_304 || typeof detail.reference !== "string") return generic;
      const reference = [...detail.reference.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")].slice(0, 64).join("").trim();
      if (!reference) return generic;
      return `第 ${detail.line} 行的「${reference}」暂不支持随笔记转移。未提交上传，本机原件保留。`;
    } catch { return generic; }
  }
  if (/LOCAL_NOTE_UPLOAD_TOO_LARGE/.test(message)) return "笔记正文超过 4 MiB，暂不能上传。本机原件保留。";
  if (/TARGET|VAULT|OWNER/.test(message)) return "电脑或知识库已变化，请关闭后重新选择。";
  return "未能加入上传队列。请检查电脑连接与写入权限后重试；本机原件不受影响。";
}
