// Dismissible-overlay registry (STITCH-R6-PARITY-FIX-R1).
//
// Android BACK must close the topmost sheet/dialog before it navigates away.
// Screens push a dismisser while a modal layer is open and pop it on close;
// the App shell's back handler asks this registry first.
//
// Critical invariant: `dismissTop()` must POP the topmost dismisser so that
// rapid back taps or asynchronous unmount batches cannot get trapped calling
// the same already-consumed dismisser forever.
export class OverlayStack {
  private stack: (() => void)[] = [];

  push(dismiss: () => void): () => void {
    this.stack.push(dismiss);
    return () => {
      const index = this.stack.lastIndexOf(dismiss);
      if (index >= 0) this.stack.splice(index, 1);
    };
  }

  /**
   * Dismiss the topmost overlay. Pops the dismisser so it can never be
   * re-triggered or linger in the stack to swallow future Back presses.
   * Returns true when one was consumed.
   */
  dismissTop(): boolean {
    const top = this.stack.pop();
    if (!top) return false;
    try {
      top();
    } catch {
      /* ignore exceptions in consumer dismiss handlers */
    }
    return true;
  }

  depth(): number {
    return this.stack.length;
  }

  clear(): void {
    this.stack = [];
  }
}

export const overlayStack = new OverlayStack();
