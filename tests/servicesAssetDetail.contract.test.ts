// SERVICES-ASSET-DETAIL-R1 — ordinary desktop-asset detail: Services V1
// source enrichment + "在电脑打开" contracts (Issue #80).
//
// Content V1 stays the PRIMARY detail authority; Services V1 is additive
// (source fidelity + presentation). These tests pin the seams the card names:
// source copy semantics, byte-exact URL carrying, production UUID/copy
// fallbacks, presentation op identity/currentness, and the product's
// independence from the acceptance-only tooling.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { carrySafeSource, preservesWorkPageUrl } from "../src/services/companionServices/safeSource.ts";
import {
  sourceBlockOf, canonicalPageUrl, captureKindText,
} from "../src/services/sourceBlock.ts";
import {
  secureUuidV4, formatSecureUuidV4, isSecureUuidV4, SecureUuidUnavailableError,
} from "../src/services/secureUuid.ts";
import { copyTextExact } from "../src/services/clipboardText.ts";
import {
  PresentationActionController, outcomeFeedback, failureFeedback,
} from "../src/services/presentationAction.ts";
import { ServicesError } from "../src/services/companionServices/transport.ts";
import type { MaterialDetail } from "../shared/companion-services-v1/types.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

function detailWith(source: MaterialDetail["source"]): MaterialDetail {
  return {
    assetId: "asset-1", name: "n", kind: "document", mimeType: "text/plain",
    sizeBytes: 1, revision: "r1", ...(source ? { source } : {}),
  } as MaterialDetail;
}

// 1+2. Content V1 primary / enrichment targets the exact owner+asset.
test("detail — Content V1 stays primary; Services enrichment is additive on the SAME asset", () => {
  const src = strip(read("src", "still", "StillAsset.tsx"));
  // The primary Content V1 read is untouched:
  assert.match(src, /api\.contentAssetDetail\(owner,\s*assetId\)/u, "Content V1 detail read remains owner-bound");
  assert.match(src, /api\.contentMaterialSetFavorite/u, "Content V1 organization actions remain");
  // Services enrichment rides the same route owner/asset: the page binds the
  // route identity to the production controller and loadSource uses it.
  assert.match(src, /loadSource\(\);/u, "enrichment issued through the controller");
  assert.match(src, /detailV1: \(ownerId, asset\) => services\.materials\.detailV1\(ownerId, asset\)/u,
    "detailV1 uses the bound owner+asset verbatim");
  assert.match(src, /sourceCtrlRef\.bind\(\{ owner, assetId, isLive:/u,
    "the seam binds the exact route owner+asset");
  // The latest-request-wins fence lives in the production controller:
  const seam = strip(read("src", "services", "sourceEnrichment.ts"));
  assert.match(seam, /if \(!committed\(\)\) return;/u, "latest-request-wins fence");
});

test("detail — presentation target is the exact route asset, never retargeted", () => {
  const src = strip(read("src", "services", "presentationAction.ts"));
  assert.match(src, /domain: "materials", assetId: ctx\.assetId/u,
    "target binds the route assetId");
  assert.doesNotMatch(src, /assetId:\s*("|'|`)(?!.*ctx\.assetId)/u);
});

// 3. Source copy semantics.
test("source — work-page/capture-page/unknown/no-source copy is truthful", () => {
  const work = sourceBlockOf(detailWith({
    captureKind: "web", pageKind: "work-page",
    pageUrl: "https://example.com/art/123?utm=x#frag", siteOrigin: "https://example.com",
  }));
  assert.equal(work.kind, "page");
  assert.equal(work.label, "原作品页面");

  const capture = sourceBlockOf(detailWith({
    captureKind: "web", pageKind: "capture-page", pageUrl: "https://example.com/p/9",
  }));
  assert.equal(capture.kind, "page");
  assert.equal(capture.label, "采集页面");

  const unknown = sourceBlockOf(detailWith({
    captureKind: "web", pageKind: undefined, pageUrl: "https://example.com/whatever",
  }));
  assert.equal(unknown.kind, "page");
  assert.equal(unknown.label, "来源页面");

  const none = sourceBlockOf(detailWith(undefined));
  assert.equal(none.kind, "no-source");

  const importKind = sourceBlockOf(detailWith({ captureKind: "import" }));
  assert.equal(importKind.kind, "no-source");

  assert.equal(captureKindText("import"), "文件导入");
  assert.equal(captureKindText("bogus"), undefined);
});

// 4+5. Byte-exact URL carrying; no path/media reconstruction.
test("source — pageUrl keeps query+hash EXACTLY; origin is supplemental only", () => {
  const url = "https://example.com/art/%E7%94%BB?a=1&b=%E4%BA%8C#frag-π";
  const block = sourceBlockOf(detailWith({
    captureKind: "web", pageKind: "work-page", pageUrl: url, siteOrigin: "https://example.com",
  }));
  assert.equal(canonicalPageUrl(block), url, "URL must be byte-for-byte");
  if (block.kind !== "page") throw new Error("unreachable");
  assert.equal(block.siteOrigin, "https://example.com", "origin shown as supplemental");
});

test("source — local/cache/media paths can never become the external page URL", () => {
  const src = strip(read("src", "services", "sourceBlock.ts"));
  assert.doesNotMatch(src, /convertFileSrc|CACHED|mediaUrl|cdn|localStorage/u,
    "sourceBlock derives the URL from canonical source only");
  // carrySafeSource is a field copy; it cannot invent URLs either.
  const carried = carrySafeSource({ captureKind: "web", pageKind: "work-page", pageUrl: "https://x/y?z=1" });
  assert.equal(carried.pageUrl, "https://x/y?z=1");
  assert.equal(preservesWorkPageUrl({ captureKind: "web", pageKind: "work-page", pageUrl: "https://x" }), false,
    "an origin-only work page is a fidelity violation");
});

// 6+7+8. Opener/copy exactness + WebView83 copy fallback.
test("open/copy — system opener and clipboard receive the EXACT canonical URL", async () => {
  const url = "https://example.com/a/b?token=x&i=2#top";
  let opened: string | null = null;
  const fakeOpener = async (u: string) => { opened = u; };

  // Mirror the driver's call shape: the exact canonical string, untouched.
  const block = sourceBlockOf(detailWith({
    captureKind: "web", pageKind: "work-page", pageUrl: url,
  }));
  const canonical = canonicalPageUrl(block);
  await fakeOpener(canonical!);
  assert.equal(opened, url);

  // Copy: Clipboard API first.
  const sent: string[] = [];
  const savedNav = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (t: string) => { sent.push(t); } } },
    configurable: true, writable: true,
  });
  try {
    assert.equal(await copyTextExact(url), "copied");
    assert.deepEqual(sent, [url], "clipboard receives the byte-exact URL");
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: savedNav, configurable: true, writable: true });
  }
});

test("copy — WebView83 fallback (no clipboard API) still copies via textarea", async () => {
  const url = "https://example.com/legacy?q=1";
  const created: Array<{ value: string; selected: boolean }> = [];
  const fakeDoc = {
    createElement: (_tag: string) => {
      const el = {
        value: "",
        selected: false,
        style: {} as Record<string, string>,
        setAttribute: () => {},
        select: function () { (this as { selected: boolean }).selected = true; },
        setSelectionRange: () => {},
      };
      return el;
    },
    body: {
      children: [] as unknown[],
      appendChild(child: unknown) { this.children.push(child); created.push(child as { value: string; selected: boolean }); },
      removeChild(child: unknown) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); },
    },
    execCommand: (_cmd: string) => true,
  } as unknown as Document;
  assert.equal(await copyTextExact(url, fakeDoc), "copied");
  assert.equal(created.length, 1);
  assert.equal(created[0].value, url, "textarea carries the byte-exact URL");
  assert.equal(created[0].selected, true);
});

test("copy — truthful failure when every path fails", async () => {
  const fakeDoc = {
    createElement: () => ({ value: "", style: {}, setAttribute: () => {}, select: () => {}, setSelectionRange: () => {} }),
    body: { children: [], appendChild: () => {}, removeChild: () => {} },
    execCommand: () => false,
  } as unknown as Document;
  assert.equal(await copyTextExact("https://x/", fakeDoc), "failed");
  // No DOM at all -> truthful failure, never a throw.
  assert.equal(await copyTextExact("https://x/", null), "failed");
});

// 9+10. Currentness for source enrichment.
test("currentness — stale source success/error cannot commit (controller contract)", () => {
  // The seam fences EVERY commit by request token AND page generation:
  // only the latest issued request for the live page may commit.
  const src = strip(read("src", "still", "StillAsset.tsx"));
  const seam = strip(read("src", "services", "sourceEnrichment.ts"));
  assert.match(seam, /const committed = \(\) =>\s+token === this\.token && binding\.isLive\(\);/u,
    "source commit is fenced by token AND liveness (production controller)");
  assert.match(seam, /if \(!committed\(\)\) return;/u, "the fence guards success AND error");
  assert.match(src, /setSourceState\(\{ phase: "loading" \}\);/u, "loading state exists");
  assert.match(src, /phase: "error", code/u, "error state carries the canonical code");
});

test("currentness — owner mismatch / disconnect fail closed without retargeting", () => {
  const src = strip(read("src", "still", "StillAsset.tsx"));
  assert.match(src, /if \(ownerMismatch\) \{\s*\n\s*setMessage\("当前电脑已更换，这条素材属于原来那台电脑，无法在此打开。"\);/u,
    "owner mismatch refuses 在电脑打开");
  // The section disables the action while pending; the page gates owner mismatch.
  assert.match(src, /const sourceSectionProps = \{[\s\S]*?present, pendingPresent, copyState,/u,
    "shared source props carry the real pending state, not a constant");
  assert.equal((src.match(/<ServicesSourceSection \{\.\.\.sourceSectionProps\}/gu) || []).length, 2,
    "both the compact detail and original Info consume the guarded source props");
  assert.match(src, /if \(pendingPresent\) return;[\s\S]*?setPendingPresent\(true\);[\s\S]*?presentCtrl\.open\(\)\.finally\(\(\) => setPendingPresent\(false\)\)/u,
    "pending presentation still coalesces repeated user actions and clears on settlement");
  const section = strip(read("src", "still", "kit", "servicesSourceSection.tsx"));
  assert.match(section, /disabled=\{pendingPresent\}/u,
    "the action is disabled while pending (component-level)");
  assert.match(src, /const retrySource = useCallback\(\(\) => \{\s*if \(ownerMismatch\) return;\s*loadSource\(\);/u,
    "retry handler exists and is owner-gated");
});

// 11–13. Presentation op identity.
type Feedback = { tone: string; text: string };
type PresentationClientLike = { open: (o: string, opId: string, t: { assetId: string }) => Promise<unknown> };
function makeController(transport: PresentationClientLike, isCurrent: (gen: number) => boolean = () => true) {
  const feedbacks: Feedback[] = [];
  const ctrl = new PresentationActionController(transport as never, {
    getFeedback: (f) => feedbacks.push(f),
    isCurrent: (ctx) => isCurrent(ctx.generation),
  });
  return { ctrl, feedbacks };
}

test("presentation — double-tap coalesces into ONE operation/opId", async () => {
  const calls: Array<{ opId: string; assetId: string }> = [];
  let resolveOpen!: (v: unknown) => void;
  const { ctrl } = makeController({
    open: async (_o, opId, t) => new Promise((res) => { calls.push({ opId, assetId: t.assetId }); resolveOpen = res; }),
  });
  ctrl.bind({ owner: "inst-1", assetId: "asset-A", generation: 1 });
  const p1 = ctrl.open();
  const p2 = ctrl.open(); // double tap while pending
  assert.equal(calls.length, 1, "second tap must not issue a second wire call");
  resolveOpen({ kind: "confirmed", state: "accepted", opId: calls[0].opId });
  await Promise.all([p1, p2]);
  assert.equal(new Set(calls.map((c) => c.opId)).size, 1, "exactly one opId");
  assert.equal(calls[0].assetId, "asset-A", "target is the route asset");
});

test("presentation — uncertain transport failure keeps SAME opId + target on retry", async () => {
  const calls: Array<{ opId: string; assetId: string }> = [];
  let fail = true;
  const { ctrl } = makeController({
    open: async (_o, opId, t) => {
      calls.push({ opId, assetId: t.assetId });
      if (fail) throw new Error("network dropped mid-request"); // uncertain
      return { kind: "confirmed", state: "accepted", opId };
    },
  });
  ctrl.bind({ owner: "inst-1", assetId: "asset-A", generation: 1 });
  await ctrl.open(); // uncertain failure
  assert.equal(calls.length, 1);
  await ctrl.open(); // the user's RETRY
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opId, calls[1].opId, "retry keeps the SAME opId");
  assert.equal(calls[1].assetId, "asset-A", "retry keeps the SAME target");
  fail = false;
});

test("presentation — definitive refusal spends the identity; new action mints fresh opId", async () => {
  const calls: string[] = [];
  let deny = true;
  const { ctrl } = makeController({
    open: async (_o, opId, _t) => {
      calls.push(opId);
      if (deny) throw new ServicesError("GRANT_REQUIRED", 403);
      return { kind: "confirmed", state: "accepted", opId };
    },
  });
  ctrl.bind({ owner: "inst-1", assetId: "asset-A", generation: 1 });
  await ctrl.open(); // GRANT_REQUIRED (definite)
  deny = false;
  await ctrl.open(); // a NEW explicit action after the definite refusal
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1], "a new action after a DEFINITE refusal may mint fresh");
  assert.match(calls[1], /^[0-9a-f-]{36}$/u);
});

test("presentation — late outcome for an old page context never commits", async () => {
  const feedbacks: Feedback[] = [];
  let release!: (v: unknown) => void;
  const client = {
    open: async (_o: string, opId: string, _t: unknown) => new Promise((res) => { release = () => res({ kind: "confirmed", state: "accepted", opId }); }),
  };
  const ctrl = new PresentationActionController(client as never, {
    getFeedback: (f) => feedbacks.push(f),
    isCurrent: (ctx) => ctx.generation === 1, // page has moved on to generation 2
  });
  ctrl.bind({ owner: "inst-1", assetId: "asset-A", generation: 1 });
  const p = ctrl.open();
  // The synchronous pending hint may have been shown on the then-current page;
  // what must NEVER happen is a TERMINAL outcome landing after the switch.
  const terminalBefore = feedbacks.filter((f) => f.tone !== "pending").length;
  ctrl.bind({ owner: "inst-1", assetId: "asset-B", generation: 2 }); // route changed
  release(undefined);
  await p;
  const terminalAfter = feedbacks.filter((f) => f.tone !== "pending").length;
  assert.equal(terminalAfter, terminalBefore, "the stale terminal outcome must be dropped entirely");
});

test("presentation — action after route change targets the NEW asset only", async () => {
  const calls: Array<{ assetId: string; gen: number }> = [];
  const client = {
    open: async (_o: string, _opId: string, t: { assetId: string }) => {
      calls.push({ assetId: t.assetId, gen: 0 });
      return { kind: "confirmed", state: "accepted", opId: _opId };
    },
  };
  const ctrl = new PresentationActionController(client as never, {
    getFeedback: () => {},
    isCurrent: () => true,
  });
  ctrl.bind({ owner: "inst-1", assetId: "asset-A", generation: 1 });
  ctrl.bind({ owner: "inst-1", assetId: "asset-B", generation: 2 }); // same page, new asset
  await ctrl.open();
  assert.deepEqual(calls.map((c) => c.assetId), ["asset-B"],
    "the new context targets ONLY the new asset");
});

// 14+15. Truthful copy.
test("feedback — accepted vs handoffStarted vs refused vs retired never over-claim display", () => {
  const accepted = outcomeFeedback({ kind: "confirmed", state: "accepted", opId: "o" });
  assert.equal(accepted.text, "电脑已接受，正在打开");
  const displayed = outcomeFeedback({ kind: "confirmed", state: "displayed", opId: "o" });
  assert.equal(displayed.text, "已在电脑上打开");
  const handoff = outcomeFeedback({ kind: "handoffStarted", opId: "o" });
  assert.equal(handoff.text, "已交给电脑处理，正在打开");
  assert.ok(!handoff.text.includes("已显示") && !handoff.text.includes("已打开成功"),
    "handoffStarted must never claim display success");
  assert.equal(outcomeFeedback({ kind: "refused", opId: "o" }).tone, "error");
  assert.equal(outcomeFeedback({ kind: "retired", opId: "o" }).tone, "warn");
});

test("feedback — GRANT_REQUIRED / unavailable / busy / retired copy is canonical-guided", () => {
  assert.match(failureFeedback(new ServicesError("GRANT_REQUIRED", 403)).text, /权限/u);
  assert.match(failureFeedback(new ServicesError("SERVICE_UNAVAILABLE", 503)).text, /连不上|检查连接/u);
  assert.match(failureFeedback(new ServicesError("PRESENTATION_BUSY", 409)).text, /忙/u);
  const retired = failureFeedback(new ServicesError("OP_ID_REUSED", 409));
  assert.ok(retired.tone === "error" || retired.tone === "warn");
});

// 16. No AcceptanceDriver import anywhere in the product path.
test("product — no AcceptanceDriver import in normal product paths", () => {
  for (const f of [
    "src/services/secureUuid.ts", "src/services/clipboardText.ts",
    "src/services/sourceBlock.ts", "src/services/presentationAction.ts",
    "src/still/StillAsset.tsx",
  ]) {
    const src = read(...f.split("/"));
    assert.doesNotMatch(src, /servicesAcceptance/u, `${f} must not import acceptance tooling`);
  }
});

// 17. flag-off product build contains the real Services path and excludes the driver.
test("build — ci-lite registers BOTH accepted test families (union preserved)", () => {
  const yml = read(".github", "workflows", "ci-lite.yml");
  for (const t of [
    "companionServicesV1G1.contract.test.ts",
    "servicesAcceptanceDriver.contract.test.ts",
    "uxPolishR1.contract.test.ts",
    "uxPolishR1Repair.contract.test.ts",
    "servicesAssetDetail.contract.test.ts",
    "servicesSearchR1.contract.test.ts",
  ]) {
    assert.ok(yml.includes(t), `ci-lite must register ${t}`);
  }
});

// Production UUID helper (WebView83-compatible, independent of acceptance).
test("uuid — production helper mints valid v4; WebView83 fallback; fails closed", () => {
  const native = secureUuidV4({ randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" } as unknown as Crypto);
  assert.equal(native, "123e4567-e89b-42d3-a456-426614174000");

  const fake = {
    getRandomValues: (a: Uint8Array) => { a.fill(0xff); return a; },
  } as unknown as Crypto;
  const value = secureUuidV4(fake);
  assert.ok(isSecureUuidV4(value), `expected v4, got ${value}`);
  assert.equal(value[14], "4");
  assert.ok(["8", "9", "a", "b"].includes(value[19]));

  assert.throws(() => secureUuidV4(null), SecureUuidUnavailableError);
  assert.throws(() => secureUuidV4({ randomUUID: () => "junk" } as unknown as Crypto), SecureUuidUnavailableError);
  // All-zero entropy still gets the forced version/variant bits.
  assert.equal(
    formatSecureUuidV4(new Uint8Array(16)),
    "00000000-0000-4000-8000-000000000000",
    "version/variant bits are forced even with zero entropy",
  );

  const src = strip(read("src", "services", "secureUuid.ts"));
  assert.doesNotMatch(src, /Math\.random|Date\.now/u, "no insecure fallback");
  // Substantive check (imports/usage): the stripped source must not reference
  // the acceptance tooling module at all.
  assert.doesNotMatch(src, /servicesAcceptance/u, "secureUuid must not use acceptance tooling");
});

// ---------------------------------------------------------------------------
// REPAIR-R2 R2-A — source-enrichment currentness + retry, exercised against
// the PRODUCTION SourceEnrichmentController (the exact class StillAsset uses)
// with an injected deferred detailV1. No test replica of the currentness
// logic exists anywhere.
// ---------------------------------------------------------------------------

import { SourceEnrichmentController } from "../src/services/sourceEnrichment.ts";

type Deferred = { promise: Promise<MaterialDetail>; resolve: (d: MaterialDetail) => void; reject: (e: unknown) => void };
function deferred(): Deferred {
  let resolve!: (d: MaterialDetail) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<MaterialDetail>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Harness wiring the PRODUCTION controller to deferred transports. */
function makeHarness() {
  const commits: Array<{ phase: string; code?: string; pageUrl?: string }> = [];
  const wire: Array<{ owner: string; assetId: string; d: Deferred }> = [];
  const controller = new SourceEnrichmentController({
    detailV1: (owner, assetId) => {
      const d = deferred();
      wire.push({ owner, assetId, d });
      return d.promise;
    },
    commit: (c) => commits.push({
      phase: c.phase,
      code: c.phase === "error" ? c.code : undefined,
      pageUrl: c.phase === "ready" ? c.source?.pageUrl : undefined,
    }),
    errorCodeOf: (e) => String((e as { code?: string }).code ?? e),
  });
  return { controller, commits, wire };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const OK_URL = "https://ok/x?y=2#z";
const okDetail = () => ({ source: { captureKind: "web", pageKind: "work-page", pageUrl: OK_URL } }) as unknown as MaterialDetail;

function liveBinding() {
  return { owner: "inst-1", assetId: "asset-A", isLive: () => true };
}

test("R2 — old SUCCESS after a newer retry cannot commit (production seam)", async () => {
  const h = makeHarness();
  h.controller.bind(liveBinding());
  h.controller.load();          // request 0 (slow)
  h.controller.load();          // the newer RETRY
  h.wire[1].d.resolve(okDetail());
  await flush();
  h.wire[0].d.resolve({ source: { captureKind: "web", pageKind: "work-page", pageUrl: "https://old/" } } as unknown as MaterialDetail);
  await flush();
  const last = h.commits.at(-1)!;
  assert.equal(last.phase, "ready");
  assert.equal(last.pageUrl, OK_URL, "the OLD success never overwrote the newer one");
});

test("R2 — old ERROR after a newer success cannot commit (production seam)", async () => {
  const h = makeHarness();
  h.controller.bind(liveBinding());
  h.controller.load();
  h.controller.load();          // newer retry
  h.wire[1].d.resolve(okDetail());
  await flush();                // retry success commits
  h.wire[0].d.reject(Object.assign(new Error("x"), { code: "GRANT_REQUIRED" }));
  await flush();
  const last = h.commits.at(-1)!;
  assert.equal(last.phase, "ready", "the old error must not replace the newer success");
});

test("R2 — route/unmount retirement: retired request commits nothing", async () => {
  const h = makeHarness();
  h.controller.bind(liveBinding());
  h.controller.load();
  h.controller.retire();        // page context gone (reroute/unmount)
  h.wire[0].d.resolve(okDetail());
  await flush();
  assert.ok(!h.commits.some((c) => c.phase === "ready"), "retired request must not commit at all");
});

test("R2 — GRANT_REQUIRED → explicit retry → success without page exit", async () => {
  const h = makeHarness();
  h.controller.bind(liveBinding());
  h.controller.load();
  h.wire[0].d.reject(Object.assign(new Error("x"), { code: "GRANT_REQUIRED" }));
  await flush();
  assert.equal(h.commits.at(-1)!.phase, "error");
  assert.equal(h.commits.at(-1)!.code, "GRANT_REQUIRED");
  // The user grants on Desktop, then presses 重试来源 — SAME controller, SAME
  // binding (no page exit, no remount).
  h.controller.load();
  h.wire[1].d.resolve(okDetail());
  await flush();
  assert.equal(h.commits.at(-1)!.phase, "ready", "explicit retry succeeds in place");
  assert.equal(h.wire[0].owner, h.wire[1].owner, "same owner");
  assert.equal(h.wire[0].assetId, h.wire[1].assetId, "same asset");
});

test("R2 — A detail → B detail late-result isolation (production seam)", async () => {
  const h = makeHarness();
  h.controller.bind({ owner: "inst-1", assetId: "asset-A", isLive: () => true });
  h.controller.load();          // A in flight
  // Route changes to B: rebind (retires A) and load B.
  h.controller.bind({ owner: "inst-1", assetId: "asset-B", isLive: () => true });
  h.controller.load();
  h.wire[0].d.resolve({ source: { captureKind: "web", pageKind: "work-page", pageUrl: "https://A-page/" } } as unknown as MaterialDetail);
  await flush();
  h.wire[1].d.resolve({ source: { captureKind: "web", pageKind: "work-page", pageUrl: "https://B-page/" } } as unknown as MaterialDetail);
  await flush();
  const ready = h.commits.filter((c) => c.phase === "ready");
  assert.equal(ready.length, 1, "only B's result committed");
  assert.equal(ready[0].pageUrl, "https://B-page/");
});

test("R2 — same-Desktop drop retires pre-drop request; reconnect issues ONE fresh read", async () => {
  const h = makeHarness();
  let live = true;
  h.controller.bind({ owner: "inst-1", assetId: "asset-A", isLive: () => live });
  h.controller.load();          // pre-drop request in flight
  // The page mirrors its ws-drop handling: retire + retryable error state.
  live = false;
  h.controller.retire();
  h.wire[0].d.resolve(okDetail());   // the pre-drop answer lands late
  await flush();
  assert.ok(!h.commits.some((c) => c.phase === "ready"),
    "the pre-drop answer must not become post-drop truth");
  // Reconnect: the page rebinds (fresh epoch) and issues exactly ONE read.
  live = true;
  h.controller.bind({ owner: "inst-1", assetId: "asset-A", isLive: () => live });
  h.controller.load();
  h.wire[1].d.resolve(okDetail());
  await flush();
  assert.equal(h.wire.length, 2, "exactly one fresh read after reconnect");
  assert.equal(h.commits.at(-1)!.phase, "ready");
});


// The product page must drive the PRODUCTION controller (no replica).
test("repair — StillAsset drives the PRODUCTION SourceEnrichmentController", () => {
  const src = strip(read("src", "still", "StillAsset.tsx"));
  assert.match(src, /new SourceEnrichmentController\(\{/u, "the production controller is used");
  assert.match(src, /sourceCtrlRef\.bind\(\{ owner, assetId, isLive:/u, "exact owner+asset binding per page");
  assert.match(src, /const retrySource = useCallback/u, "explicit retry-source handler");
  assert.match(src, /sourceCtrlRef\.retire\(\);/u, "retire on unmount");
  assert.match(src, /reconnected && !ownerMismatch/u, "same-Desktop reconnect re-reads once");
  assert.match(src, /sourceCtrlRef\.bind\(\{ owner, assetId, isLive: \(\) => sourceGen\.current === detailGen\.current \}\);/u,
    "reconnect rebinds a fresh epoch");
  // The REAL component is used by the product page (not hand-written DOM).
  assert.match(src, /<ServicesSourceSection/u);
  // No polling anywhere.
  assert.doesNotMatch(src, /setInterval|polling/u);
});
