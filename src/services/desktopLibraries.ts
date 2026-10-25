/** Saved-library discovery and user choice. No grants or desktop UI state are changed here. */
export type LibraryKind = "materials" | "knowledge";
export type SavedLibrary = { libraryId?: string; vaultId?: string; displayName: string; activeInDesktop: boolean; available: boolean; readGranted: boolean; writeGranted: boolean; ingestGranted: boolean };
export type DesktopLibraryCatalog = { scopeSelectionVersion: number; materials: SavedLibrary[]; knowledge: SavedLibrary[] };
export type LibrarySelection = { instance: string; phase: "idle" | "loading" | "ready" | "legacy" | "error"; catalog: DesktopLibraryCatalog | null; material: string; vault: string; epoch: number; materialsEpoch: number; knowledgeEpoch: number; error?: string };
export const libraryIdOf = (kind: LibraryKind, row: SavedLibrary): string => (kind === "materials" ? row.libraryId : row.vaultId) || "";
export class DesktopLibraries {
  private invalidator: ((instance: string, kind: LibraryKind) => Promise<void>) | null = null;
  setInvalidator(fn: (instance: string, kind: LibraryKind) => Promise<void>) { this.invalidator = fn; }
  private states = new Map<string, LibrarySelection>();
  private listeners = new Set<() => void>();
  private connections = new Map<string, boolean>();
  observeConnection(instance: string, connected: boolean): void {
    if (!instance) return;
    const previous = this.connections.get(instance);
    this.connections.set(instance, connected);
    if (previous === true && !connected) this.cancelPending(instance);
  }
  private bump(state: LibrarySelection, kind: LibraryKind): LibrarySelection {
    const field = kind === "materials" ? "materialsEpoch" : "knowledgeEpoch";
    return {...state, epoch:state.epoch+1, [field]:state[field]+1};
  }
  private pendingRefresh = new Map<string, Promise<void>>();
  private mutations = new Map<string, Promise<unknown>>();
  private choices = new Map<string, number>();
  private generations = new Map<string, number>();
  private serial<T>(instance: string, action: () => Promise<T>): Promise<T> {
    const next = (this.mutations.get(instance) || Promise.resolve()).catch(() => {}).then(action);
    this.mutations.set(instance, next);
    void next.finally(() => { if (this.mutations.get(instance) === next) this.mutations.delete(instance); }).catch(() => {});
    return next;
  }
  /** Retire pending work when the paired connection changes, not on a view unmount. */
  cancelPending(instance: string): void {
    this.generations.set(instance, (this.generations.get(instance) || 0) + 1);
    this.tokens.set(instance, (this.tokens.get(instance) || 0) + 1);
    this.pendingRefresh.delete(instance);
    this.put({...this.snapshot(instance), phase:"idle"});
  }
  async switchTo(instance: string, kind: LibraryKind, id: string, current: () => boolean = () => true): Promise<boolean> {
    const choiceKey = JSON.stringify([instance, kind]);
    const choice = (this.choices.get(choiceKey) || 0) + 1;
    this.choices.set(choiceKey, choice);
    const generation = this.generations.get(instance) || 0;
    const live = () => current() && this.choices.get(choiceKey) === choice && (this.generations.get(instance) || 0) === generation;
    // The visible catalog may be cached while opening the directory refreshes it.
    // Await its result BEFORE retiring native work; never invalidate then reject loading.
    let refresh: Promise<void> | undefined;
    while ((refresh = this.pendingRefresh.get(instance))) { await refresh; if (!live()) return false; }
    return this.serial(instance, async () => {
      if (!live()) return false;
      const old = this.snapshot(instance);
      this.validateSelection(old, kind, id);
      const key = kind === "materials" ? "material" : "vault";
      if (old[key] === id) return true;
      if (!this.invalidator) throw Error("LIBRARY_INVALIDATOR_UNAVAILABLE");
      try { await this.invalidator(instance, kind); }
      catch (error) {
        // Some invalidators can fail after retiring work. Restart the exact old scope.
        if ((this.generations.get(instance) || 0) === generation) this.put(this.bump(this.snapshot(instance),kind));
        throw error;
      }
      const latest = this.snapshot(instance);
      if (!live()) {
        if ((this.generations.get(instance) || 0) === generation) this.put(this.bump(latest,kind));
        return false;
      }
      // Catalog commits share this queue, so no permission facts changed during invalidation.
      this.put({...this.bump(latest,kind), [key]:id});
      return true;
    });
  }
  private validateSelection(state: LibrarySelection, kind: LibraryKind, id: string): void {
    const row = state.catalog?.[kind].find(row=>libraryIdOf(kind,row)===id);
    if (state.phase !== "ready") throw Error(state.error || "LIBRARY_CATALOG_NOT_READY");
    if (row?.available !== true) throw Error("LIBRARY_NOT_AVAILABLE");
    if (row.readGranted !== true) throw Error("LIBRARY_READ_NOT_GRANTED");
  }
  private tokens = new Map<string, number>();
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot(instance: string): LibrarySelection {
    let value = this.states.get(instance);
    if (!value) { value = {instance, phase:"idle", catalog:null, material:"", vault:"", epoch:0, materialsEpoch:0, knowledgeEpoch:0}; this.states.set(instance,value); }
    return value;
  }
  private put(value: LibrarySelection) { this.states.set(value.instance, value); for (const fn of this.listeners) fn(); }
  refresh(instance: string, read: (instance: string) => Promise<DesktopLibraryCatalog>): Promise<void> {
    const task = this.refreshNow(instance, read);
    this.pendingRefresh.set(instance, task);
    void task.finally(() => { if (this.pendingRefresh.get(instance) === task) this.pendingRefresh.delete(instance); });
    return task;
  }
  private async refreshNow(instance: string, read: (instance: string) => Promise<DesktopLibraryCatalog>) {
    if (!instance) return;
    const token = (this.tokens.get(instance) || 0) + 1; this.tokens.set(instance, token);
    this.put({...this.snapshot(instance), phase:"loading",error:undefined});
    try {
      const catalog = await read(instance);
      if (this.tokens.get(instance) !== token) return;
      await this.serial(instance, async () => {
      if (this.tokens.get(instance) !== token) return;
      const old = this.snapshot(instance);
      const retired = new Set<LibraryKind>();
      let committed = false;
      const retire = async (kind: LibraryKind) => { if (this.invalidator) { retired.add(kind); await this.invalidator(instance,kind); } };
      try {
      if (catalog.scopeSelectionVersion !== 1 && catalog.scopeSelectionVersion !== 0) throw Error("LIBRARY_CATALOG_VERSION_UNSUPPORTED");
      if (catalog.scopeSelectionVersion === 0) {
        if (old.material || old.vault) {
          if (this.invalidator) { if (old.material) await retire("materials"); if (old.vault) await retire("knowledge"); }
          if (this.tokens.get(instance)!==token) return;
          // Capability withdrawal is not permission to silently retarget a chosen library.
          this.put({...old,phase:"legacy",catalog,epoch:old.epoch+1,materialsEpoch:old.materialsEpoch+1,knowledgeEpoch:old.knowledgeEpoch+1});
        } else this.put({...old,phase:"legacy",catalog,material:"",vault:"",epoch:old.epoch+1,materialsEpoch:old.materialsEpoch+1,knowledgeEpoch:old.knowledgeEpoch+1});
        committed = true;
        return;
      }
      for (const kind of ["materials","knowledge"] as const) {
        if (!Array.isArray(catalog[kind]) || catalog[kind].some(row => !libraryIdOf(kind,row) || typeof row.displayName !== "string")) throw Error("LIBRARY_CATALOG_INVALID");
        if (new Set(catalog[kind].map(row=>libraryIdOf(kind,row))).size !== catalog[kind].length) throw Error("LIBRARY_CATALOG_INVALID");
      }
      // A removed selection is retained as a missing target, never changed to the active library.
      const material = old.material || catalog.materials.find(row=>row.activeInDesktop)?.libraryId || "";
      const vault = old.vault || catalog.knowledge.find(row=>row.activeInDesktop)?.vaultId || "";
      const facts = (cat: DesktopLibraryCatalog | null, kind: LibraryKind, id: string) => {
        const row = cat?.[kind].find(row=>libraryIdOf(kind,row)===id);
        return JSON.stringify(row ? [row.available,row.readGranted,row.writeGranted,row.ingestGranted] : null);
      };
      if (old.catalog?.scopeSelectionVersion === 1 && this.invalidator) {
        for (const [kind,id] of [["materials",material],["knowledge",vault]] as const) {
          if (id && facts(old.catalog,kind,id)!==facts(catalog,kind,id)) await retire(kind);
        }
        if (this.tokens.get(instance)!==token || this.snapshot(instance).material!==old.material || this.snapshot(instance).vault!==old.vault) return;
      }
      const materialChanged = material!==old.material || facts(old.catalog,"materials",material)!==facts(catalog,"materials",material);
      const knowledgeChanged = vault!==old.vault || facts(old.catalog,"knowledge",vault)!==facts(catalog,"knowledge",vault);
      const changed = material!==old.material || vault!==old.vault || facts(old.catalog,"materials",material)!==facts(catalog,"materials",material) || facts(old.catalog,"knowledge",vault)!==facts(catalog,"knowledge",vault);
      this.put({...old,phase:"ready",catalog,material,vault,epoch:old.epoch+(changed?1:0),materialsEpoch:old.materialsEpoch+(materialChanged?1:0),knowledgeEpoch:old.knowledgeEpoch+(knowledgeChanged?1:0)});
      committed = true;
      } finally {
        // A refresh superseded during native retirement still cancelled reads.
        // Reissue only the same selected scopes; never strand their spinners.
        if (!committed) for (const kind of retired) this.put(this.bump(this.snapshot(instance),kind));
      }
      });
    } catch (error) {
      if (this.tokens.get(instance) === token) this.put({...this.snapshot(instance),phase:"error",error:librarySelectionError(error)});
    }
  }
  select(instance: string, kind: LibraryKind, id: string): void {
    const old = this.snapshot(instance);
    this.validateSelection(old, kind, id);
    const key = kind === "materials" ? "material" : "vault";
    if (old[key] !== id) this.put({...this.bump(old,kind),[key]:id});
  }
}
export const desktopLibraries = new DesktopLibraries();

export function selectedLibraryReadable(state: LibrarySelection, kind: LibraryKind): boolean {
  if (state.catalog?.scopeSelectionVersion !== 1) return state.phase === "legacy" && !(kind === "materials" ? state.material : state.vault);
  const id = kind === "materials" ? state.material : state.vault;
  const row = state.catalog[kind].find(row=>libraryIdOf(kind,row)===id);
  return row?.available === true && row.readGranted === true;
}

/** Stable user-facing diagnostics, never raw transport URLs, paths or credentials. */
export function librarySelectionError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (["尚未获得此库的读取授权，请在电脑端检查授权后重试。", "连接已变化，请重新打开目录后重试。", "所选库当前不可用，请在电脑端检查后重试。", "库列表协议不兼容，请检查电脑端版本后重试。", "无法连接电脑，请检查连接后重试。"].includes(code)) return code;
  if (/401|403|GRANT|FORBIDDEN|UNAUTHORIZED/.test(code)) return "尚未获得此库的读取授权，请在电脑端检查授权后重试。";
  if (/SOURCE_CHANGED|CANCELLED/.test(code)) return "连接已变化，请重新打开目录后重试。";
  if (/NOT_AVAILABLE|SCOPE_UNAVAILABLE|404/.test(code)) return "所选库当前不可用，请在电脑端检查后重试。";
  if (/UPGRADE|VERSION|INVALID|UNSUPPORTED/.test(code)) return "库列表协议不兼容，请检查电脑端版本后重试。";
  if (/NETWORK|TIMEOUT|OFFLINE|CONNECT|fetch|offline/i.test(code)) return "无法连接电脑，请检查连接后重试。";
  return "读取或切换库失败，请重试；当前选择未改变。";
}
