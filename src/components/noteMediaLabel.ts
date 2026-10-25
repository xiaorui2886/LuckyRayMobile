/** Display only. Never use this decoded label as a resource URL or identity. */
export function noteMediaLabel(target: unknown): string {
  const raw = typeof target === "string" ? target : "";
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* Preserve malformed input as text. */ }
  return decoded.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim() || "附件";
}
