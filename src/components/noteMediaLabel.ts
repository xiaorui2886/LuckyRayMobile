/** Display only. Never use this decoded label as a resource URL or identity. */
export function noteMediaLabel(target: unknown): string {
  const raw = typeof target === "string" ? target : "";
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* Preserve malformed input as text. */ }
  return decoded.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim() || "附件";
}

/** An owned pending target is an opaque lookup ID, not a useful filename.
 * The persisted picker name is display-only; never change its transport key.
 * Published/remote targets retain the existing actual-path basename policy. */
export function noteResourceLabel(resource: { target: string; localOnly?: boolean; localAttachmentId?: string; displayName?: string }): string {
  const ownedPending = resource.localOnly && resource.localAttachmentId
    && resource.target === `luckyray-attachment:${resource.localAttachmentId}`;
  return noteMediaLabel(ownedPending && resource.displayName ? resource.displayName : resource.target);
}
