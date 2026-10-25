/** One mounted attachment's captured scope; native IPC remains the authority. */
export type NoteResourceScope = { instance: string; vault: string; note: string; localVaultId?: string; revision?: string };
export type NoteResource = { resourceId: string; target: string; status: string; mimeType?: string; version?: string; localAttachmentId?: string; localOnly?: boolean };
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
    const gen = this.generation;
    const { instance, vault, note } = this.scope;
    if (this.scope.localVaultId) {
      this.publish({ busy: true, message: "" });
      try {
        if (!this.effects.managedVaultResourceGet || !this.scope.revision) throw Error("MANAGED_RESOURCE_SCOPE_REQUIRED");
        const file = await this.effects.managedVaultResourceGet(this.scope.localVaultId, note, this.resource.target, this.scope.revision);
        if (!this.retired && gen === this.generation) this.publish({ file, busy: false });
      } catch {
        if (!this.retired && gen === this.generation) this.publish({ file: null, busy: false, message: "附件尚未完整保存到本地，或校验未通过。原始内容未改变。" });
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
