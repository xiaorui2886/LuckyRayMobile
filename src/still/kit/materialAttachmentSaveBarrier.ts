/** Serialize only saves that arrive while a material attachment is committing. */
export class MaterialAttachmentSaveBarrier {
  private active: Promise<void> | null = null;
  pending(): Promise<void> | null { return this.active; }
  begin(): () => void {
    if (this.active) throw Error("CONTENT_ATTACHMENT_BUSY");
    let resolve!: () => void;
    const gate = new Promise<void>(done => { resolve = done; });
    this.active = gate;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.active === gate) this.active = null;
      resolve();
    };
  }
}
