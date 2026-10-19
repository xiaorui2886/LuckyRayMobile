/** One mounted attachment's captured scope; native IPC remains the authority. */
export type NoteResourceScope = { instance: string; vault: string; note: string };
export type NoteResource = { resourceId: string; target: string; status: string; mimeType?: string; version?: string };
export type ResourceFile = { path: string; mime: string };
export type ResourceView = { file: ResourceFile | null; busy: boolean; message: string };
type ResourceEffects = {
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
    try {
      const file = await this.effects.contentCachedResource(instance, this.resource.resourceId, vault, note);
      if (!this.retired && gen === this.generation && !this.view.file) this.publish({ file });
    } catch { /* absent local cache is a normal state */ }
    if (!this.retired && gen === this.generation && this.resource.mimeType?.startsWith("image/") && this.resource.status === "resolved") {
      await this.download();
    }
  }
  async download(): Promise<void> {
    if (this.retired || !this.online || this.job || this.resource.status !== "resolved") return;
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
