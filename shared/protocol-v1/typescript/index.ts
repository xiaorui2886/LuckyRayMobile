// LuckyRay Mobile Protocol V1 — TypeScript contract (frozen).
// Mirror of the repository-relative shared/protocol-v1 directory.
// This file is the mobile-app copy; shared/ is authoritative.

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Device / Identity
// ---------------------------------------------------------------------------

export interface DesktopIdentity {
  instanceId: string;
  displayName: string;
  platform: "windows" | "macos" | "linux";
  appVersion: string;
  protocolVersion: number;
  certificateFingerprint: string; // SHA-256 hex of the gateway TLS cert
}

export interface PairRequest {
  secret: string;
  fingerprint: string;
}

export interface PairResponse {
  deviceId: string;
  credential: string;
  protocolVersion: number;
}

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------
// Business identity is (desktop_instance_id, desktop_asset_id).
// content_hash is NEVER a business primary key.

export type AssetKind = "image" | "video" | "document" | "text" | "audio" | "other";

export interface AssetSummary {
  desktopAssetId: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string; // ISO 8601
  contentHash?: string;
  thumbnailRevision?: string;
  folderId?: string;
  tags: string[];
}

export interface AssetPage {
  items: AssetSummary[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Note
// ---------------------------------------------------------------------------

export interface NoteSummary {
  noteId: string;
  title: string;
  relativePath?: string;
  updatedAt: string;
  revision: string;
}

export interface NoteDocument extends NoteSummary {
  content: string;
}

export interface NoteUpdateRequest {
  expectedRevision: string;
  content: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Recovery errors
// ---------------------------------------------------------------------------
// `code` in a Protocol V1 error body is the canonical wire value. The two
// legacy values below are receive-only compatibility aliases for the M2 mock
// gateway / early fixtures; new gateways must emit the canonical values.

export const PROTOCOL_ERROR_CODES = {
  PAIRING_REQUIRED: "PAIRING_REQUIRED",
  AUTH_REVOKED: "AUTH_REVOKED",
  CURSOR_TOO_OLD: "CURSOR_TOO_OLD",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  DESKTOP_INSTANCE_CHANGED: "DESKTOP_INSTANCE_CHANGED",
} as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[keyof typeof PROTOCOL_ERROR_CODES];

export const LEGACY_PROTOCOL_ERROR_ALIASES = {
  NOTE_REVISION_CONFLICT: PROTOCOL_ERROR_CODES.REVISION_CONFLICT,
  RESYNC_REQUIRED: PROTOCOL_ERROR_CODES.CURSOR_TOO_OLD,
} as const satisfies Record<string, ProtocolErrorCode>;

/** Convert a known legacy receive-only value to the canonical wire code. */
export function canonicalProtocolErrorCode(value: unknown): ProtocolErrorCode | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  const canonical = Object.values(PROTOCOL_ERROR_CODES).find((candidate) => candidate === code);
  if (canonical) return canonical;
  return LEGACY_PROTOCOL_ERROR_ALIASES[code as keyof typeof LEGACY_PROTOCOL_ERROR_ALIASES];
}

/** Error strings cross the Tauri boundary, so match the two accepted values. */
export function isRevisionConflictError(value: unknown): boolean {
  const message = String(value ?? "");
  return (
    message.includes(PROTOCOL_ERROR_CODES.REVISION_CONFLICT) ||
    message.includes("NOTE_REVISION_CONFLICT")
  );
}

// Kept as a named export for existing callers.
export const ERROR_REVISION_CONFLICT = PROTOCOL_ERROR_CODES.REVISION_CONFLICT;

// ---------------------------------------------------------------------------
// Capture (offline-first outbox)
// ---------------------------------------------------------------------------

export type CaptureKind = "text" | "link" | "image" | "file";

export interface CaptureAttachmentRef {
  refId: string;
  kind: "image" | "file";
  fileName: string;
  sizeBytes: number;
  sha256?: string;
}

export interface CaptureOperation {
  opId: string; // UUID — idempotency key
  type: CaptureKind;
  createdAt: string;
  payload: Record<string, unknown>;
  attachmentRefs: CaptureAttachmentRef[];
  state: "pending" | "inflight" | "completed" | "failed";
  attemptCount: number;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Sync (durable changelog)
// ---------------------------------------------------------------------------

export type SyncEntityType = "asset" | "note" | "tag" | "folder" | "agent_run" | "capture";
export type SyncOperation = "upsert" | "delete";

export interface SyncChange {
  seq: number;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  revision?: string;
  updatedAt: string;
}

export interface SyncPage {
  changes: SyncChange[];
  after: number; // cursor of last item in this page
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Agent Remote (V1 frozen capabilities only)
// ---------------------------------------------------------------------------

export type AiRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopping";

export interface AiRun {
  runId: string;
  conversationId: string;
  status: AiRunStatus;
  startedAt: string;
  updatedAt: string;
  summary?: string;
}

export interface AiTurnEvent {
  seq: number;
  type: string; // e.g. "agent.progress", "tool.started"
  payload: Record<string, unknown>;
  at: string;
}

// ---------------------------------------------------------------------------
// Realtime (WS — hint only, not authoritative)
// ---------------------------------------------------------------------------

export interface WsEventEnvelope {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface WsStatus {
  state: "connecting" | "connected" | "disconnected" | "reconnecting" | "stopped";
  lastSeq: number;
}
