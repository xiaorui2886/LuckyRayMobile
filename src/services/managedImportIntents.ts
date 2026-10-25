import { secureUuidV4 } from "./secureUuid.ts";

/** Bounded local intent, not authority to use a remote account or URI grant. */
export type ImportTarget = { localVaultId: string; folder: string; sessionGeneration: string };
type Intent = ImportTarget & { requestId: string; createdAt: number };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const KEY = "luckyray.managed-import-intents.v1", LIMIT = 32, TTL = 24 * 60 * 60 * 1000;
const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export class ManagedImportIntents {
  private storage: StorageLike;
  private now: () => number;
  constructor(storage: StorageLike, now: () => number = Date.now) { this.storage = storage; this.now = now; }
  private read(): Intent[] {
    try {
      const raw: unknown = JSON.parse(this.storage.getItem(KEY) || "[]");
      if (!Array.isArray(raw) || raw.length > LIMIT) return [];
      return raw.filter((item): item is Intent => !!item && validId(item.requestId) && typeof item.localVaultId === "string" && item.localVaultId.length > 0 && item.localVaultId.length <= 256 && typeof item.folder === "string" && item.folder.length <= 2048 && typeof item.sessionGeneration === "string" && item.sessionGeneration.length <= 128 && Number.isFinite(item.createdAt) && this.now() >= item.createdAt && this.now() - item.createdAt < TTL);
    } catch { return []; }
  }
  remember(requestId: string, target: ImportTarget) {
    if (!validId(requestId) || !target.localVaultId || typeof target.folder !== "string" || !target.sessionGeneration) throw Error("IMPORT_INTENT_INVALID");
    const items = this.read().filter(item => item.requestId !== requestId);
    if (items.length >= LIMIT) throw Error("IMPORT_INTENT_FULL");
    this.storage.setItem(KEY, JSON.stringify([...items, { ...target, requestId, createdAt: this.now() }]));
  }
  matching(requestId: string, current: ImportTarget | null): ImportTarget | null {
    const found = this.read().find(item => item.requestId === requestId);
    return found && current && found.localVaultId === current.localVaultId && found.sessionGeneration === current.sessionGeneration && found.folder === current.folder ? { localVaultId: found.localVaultId, folder: found.folder, sessionGeneration: found.sessionGeneration } : null;
  }
  forget(requestId: string) { this.storage.setItem(KEY, JSON.stringify(this.read().filter(item => item.requestId !== requestId))); }
}
let incarnation: string | null = null;
function importIncarnation(): string | null {
  if (incarnation) return incarnation;
  try { return incarnation = secureUuidV4(); }
  catch { return null; } // No secure owner: keep receipts for explicit recovery, never crash app startup.
}
let generation = 0, active: ImportTarget | null = null;
export function invalidateManagedImportTarget() { generation++; active = null; }
export function setManagedImportTarget(localVaultId: string, folder = "") {
  if (active?.localVaultId !== localVaultId || active?.folder !== folder) {
    generation++;
    const owner = localVaultId ? importIncarnation() : null;
    active = owner ? { localVaultId, folder, sessionGeneration: `${owner}:${generation}` } : null;
  }
}
export function snapshotManagedImportTarget(): ImportTarget | null { return active ? { ...active } : null; }
export function currentManagedImportTarget(target: ImportTarget): boolean { return active?.localVaultId === target.localVaultId && active.sessionGeneration === target.sessionGeneration && active.folder === target.folder; }
