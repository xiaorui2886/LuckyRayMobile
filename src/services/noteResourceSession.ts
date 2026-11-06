/** One mounted attachment's captured scope; native IPC remains the authority. */
export type NoteResourceScope = { instance: string; vault: string; note: string; localVaultId?: string; revision?: string };
export type NoteResource = { resourceId: string; target: string; status: string; mimeType?: string; version?: string; localAttachmentId?: string; localOnly?: boolean; displayName?: string };
export type ResourceFile = { path: string; mime: string };
export type ResourceView = { file: ResourceFile | null; busy: boolean; message: string };
type ResourceEffects = {
  managedVaultResourceGet?(localVaultId: string, noteId: string, target: string, expectedRevision: string): Promise<ResourceFile>;
  contentNoteLocalAttachment?(instance: string, vault: string, note: string, op: string): Promise<ResourceFile>;
  contentCachedResource(instance: string, id: string, vault: string, note: string): Promise<ResourceFile>;
  contentNoteResource(instance: string, vault: string, note: string, id: string, job: string): Promise<ResourceFile>;
  contentCancel(job: string): Promise<void>;
};

export class NoteResourceSession {
  private scope: NoteResourceScope;
  private resource: NoteResource;
  private effects: ResourceEffects;
  private observe: (view: ResourceView) => void;
  private view: ResourceView = { file: null, busy: false, message: "" };
  private generation = 0;
  private retired = false;
  private job = "";
  private online: boolean;

  constructor(scope: NoteResourceScope, resource: NoteResource, effects: ResourceEffects, observe: (view: ResourceView) => void, online = true) {
    this.scope = { ...scope }; this.resource = { ...resource };
    this.effects = effects; this.observe = observe;
    this.online = online;
  }
  private publish(update: Partial<ResourceView>): void {
    this.view = { ...this.view, ...update }; this.observe(this.view);
  }
  async start(): Promise<void> {
    // An explicit collision is not an offline miss. The old target/id may
    // already have cached bytes from the other syntax; never display them.
    if (this.resource.status === "ambiguous") {
      if (!this.retired) this.publish({ file: null, busy: false, message: "附件引用不明确，请先在电脑上核对引用目标。" });
      return;
    }
    const gen = this.generation;
    const { instance, vault, note } = this.scope;
    if (this.scope.localVaultId) {
      this.publish({ busy: true, message: "" });
      try {
        if (!this.effects.managedVaultResourceGet || !this.scope.revision) throw Error("MANAGED_RESOURCE_SCOPE_REQUIRED");
        const file = await this.effects.managedVaultResourceGet(this.scope.localVaultId, note, this.resource.target, this.scope.revision);
        if (!this.retired && gen === this.generation) this.publish({ file, busy: false });
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        const message = code === "VAULT_RESOURCE_MISSING" || code === "CONTENT_NOT_CACHED"
          ? "附件尚未保存到本地。"
          : code === "VAULT_RESOURCE_HASH_MISMATCH"
          ? "本地附件校验未通过，无法打开。"
          : code === "VAULT_REVISION_CONFLICT"
          ? "笔记版本已更新，请重新打开笔记后查看附件。"
          : code === "VAULT_RESOURCE_UNVERIFIED"
          ? "附件与当前笔记版本尚未完成核对。"
          : "读取本地附件失败，原始内容未改变。";
        if (!this.retired && gen === this.generation) this.publish({ file: null, busy: false, message });
      }
      return; // Managed files never fall through to Desktop cache or network.
    }
    try {
      const file = await this.effects.contentCachedResource(instance, this.resource.resourceId, vault, note);
      if (!this.retired && gen === this.generation && !this.view.file) this.publish({ file });
    } catch { /* absent local cache is a normal state */ }
    if (!this.retired && gen === this.generation && !this.view.file && this.resource.localAttachmentId && this.effects.contentNoteLocalAttachment) {
      try {
        const file = await this.effects.contentNoteLocalAttachment(instance, vault, note, this.resource.localAttachmentId);
        if (!this.retired && gen === this.generation && !this.view.file) this.publish({ file });
      } catch { /* Original phone copy may have been removed; retain remote fallback. */ }
    }
    if (!this.retired && gen === this.generation && this.resource.mimeType?.startsWith("image/") && this.resource.status === "resolved") {
      await this.download();
    }
  }
  async download(): Promise<void> {
    if (this.scope.localVaultId) { if (!this.retired && !this.view.busy) await this.start(); return; }
    if (this.retired || !this.online || this.job || this.resource.localOnly || this.resource.status !== "resolved") return;
    const gen = ++this.generation;
    const job = `media-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.job = job; this.publish({ busy: true, message: "" });
    const { instance, vault, note } = this.scope;
    try {
      const file = await this.effects.contentNoteResource(instance, vault, note, this.resource.resourceId, job);
      if (!this.retired && gen === this.generation) this.publish({ file });
    } catch {
      if (!this.retired && gen === this.generation) this.publish({ message: "未能获取附件，已缓存的内容仍可查看。" });
    } finally {
      if (!this.retired && gen === this.generation) { this.job = ""; this.publish({ busy: false }); }
    }
  }
  setOnline(online: boolean): void {
    if (this.retired || this.online === online) return;
    this.online = online;
    if (!online) { this.cancel(); if (!this.view.file) void this.start(); }
    else void this.start();
  }
  cancel(): void {
    const job = this.job;
    ++this.generation; this.job = "";
    if (job) void this.effects.contentCancel(job).catch(() => {});
    if (!this.retired) this.publish({ busy: false });
  }
  retire(): void {
    if (this.retired) return;
    this.retired = true; ++this.generation; this.cancel();
  }
}
