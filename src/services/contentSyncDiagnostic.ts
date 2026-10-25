import type { SyncSnapshot } from "./syncCoordinator";

// Only literals can reach the support UI; even a server's bounded code could
// contain private text. Do not display raw snapshot.error or substring matches.
const SAFE_CODES = new Set([
  "FORBIDDEN", "UNAUTHORIZED", "PAIRING_REQUIRED", "REVOKED", "AUTH_REVOKED",
  "GRANT_REQUIRED", "SCOPE_DENIED", "SERVICE_UNAVAILABLE", "VERSION_UNSUPPORTED",
  "OP_ID_REUSED", "RECEIPT_EXPIRED", "ENTITY_NOT_FOUND", "SOURCE_CHANGED",
  "PAYLOAD_TOO_LARGE", "RATE_LIMITED", "DESKTOP_DRAFT_BUSY", "INPUT_INVALID",
  "UPLOAD_OFFSET_MISMATCH", "UPLOAD_HASH_MISMATCH", "UPLOAD_INCOMPLETE",
  "JOB_NOT_OWNED", "METHOD_NOT_ALLOWED", "PRESENTATION_BUSY", "UNSUPPORTED_CAPABILITY",
  "REVISION_CONFLICT", "CURSOR_TOO_OLD", "RESYNC_REQUIRED", "NOTE_TOO_LARGE",
  "CONTENT_OFFLINE", "CONTENT_DISCONNECTED", "CONTENT_SOURCE_CHANGED",
  "CONTENT_UPGRADE_REQUIRED", "CONTENT_RESPONSE_INVALID", "CONTENT_RESPONSE_TOO_LARGE",
  "CONTENT_ACK_INVALID", "CONTENT_OPERATION_INVALID", "CONTENT_VAULT_UNAVAILABLE",
  "CONTENT_UNAVAILABLE", "CONTENT_ID_INVALID", "CONTENT_CANCELLED",
  "NOTE_INPUT_INVALID", "OP_ID_INVALID", "INVALID_QUERY", "VAULT_CHANGED",
  "gateway-request-invalid", "gateway-request-too-large",
]);

interface ContentSyncDiagnostic {
  status: string;
  errorCode: string | null;
  httpStatus: number | null;
  refusalCode?: string;
  operationKind?: string;
  routeKind?: string;
  preparedShape?: string;
  preparedExtra?: string;
  preparedRequired?: string;
  preparedTypes?: string;
  preparedBodyId?: string;
  preparedRouteId?: string;
  preparedTitle?: string;
  preparedChecks?: string;
  receiverHttps?: string;
  receiverPort?: string;
  receiverCatalog?: string;
}

/** A readonly display projection, never a sync/queue authority. */
export function contentSyncDiagnostic(snapshot: SyncSnapshot): ContentSyncDiagnostic {
  const status = { idle: "等待下一轮", syncing: "正在同步", offline: "暂时离线", error: "同步未完成" }[snapshot.status];
  if (snapshot.status === "idle" || snapshot.status === "syncing")
    return { status, errorCode: null as string | null, httpStatus: null as number | null };
  let raw = (snapshot.error || "").replace(/^Error: /, "");
  if (raw === "CONTENT_PAIRING_REVIEW_REQUIRED") return {status:"重新配对前的修改已保留 · 提交暂停",errorCode:raw,httpStatus:null};
  if (raw === "CONTENT_SYNC_REQUIRES_ATTENTION") return {status:"草稿已保存在手机 · 需处理",errorCode:raw,httpStatus:null};
  const receiver = /^(CONTENT_MUTATION_HTTP_[^\r\n]*) receiverV=1 https=(YES|NO|UNKNOWN) port=([1-9]\d{0,4}|UNKNOWN) catalog=(MATCH|MISMATCH|MISSING|NOT_OBSERVED)$/.exec(raw);
  const receiverFacts = receiver && (receiver[3] === "UNKNOWN" || Number(receiver[3]) <= 65535)
    ? { receiverHttps: receiver[2], receiverPort: receiver[3], receiverCatalog: receiver[4] } : {};
  if (receiver && "receiverHttps" in receiverFacts) raw = receiver[1];
  // V1 facts describe only the local immutable prepared value. Never infer
  // server acceptance from KNOWN_CHECKS_PASS, or accept arbitrary suffix text.
  const input = /^CONTENT_MUTATION_HTTP_400 \[NOTE_INPUT_INVALID\] kind=rename route=content inputV=1 shape=(OBJECT|NON_OBJECT) extra=(YES|NO|UNKNOWN) required=(PRESENT|MISSING|UNKNOWN) types=([MSNX]{8}|UNKNOWN) bodyId=(VALID|MISSING|NULL|TYPE_INVALID|IDENTIFIER_INVALID|PREFIX_INVALID|UNKNOWN) routeId=(VALID|INVALID|UNKNOWN) title=(VALID|MISSING|NULL|TYPE_INVALID|BLANK|DOT|SEPARATOR|COLON|NUL|RESERVED|OTHER_PATH_RULE|UNKNOWN) checks=(KNOWN_CHECKS_PASS|LOCAL_REJECT|UNKNOWN)$/.exec(raw);
  const knownPass = input && input[1] === "OBJECT" && input[2] === "NO" && input[3] === "PRESENT"
    && /^S[SMN]SS[SMN]{4}$/.test(input[4]) && input[5] === "VALID" && input[6] === "VALID" && input[7] === "VALID";
  if (input && (input[8] !== "KNOWN_CHECKS_PASS" || knownPass)) return { status, errorCode: "CONTENT_MUTATION_HTTP_400", httpStatus: 400,
    refusalCode: "NOTE_INPUT_INVALID", operationKind: "rename", routeKind: "content",
    preparedShape: input[1], preparedExtra: input[2], preparedRequired: input[3],
    preparedTypes: input[4], preparedBodyId: input[5], preparedRouteId: input[6],
    preparedTitle: input[7], preparedChecks: input[8], ...receiverFacts };
  const refusal = /^CONTENT_MUTATION_HTTP_([45]\d{2}) \[([^\r\n\]]*)\] kind=(create|update|rename|delete|UNKNOWN) route=(content|knowledgeCreateUnique)$/.exec(raw);
  if (refusal && (refusal[4] === "content" || refusal[3] === "create")) return { status, errorCode: `CONTENT_MUTATION_HTTP_${refusal[1]}`, httpStatus: Number(refusal[1]),
    refusalCode: SAFE_CODES.has(refusal[2]) ? refusal[2] : "UNKNOWN", operationKind: refusal[3], routeKind: refusal[4], ...receiverFacts };
  const mutation = /^CONTENT_MUTATION_HTTP_([45]\d{2})$/.exec(raw);
  if (mutation) return { status, errorCode: `CONTENT_MUTATION_HTTP_${mutation[1]}`, httpStatus: Number(mutation[1]), ...receiverFacts };
  const gateway = /^content http ([45]\d{2}) \[([^\r\n]*)\]$/.exec(raw);
  const code = gateway ? gateway[2] : raw;
  return { status, errorCode: SAFE_CODES.has(code) ? code : "UNKNOWN",
    httpStatus: gateway ? Number(gateway[1]) : null };
}
