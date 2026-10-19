/** Only durable receipts wake native sync; raw input cancels the quiet timer. */
export class DurablePublishDebounce {
  private generation = 0;
  private retiredThrough = 0;
  private highestCommitted = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maximum: ReturnType<typeof setTimeout> | null = null;
  private committedWaiting = false;
  private publish: () => void;
  constructor(publish: () => void) { this.publish = publish; }
  begin(): number {
    this.cancel();
    return ++this.generation;
  }
  committed(generation: number): void {
    if (generation <= this.retiredThrough || generation > this.generation || generation <= this.highestCommitted) return;
    this.highestCommitted = generation;
    this.committedWaiting = true;
    if (this.maximum === null) this.maximum = setTimeout(() => {
      this.maximum = null;
      // A preceding committed draft is durable even if the newest keystroke
      // has not saved yet. Publishing only wakes the serialized native path.
      if (this.committedWaiting) { this.committedWaiting = false; this.cancel(); this.publish(); }
    }, 2000);
    // A late durable receipt still starts the maximum, but only the newest
    // input's save may start the quiet timer or certify its UI state.
    if (generation !== this.generation) return;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation === this.generation) {
        this.committedWaiting = false;
        if (this.maximum) clearTimeout(this.maximum);
        this.maximum = null; this.publish();
      }
    }, 400);
  }
  dispose(): void {
    this.retiredThrough = this.begin();
    this.highestCommitted = this.retiredThrough;
    if (this.maximum !== null) clearTimeout(this.maximum);
    this.maximum = null;
    this.committedWaiting = false;
  }
  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
