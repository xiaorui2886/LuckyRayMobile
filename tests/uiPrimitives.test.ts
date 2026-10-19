// UI-REFRESH-R1 — feedback primitives: toast queueing and failure copy.
// Pure logic, no Tauri, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { ToastStore, TOAST_MAX_VISIBLE } from "../src/services/toast.ts";
import { failureCopy, failureIsRetryable } from "../src/services/feedback.ts";
import { OverlayStack } from "../src/services/overlayStack.ts";
import { sortRows, SORT_LABELS } from "../src/services/viewPreferences.ts";

test("toast — shows, auto-expires, and notifies subscribers", async () => {
  const store = new ToastStore();
  let notified = 0;
  const un = store.subscribe(() => notified++);
  store.push({ message: "已保存" }, 10);
  assert.equal(store.snapshot().length, 1);
  assert.equal(notified, 1);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(store.snapshot().length, 0, "toast expires on its own");
  assert.ok(notified >= 2, "dismissal notifies");
  un();
});

test("toast — an empty message is ignored", () => {
  const store = new ToastStore();
  assert.equal(store.push({ message: "   " }), -1);
  assert.equal(store.snapshot().length, 0);
});

test("toast — repeating the same message refreshes instead of stacking", () => {
  const store = new ToastStore();
  const first = store.push({ message: "连不上电脑", tone: "danger" }, 10_000);
  const second = store.push({ message: "连不上电脑", tone: "danger" }, 10_000);
  assert.equal(first, second, "same id: the timer is refreshed");
  assert.equal(store.snapshot().length, 1, "a burst of the same failure must not cover the screen");
});

test("toast — different tones of the same text are distinct", () => {
  const store = new ToastStore();
  store.push({ message: "已连接", tone: "success" }, 10_000);
  store.push({ message: "已连接", tone: "warning" }, 10_000);
  assert.equal(store.snapshot().length, 2);
});

test("toast — only the newest few are kept visible", () => {
  const store = new ToastStore();
  for (let i = 0; i < TOAST_MAX_VISIBLE + 3; i++) store.push({ message: `m${i}` }, 10_000);
  assert.equal(store.snapshot().length, TOAST_MAX_VISIBLE);
  assert.equal(store.snapshot()[TOAST_MAX_VISIBLE - 1].message, `m${TOAST_MAX_VISIBLE + 2}`);
});

test("toast — dismiss removes a specific toast and is idempotent", () => {
  const store = new ToastStore();
  const id = store.push({ message: "a" }, 10_000);
  store.push({ message: "b" }, 10_000);
  store.dismiss(id);
  assert.deepEqual(store.snapshot().map((t) => t.message), ["b"]);
  store.dismiss(id); // no-op
  assert.equal(store.snapshot().length, 1);
});

test("toast — clear removes everything", () => {
  const store = new ToastStore();
  store.push({ message: "a" }, 10_000);
  store.push({ message: "b" }, 10_000);
  store.clear();
  assert.equal(store.snapshot().length, 0);
});

test("feedback — raw transport/runtime errors never reach the product surface", () => {
  assert.match(failureCopy("TypeError: fetch failed"), /连不上电脑/);
  assert.match(failureCopy(new Error("connect ECONNREFUSED 192.168.1.5:48180")), /连不上电脑/);
  assert.match(failureCopy("REVISION_CONFLICT"), /电脑上已更新/);
  assert.match(failureCopy("401 PAIRING_REQUIRED"), /授权已失效/);
  assert.match(failureCopy("RESOURCE_UNAVAILABLE"), /暂时不可用/);
  assert.match(failureCopy("TOO_LARGE"), /64 MB/);
  // An unrecognised failure gets the calm generic line, never the raw string.
  const generic = failureCopy("some internal rust enum Debug {...}");
  assert.equal(generic, "操作没有完成，请重试。");
  assert.ok(!generic.includes("rust"));
});

test("feedback — retryability is offered only for genuinely retryable failures", () => {
  assert.equal(failureIsRetryable("fetch failed"), true);
  assert.equal(failureIsRetryable("REVISION_CONFLICT"), true);
  assert.equal(failureIsRetryable("TOO_LARGE"), false);
  assert.equal(failureIsRetryable("ok"), false);
});

test("overlayStack — BACK dismisses the topmost overlay before navigation", () => {
  const stack = new OverlayStack();
  assert.equal(stack.dismissTop(), false, "nothing to dismiss");
  const order: string[] = [];
  const releaseA = stack.push(() => order.push("a"));
  const releaseB = stack.push(() => order.push("b"));
  assert.equal(stack.depth(), 2);
  assert.equal(stack.dismissTop(), true);
  assert.deepEqual(order, ["b"], "topmost wins");
  releaseB();
  assert.equal(stack.depth(), 1);
  assert.equal(stack.dismissTop(), true);
  assert.deepEqual(order, ["b", "a"]);
  releaseA();
  assert.equal(stack.dismissTop(), false);
});

test("viewPreferences — recent keeps a stable newest-first order", () => {
  const rows = [
    { name: "old", updatedAt: "2026-01-01T00:00:00Z" },
    { name: "new", updatedAt: "2026-09-01T00:00:00Z" },
    { name: "mid", updatedAt: "2026-05-01T00:00:00Z" },
  ];
  assert.deepEqual(sortRows(rows, "recent").map((r) => r.name), ["new", "mid", "old"]);
});

test("viewPreferences — name and size sorts order the loaded rows", () => {
  // Names and sizes are deliberately anti-correlated, so a name sort and a
  // size sort must produce DIFFERENT orders.
  const rows = [
    { name: "alpha", sizeBytes: 10 },
    { name: "bravo", sizeBytes: 300 },
    { name: "charlie", sizeBytes: 2000 },
  ];
  assert.deepEqual(sortRows(rows, "name").map((r) => r.name), ["alpha", "bravo", "charlie"]);
  assert.deepEqual(sortRows(rows, "size").map((r) => r.name), ["charlie", "bravo", "alpha"]);
  assert.equal(SORT_LABELS.recent, "最近更新");
});
