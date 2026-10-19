// Node.js tests for the shared Local Asset thumbnail scheduler (FIX-V1 P1-3):
// bounded concurrency, same-asset coalescing, failure releases its slot,
// later jobs continue after a failure.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_THUMBNAIL_CONCURRENCY,
  ThumbnailScheduler,
} from "../src/services/thumbnailQueue.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("scheduler — 10 queued jobs never exceed the configured concurrency", async () => {
  const s = new ThumbnailScheduler();
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 10 }, (_, i) =>
    s.enqueue(`job-${i}`, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return i;
    })
  );
  const results = await Promise.all(jobs);
  assert.equal(peak, MAX_THUMBNAIL_CONCURRENCY, `peak concurrency must be <= ${MAX_THUMBNAIL_CONCURRENCY}`);
  assert.ok(peak <= MAX_THUMBNAIL_CONCURRENCY);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(s.activeCount(), 0);
});

test("scheduler — same asset duplicate request is coalesced (runs once)", async () => {
  const s = new ThumbnailScheduler();
  let runs = 0;
  const gate = deferred<void>();
  const p1 = s.enqueue("asset-x", async () => {
    runs += 1;
    await gate.promise;
    return "thumb-x";
  });
  const p2 = s.enqueue("asset-x", async () => "should-never-run");
  // The second enqueue must share the first job's promise.
  assert.equal(p1, p2, "same key coalesces to the same promise");
  gate.resolve();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, "thumb-x");
  assert.equal(r2, "thumb-x");
  assert.equal(runs, 1, "the task ran exactly once");
});

test("scheduler — failed job releases its slot and later jobs continue", async () => {
  const s = new ThumbnailScheduler();
  const results: string[] = [];
  const jobs = [
    s.enqueue("fail-1", async () => {
      throw new Error("decode failed");
    }),
    s.enqueue("ok-1", async () => {
      results.push("ok-1");
      return "ok-1";
    }),
    s.enqueue("ok-2", async () => {
      results.push("ok-2");
      return "ok-2";
    }),
  ];
  await assert.rejects(jobs[0], /decode failed/);
  const ok = await Promise.all([jobs[1], jobs[2]]);
  assert.deepEqual(ok, ["ok-1", "ok-2"]);
  assert.deepEqual(results, ["ok-1", "ok-2"], "later jobs continue after a failure");
  assert.equal(s.activeCount(), 0, "failed job released its slot");
  // A retry of the failed key is a fresh job (no poisoning).
  const retry = await s.enqueue("fail-1", async () => "recovered");
  assert.equal(retry, "recovered");
});

test("scheduler — concurrency limit is the documented value", () => {
  assert.equal(MAX_THUMBNAIL_CONCURRENCY, 3);
});

test("scheduler — a queued tail becomes near without losing coalescing", async () => {
  const s=new ThumbnailScheduler(), gate=deferred<void>(), order:string[]=[];
  const running=Array.from({length:3},(_,i)=>s.enqueue(`active-${i}`,()=>gate.promise));
  const first=s.enqueue("tail-first",async()=>{order.push("first");});
  const visible=s.enqueue("visible",async()=>{order.push("visible");});
  assert.equal(s.enqueue("visible",async()=>{throw new Error("must coalesce");},"near"),visible);
  gate.resolve();await Promise.all([...running,first,visible]);
  assert.equal(order[0],"visible");
});

test("scheduler — retiring only queued old-owner work allows exact fresh retry", async () => {
  const s=new ThumbnailScheduler(), gate=deferred<void>();
  const running=Array.from({length:3},(_,i)=>s.enqueue(`current-${i}`,()=>gate.promise));
  const retired=s.enqueue("desktop:A:x",async()=>"obsolete");
  const rejected=assert.rejects(retired,/THUMBNAIL_CANCELLED/);
  const kept=s.enqueue("local:x",async()=>"local");
  assert.equal(s.cancelPending(key=>key.startsWith("desktop:A:")),1);
  await rejected;const fresh=s.enqueue("desktop:A:x",async()=>"fresh","near");
  gate.resolve();await Promise.all(running);
  assert.equal(await kept,"local");assert.equal(await fresh,"fresh");
  assert.equal(s.activeCount(),0);assert.equal(s.pendingCount(),0);
});
