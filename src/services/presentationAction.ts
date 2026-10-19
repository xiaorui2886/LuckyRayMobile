// SERVICES-ASSET-DETAIL-R1 — ordinary-product presentation action controller.
//
// Wraps the ACCEPTED PresentationClient with the ordinary detail page's
// currentness semantics:
//   - one explicit user action owns an immutable {opId, target};
//   - double-tap coalesces into the SAME operation (no second opId, no second
//     wire call while one is in flight);
//   - an uncertain transport failure keeps the SAME opId + target for the
//     user's retry (the opId is only retired when the outcome is terminal);
//   - page/route/owner change retires the handle: a late outcome for an old
//     detail can never mutate a newer one;
//   - truthful outcome copy (accepted / handoffStarted / denied / unavailable
//     / retired / offline), never claiming display beyond the canonical state.
//
// The controller owns NO networking of its own: it calls the accepted
// production PresentationClient over the accepted production transport.

import { PresentationClient, ServicesError } from "./companionServices/index.ts";
import type { PresentationTarget } from "../../shared/companion-services-v1/types.ts";
import type { PresentationOutcome } from "./companionServices/presentationClient.ts";
import { secureUuidV4 } from "./secureUuid.ts";

export type PresentPhase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; outcome: PresentationOutcome }
  | { kind: "failed"; text: string };

export type PresentContext = {
  /** The owning Desktop this detail page is bound to (route-fixed). */
  owner: string;
  /** The exact route assetId. */
  assetId: string;
  /** Fence: the detail generation this action belongs to. */
  generation: number;
};

export type PresentFeedback =
  | { tone: "pending"; text: string }
  | { tone: "ok"; text: string }
  | { tone: "warn"; text: string }
  | { tone: "error"; text: string };

/** Truthful bounded copy for a terminal outcome. Never over-claims display. */
export function outcomeFeedback(outcome: PresentationOutcome): PresentFeedback {
  switch (outcome.kind) {
    case "confirmed":
      // Canonical `accepted`/`displayed`; the copy mirrors the canonical state.
      return outcome.state === "displayed"
        ? { tone: "ok", text: "已在电脑上打开" }
        : { tone: "ok", text: "电脑已接受，正在打开" };
    case "handoffStarted":
      // Handoff began — display is NOT confirmed.
      return { tone: "warn", text: "已交给电脑处理，正在打开" };
    case "nonConfirmed":
      return { tone: "warn", text: "电脑已把操作排队，稍后打开" };
    case "refused":
      return { tone: "error", text: "电脑拒绝了这次打开请求" };
    case "retired":
      return { tone: "warn", text: "这次打开请求已失效，请重新操作" };
    case "unresolvedHandle":
      return { tone: "error", text: "找不到这次操作的原始目标，请重新操作" };
  }
}

/** Truthful bounded copy for a thrown failure (canonical code first). */
export function failureFeedback(error: unknown): PresentFeedback {
  if (error instanceof ServicesError) {
    switch (error.code) {
      case "GRANT_REQUIRED":
        return { tone: "error", text: "还没有“在电脑打开”权限：请在电脑端 LuckyRay 设置中开启后重试。" };
      case "SCOPE_DENIED":
        return { tone: "error", text: "这条素材不在当前授权范围内，电脑拒绝打开。" };
      case "PRESENTATION_BUSY":
        return { tone: "warn", text: "电脑正忙（有未处理的打开请求），稍后重试。" };
      case "SERVICE_UNAVAILABLE":
        return { tone: "error", text: "电脑暂时连不上，请检查连接后重试。" };
      case "PAIRING_REQUIRED":
        return { tone: "error", text: "配对已失效，请重新配对后再试。" };
      case "ENTITY_NOT_FOUND":
        return { tone: "error", text: "电脑上找不到这条素材。" };
      default:
        return { tone: "error", text: `打开失败（${error.code}）` };
    }
  }
  return { tone: "error", text: "打开失败，请稍后重试。" };
}

type Handlers = {
  getFeedback: (f: PresentFeedback) => void;
  isCurrent: (ctx: PresentContext) => boolean;
};

/**
 * One controller per detail page mount. `retire()` on route/owner/unmount
 * fences every in-flight outcome.
 */
export class PresentationActionController {
  private readonly client: PresentationClient;
  private readonly h: Handlers;
  private ctx: PresentContext | null = null;
  private opId: string | null = null;
  private target: PresentationTarget | null = null;
  private pending = false;
  private retired = false;

  constructor(client: PresentationClient, h: Handlers) {
    this.client = client;
    this.h = h;
  }

  /** Re-bind to a new page context; retires any previous action handle. */
  bind(ctx: PresentContext): void {
    this.retire();
    this.ctx = ctx;
    this.retired = false;
  }

  /** Route/owner/unmount fence: in-flight outcomes become no-ops. */
  retire(): void {
    this.retired = true;
    this.ctx = null;
    this.opId = null;
    this.target = null;
    this.pending = false;
  }

  /** True while an operation for the CURRENT context is unresolved. */
  inFlight(): boolean {
    return this.pending;
  }

  /**
   * The single user entry point. Coalesces double-taps; keeps the SAME
   * opId + target when a previous attempt failed with an UNCERTAIN transport
   * error (the outcome may still land); a terminal outcome clears the handle
   * so a later explicit action can start fresh.
   */
  async open(): Promise<void> {
    if (!this.ctx || this.retired || this.pending) return;
    const ctx = this.ctx;
    // Mint-once per user action: uncertain-failure retries reuse it.
    if (!this.opId || !this.target) {
      this.opId = secureUuidV4();
      this.target = { domain: "materials", assetId: ctx.assetId };
    }
    this.pending = true;
    this.h.getFeedback({ tone: "pending", text: "正在请求电脑打开…" });
    try {
      const outcome = await this.client.open(ctx.owner, this.opId, this.target);
      if (this.isStale(ctx)) return;
      this.pending = false;
      // Terminal outcome: the action handle is done; a NEW explicit action
      // (after re-bind or fresh intent) may mint a new opId.
      this.opId = null;
      this.target = null;
      this.h.getFeedback(outcomeFeedback(outcome));
    } catch (error) {
      if (this.isStale(ctx)) return;
      this.pending = false;
      const uncertain = this.isUncertain(error);
      if (!uncertain) {
        // Definitive refusal: the action identity is spent; a retry is a NEW
        // user action and may mint a fresh opId.
        this.opId = null;
        this.target = null;
      }
      // Uncertain (transport) failure: KEEP opId + target so the retry is the
      // SAME operation.
      this.h.getFeedback(failureFeedback(error));
    }
  }

  private isStale(ctx: PresentContext): boolean {
    return (
      this.retired ||
      this.ctx !== ctx ||
      this.h.isCurrent(ctx) === false
    );
  }

  private isUncertain(error: unknown): boolean {
    if (error instanceof ServicesError) {
      // Canonical refusals are DEFINITE answers; transport-level failures are
      // the uncertain ones (the op may still have landed).
      return ![
        "GRANT_REQUIRED", "SCOPE_DENIED", "PRESENTATION_BUSY", "PAIRING_REQUIRED",
        "ENTITY_NOT_FOUND", "OP_ID_REUSED", "INPUT_INVALID", "METHOD_NOT_ALLOWED",
      ].includes(error.code);
    }
    return true;
  }
}
