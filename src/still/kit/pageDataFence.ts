// Page-data request fence (A0 R1.2).
//
// Run-detail page data has TWO legitimate parallel channels — the run summary
// and the run events — plus an identity/capability layer that must invalidate
// everything when the Desktop identity changes or readiness is lost.
//
//   epoch        invalidates ALL page data (identity change, ready → offline/
//                probing/unavailable, unpair, capability loss)
//   runSeq       latest-wins for the run summary channel only
//   eventsSeq    latest-wins for the events channel only
//
// Two concurrent requests under the SAME identity must never cancel each
// other: a summary request only competes with a newer summary request, and an
// events refresh only supersedes an older events request.
export class PageDataFence {
  private epoch = 0;
  private runSeq = 0;
  private eventsSeq = 0;

  /** Invalidate every channel: identity change or capability/readiness loss. */
  bumpEpoch(): void {
    this.epoch += 1;
  }

  /** Capture the identity epoch for a set of commits. */
  current(): number {
    return this.epoch;
  }

  /** Start a run-summary request; returns its fence token. */
  beginRun(): { epoch: number; seq: number } {
    return { epoch: this.epoch, seq: ++this.runSeq };
  }

  /** Start an events request; returns its fence token. */
  beginEvents(): { epoch: number; seq: number } {
    return { epoch: this.epoch, seq: ++this.eventsSeq };
  }

  /** True when a run-summary commit is still allowed. */
  isRunCurrent(token: { epoch: number; seq: number }): boolean {
    return token.epoch === this.epoch && token.seq === this.runSeq;
  }

  /** True when an events commit is still allowed. */
  isEventsCurrent(token: { epoch: number; seq: number }): boolean {
    return token.epoch === this.epoch && token.seq === this.eventsSeq;
  }
}
