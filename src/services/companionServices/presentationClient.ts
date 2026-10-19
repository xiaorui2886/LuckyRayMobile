// PresentationClient (Issue #77 §3.8 / §3.9-gate) — .3 handoff semantics.
//
// `PresentationOpen.opId` is IMMUTABLE for one user action.
//
// Receipt states are reported truthfully and never overclaimed:
//   accepted / displayed : display outcome confirmed (per canonical semantics)
//   handoffStarted       : Desktop handoff BEGAN; display is NOT confirmed
//   queued               : preserved as non-confirmed
//   refused              : refused
//
// Critical guarantees:
//  - `handoffStarted` is NEVER mapped to "已在电脑打开" (or any confirmed-open copy);
//  - after `handoffStarted` there is NO automatic retry and NO automatic new opId;
//  - a same-op replay returns the same one-time receipt and must not cause a
//    second navigation (the Desktop owns that; the client simply replays the op);
//  - a 410 for an explicitly rejected/retired op is TERMINAL: no new opId is
//    minted and no retry is attempted. A future attempt is a NEW explicit user
//    action, which happens outside this client.

import { callServices, ServicesError, type ServicesTransport } from "./transport.ts";
import type { PresentationReceipt, PresentationTarget } from "../../../shared/companion-services-v1/types.ts";

/** Display outcome as the USER should understand it — never inflated. */
export type PresentationOutcome =
  | { kind: "confirmed"; state: "accepted" | "displayed"; opId: string }
  | { kind: "handoffStarted"; opId: string }
  | { kind: "nonConfirmed"; state: "queued"; opId: string }
  | { kind: "refused"; opId: string; reason?: string }
  | { kind: "retired"; opId: string }
  /** A replay with no recoverable immutable target; never fabricated. */
  | { kind: "unresolvedHandle"; opId: string };

/** Copy for a receipt state. `handoffStarted` deliberately does NOT claim display. */
export function presentationCopy(outcome: PresentationOutcome): string {
  switch (outcome.kind) {
    case "confirmed":
      return outcome.state === "displayed" ? "已在电脑打开" : "电脑已接受，正在打开";
    case "handoffStarted":
      return "已交给电脑处理，正在打开";
    case "nonConfirmed":
      return "已排队，等待电脑处理";
    case "refused":
      return "电脑拒绝了这次打开请求";
    case "retired":
      return "这次打开请求已失效";
    case "unresolvedHandle":
      return "这次打开请求缺少原始目标，无法重试";
  }
}

export class PresentationClient {
  private transport: ServicesTransport;
  private receipts = new Map<string, PresentationReceipt>();
  /** Ops that reached a terminal state; they are never auto-retried. */
  private terminal = new Set<string>();
  /**
   * The immutable target/payload each opId was opened with.
   *
   * Canonical .3 requires same opId + SAME target/payload for a replay. This
   * map is what makes that possible; without it a replay would have to invent a
   * target, which is never legal (it could yield OP_ID_REUSED or an
   * entity/input failure). A caller that persists the operation handle can also
   * pass it back in explicitly, which is how a cold client replays.
   */
  private handles = new Map<string, PresentationTarget>();

  constructor(transport: ServicesTransport) {
    this.transport = transport;
  }

  /** The immutable opId association for one user action. */
  receiptFor(opId: string): PresentationReceipt | null {
    return this.receipts.get(opId) ?? null;
  }
  isTerminal(opId: string): boolean {
    return this.terminal.has(opId);
  }
  /** The immutable target this opId was opened with, if known. */
  handleFor(opId: string): PresentationTarget | null {
    return this.handles.get(opId) ?? null;
  }

  /**
   * Open `target` under the caller-supplied immutable `opId`.
   *
   * The caller persists the opId for the user action; this method never mints
   * one, never rotates it on retry, and never retries by itself.
   */
  async open(
    instance: string,
    opId: string,
    target: PresentationTarget,
  ): Promise<PresentationOutcome> {
    if (this.terminal.has(opId)) {
      // A retired/refused op is terminal: no silent re-attempt, no new opId.
      return { kind: "retired", opId };
    }
    // The handle is recorded BEFORE the wire call so an in-flight op already
    // owns its immutable target.
    this.handles.set(opId, target);
    try {
      const receipt = await callServices<PresentationReceipt>(this.transport, {
        instance,
        operationId: "presentation.open",
        method: "POST",
        path: "/v1/services/presentation/open",
        body: { opId, target },
      });
      this.receipts.set(opId, receipt);
      if (receipt.state === "refused") this.terminal.add(opId);
      return this.toOutcome(receipt);
    } catch (error) {
      if (error instanceof ServicesError && error.status === 410) {
        // Explicitly rejected/retired: terminal. Never mint a replacement opId.
        this.terminal.add(opId);
        return { kind: "retired", opId };
      }
      throw error;
    }
  }

  /**
   * Replay a receipt for the SAME op (e.g. after a reconnect, or from a NEW
   * client instance over the same Desktop state).
   *
   * The original immutable target is REQUIRED: it either comes from this
   * client's own handle map or is supplied by the caller (who persisted the
   * operation handle). A replay with no recoverable target is refused — this
   * method never fabricates one and never rotates the opId.
   */
  async replay(
    instance: string,
    opId: string,
    target?: PresentationTarget,
  ): Promise<PresentationOutcome | { kind: "unresolvedHandle"; opId: string }> {
    const cached = this.receipts.get(opId);
    if (cached) return this.toOutcome(cached);
    if (this.terminal.has(opId)) return { kind: "retired", opId };
    const handle = target ?? this.handles.get(opId);
    if (!handle) {
      // No immutable handle anywhere: refuse rather than invent a target.
      return { kind: "unresolvedHandle", opId };
    }
    return this.open(instance, opId, handle);
  }

  /**
   * The persistable operation handle for one user action.
   *
   * A caller that must survive a process restart stores this `{opId, target}`
   * pair; feeding it back to `replay` (or `open`) is then a legal same-op
   * replay with the ORIGINAL payload.
   */
  handle(opId: string): { opId: string; target: PresentationTarget } | null {
    const target = this.handles.get(opId);
    return target ? { opId, target } : null;
  }

  private toOutcome(receipt: PresentationReceipt): PresentationOutcome {
    switch (receipt.state) {
      case "accepted":
      case "displayed":
        return { kind: "confirmed", state: receipt.state, opId: receipt.opId };
      case "handoffStarted":
        return { kind: "handoffStarted", opId: receipt.opId };
      case "queued":
        return { kind: "nonConfirmed", state: "queued", opId: receipt.opId };
      case "refused":
        return { kind: "refused", opId: receipt.opId, reason: receipt.reason };
    }
  }
}
