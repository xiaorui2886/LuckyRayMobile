import test from "node:test";
import assert from "node:assert/strict";
import { KnowledgeEditingSession, type EditingEffects } from "../src/services/knowledgeEditingSession.ts";
import { ServicesError } from "../src/services/companionServices/transport.ts";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const scope = { instance: "A", vault: "v", note: "n" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test("active saves and renewal ticks share a single pending open", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const opened = deferred<string>();
  let opens = 0;
  const writes: string[] = [];
  const lease = new KnowledgeEditingSession(scope, {
    open: () => { opens++; return opened.promise; },
    readDesktop: async () => false,
    publish: async (_scope, token) => { writes.push(token); },
    observe: () => {},
  });
  for (let i = 0; i < 3; i++) { lease.committed(); t.mock.timers.tick(400); }
  t.mock.timers.tick(5000);
  assert.equal(opens, 1);
  assert.deepEqual(writes, []);
  opened.resolve("server-a");
  await turn();
  assert.deepEqual(writes, ["server-a"]);
  lease.retire();
});

test("hidden or retired owner never publishes a late open response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const retire of [false, true]) {
    const opened = deferred<string>();
    let opens = 0;
    const writes: boolean[] = [];
    const lease = new KnowledgeEditingSession(scope, {
      open: () => { opens++; return opened.promise; },
      readDesktop: async () => false,
      publish: async (_scope, _token, _gen, editing) => { writes.push(editing); },
      observe: () => {},
    });
    lease.committed();
    t.mock.timers.tick(400);
    if (retire) lease.retire(); else lease.setVisible(false);
    opened.resolve("late-reservation");
    await turn();
    t.mock.timers.tick(15000);
    assert.equal(opens, 1);
    assert.equal(writes.includes(true), false);
    lease.retire();
  }
});

test("current expired token reopens once; an older token's late 410 cannot replace its successor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const oldFirst = deferred<void>();
  const oldSecond = deferred<void>();
  let opens = 0;
  const writes: Array<[string, number, boolean]> = [];
  const lease = new KnowledgeEditingSession(scope, {
    open: async () => `server-${++opens}`,
    readDesktop: async () => false,
    publish: (_scope, token, gen, editing) => {
      writes.push([token, gen, editing]);
      if (token === "server-1" && gen === 1) return oldFirst.promise;
      if (token === "server-1" && gen === 2) return oldSecond.promise;
      return Promise.resolve();
    },
    observe: () => {},
  });
  lease.committed();
  t.mock.timers.tick(400);
  await turn();
  t.mock.timers.tick(5000);
  oldFirst.reject(new ServicesError("CURSOR_TOO_OLD", 410));
  await turn();
  assert.equal(opens, 1, "expiry waits for the existing cadence");
  t.mock.timers.tick(5000);
  await turn();
  assert.equal(opens, 2);
  assert.deepEqual(writes.at(-1), ["server-2", 1, true]);
  oldSecond.reject(new ServicesError("CURSOR_TOO_OLD", 410));
  await turn();
  assert.equal(opens, 2);
  t.mock.timers.tick(5000);
  assert.deepEqual(writes.at(-1), ["server-2", 2, true]);
  lease.retire();
});

test("expired replacement failures reopen only on the existing cadence, not a tight loop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const never = deferred<string>();
  let opens = 0;
  const lease = new KnowledgeEditingSession(scope, {
    open: async () => { opens++; return opens > 2 ? never.promise : `server-${opens}`; },
    readDesktop: async () => false,
    publish: async () => { throw new ServicesError("CURSOR_TOO_OLD", 410); },
    observe: () => {},
  });
  lease.committed();
  t.mock.timers.tick(400);
  await turn();
  assert.equal(opens, 1);
  lease.committed();
  t.mock.timers.tick(400);
  await turn();
  assert.equal(opens, 1, "new local saves do not bypass failed-lease cadence");
  t.mock.timers.tick(5000);
  await turn();
  assert.equal(opens, 2);
  lease.retire();
});

test("foreground cannot adopt a POST begun before background; only its fresh token is published", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const oldOpen = deferred<string>();
  let opens = 0;
  const writes: Array<[string, boolean]> = [];
  const lease = new KnowledgeEditingSession(scope, {
    open: () => { opens++; return opens === 1 ? oldOpen.promise : Promise.resolve("foreground-token"); },
    readDesktop: async () => false,
    publish: async (_scope, token, _gen, editing) => { writes.push([token, editing]); },
    observe: () => {},
  });
  lease.committed();
  t.mock.timers.tick(400);
  lease.setVisible(false);
  lease.setVisible(true);
  assert.equal(opens, 1, "even foreground keeps the prior POST single-flight");
  oldOpen.resolve("unused-old-reservation");
  await turn();
  assert.deepEqual(writes, []);
  t.mock.timers.tick(5000);
  await turn();
  assert.equal(opens, 2);
  assert.deepEqual(writes, [["foreground-token", true]]);
  lease.retire();
});

test("failed POST offline or denied only retries on visible cadence and never publishes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const error of [new Error("offline"), new ServicesError("GRANT_REQUIRED", 403), new ServicesError("SERVICE_UNAVAILABLE", 503)]) {
    let opens = 0;
    let writes = 0;
    const lease = new KnowledgeEditingSession(scope, {
      open: async () => { opens++; throw error; },
      readDesktop: async () => false,
      publish: async () => { writes++; },
      observe: () => {},
    });
    t.mock.timers.tick(5000); // no successful save (including failed local saves)
    assert.equal(opens, 0);
    assert.equal(lease.committed(), undefined, "advice cannot block the durable commit notification");
    t.mock.timers.tick(400);
    await turn();
    assert.equal(opens, 1);
    lease.committed();
    t.mock.timers.tick(400);
    await turn();
    assert.equal(opens, 1);
    t.mock.timers.tick(5000);
    await turn();
    assert.equal(opens, 2);
    assert.equal(writes, 0);
    lease.setVisible(false);
    t.mock.timers.tick(15000);
    assert.equal(opens, 2);
    lease.retire();
  }
});

test("retired or hidden PUT410 never opens a new reservation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const retired of [false, true]) {
    const oldPut = deferred<void>();
    let opens = 0;
    const lease = new KnowledgeEditingSession(scope, {
      open: async () => { opens++; return "server-a"; },
      readDesktop: async () => false,
      publish: (_scope, _token, _gen, editing) => editing ? oldPut.promise : Promise.resolve(),
      observe: () => {},
    });
    lease.committed();
    t.mock.timers.tick(400);
    await turn();
    if (retired) lease.retire(); else lease.setVisible(false);
    oldPut.reject(new ServicesError("CURSOR_TOO_OLD", 410));
    await turn();
    t.mock.timers.tick(15000);
    assert.equal(opens, 1);
    lease.retire();
  }
});

test("synchronous effect refusals cannot escape commit timers or retirement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const failOpen of [true, false]) {
    const lease = new KnowledgeEditingSession(scope, {
      open: () => {
        if (failOpen) throw new ServicesError("GRANT_REQUIRED", 403);
        return Promise.resolve("server-a");
      },
      readDesktop: async () => false,
      publish: () => { throw new ServicesError("SERVICE_UNAVAILABLE", 503); },
      observe: () => {},
    });
    lease.committed();
    assert.doesNotThrow(() => t.mock.timers.tick(400));
    await turn();
    assert.doesNotThrow(() => lease.retire());
    await turn();
  }
});

test("read-only never opens a lease; successful saves lazily publish only the server token", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let opens = 0;
  const writes: Array<[string, number, boolean]> = [];
  const effects: EditingEffects = {
    open: async () => { opens++; return "server-token"; },
    readDesktop: async () => false,
    publish: async (_scope, session, gen, editing) => { writes.push([session, gen, editing]); },
    observe: () => {},
  };
  const lease = new KnowledgeEditingSession(scope, effects);
  await turn();
  t.mock.timers.tick(5000);
  assert.deepEqual(writes, []);
  assert.equal(opens, 0);
  lease.committed();
  t.mock.timers.tick(399);
  assert.deepEqual(writes, []);
  lease.committed();
  t.mock.timers.tick(400);
  await turn();
  assert.equal(opens, 1);
  assert.deepEqual(writes, [["server-token", 1, true]]);
  t.mock.timers.tick(5000);
  await turn();
  assert.deepEqual(writes, [["server-token", 1, true], ["server-token", 2, true]]);
  lease.retire();
  assert.deepEqual(writes.at(-1), ["server-token", 3, false]);
  t.mock.timers.tick(15000);
  assert.equal(writes.length, 3);
});

test("background releases a pending publish and foreground uses a fresh server token", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let opens = 0;
  const oldPut = deferred<void>();
  const writes: Array<[string, number, boolean]> = [];
  const lease = new KnowledgeEditingSession(scope, {
    open: async () => `server-${++opens}`,
    readDesktop: async () => true,
    publish: async (_scope, token, gen, editing) => {
      writes.push([token, gen, editing]);
      if (token === "server-1" && gen === 1) await oldPut.promise;
    },
    observe: () => {},
  });
  lease.committed();
  t.mock.timers.tick(400);
  await turn();
  lease.setVisible(false);
  assert.deepEqual(writes, [["server-1", 1, true], ["server-1", 2, false]]);
  t.mock.timers.tick(15000);
  assert.equal(writes.length, 2);
  lease.committed(); // a late successful local save cannot renew in background
  t.mock.timers.tick(5000);
  assert.equal(writes.length, 2);
  lease.setVisible(true);
  await turn();
  assert.deepEqual(writes.at(-1), ["server-2", 1, true]);
  oldPut.resolve();
  await turn();
  t.mock.timers.tick(5000);
  assert.deepEqual(writes.at(-1), ["server-2", 2, true]);
  lease.retire();
  assert.deepEqual(writes.at(-1), ["server-2", 3, false]);
  await turn();
});

test("retired or hidden late read cannot paint; new foreground read can complete first", async () => {
  const reads: Array<(value: boolean) => void> = [];
  const observed: boolean[] = [];
  const lease = new KnowledgeEditingSession(scope, {
    open: async () => { throw new Error("read-only must not open"); },
    readDesktop: () => new Promise(resolve => reads.push(resolve)),
    publish: async () => {},
    observe: (_scope, editing) => observed.push(editing),
  });
  lease.setVisible(false);
  lease.setVisible(true);
  reads[1](false);
  await turn();
  reads[0](true);
  await turn();
  assert.deepEqual(observed, [false]);
  lease.setVisible(false);
  lease.setVisible(true);
  lease.retire();
  reads[2](true);
  await turn();
  assert.deepEqual(observed, [false]);
});

test("offline advice clears and failed PUT does not reopen or block the local commit signal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const observed: boolean[] = [];
  let calls = 0;
  const lease = new KnowledgeEditingSession(scope, {
    open: async () => "server-a",
    readDesktop: async () => { throw new Error("unavailable"); },
    publish: async () => { calls++; throw new Error("revoked"); },
    observe: (_scope, editing) => observed.push(editing),
  });
  await turn();
  assert.deepEqual(observed, [false]);
  lease.committed();
  t.mock.timers.tick(400);
  await turn();
  assert.equal(calls, 1);
  lease.retire();
  await turn();
  t.mock.timers.tick(15000);
  assert.equal(calls, 2); // one release attempt, server lease expires if offline
});

test("editing hint waits for the current successful true-publish receipt, not the local save or open", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const published = deferred<boolean>();
  const hints: string[] = [];
  const lease = new KnowledgeEditingSession(scope, {
    open: async () => "server-a",
    readDesktop: async () => false,
    publish: (_scope, _token, _generation, editing) => editing ? published.promise : Promise.resolve(false),
    observe: () => {},
  }, true, (_scope, hint) => hints.push(hint));
  try {
    lease.committed(); t.mock.timers.tick(400); await turn();
    assert.equal(hints.at(-1), "waiting");
    assert.equal(hints.includes("sent"), false);
    published.resolve(true); await turn();
    assert.equal(hints.at(-1), "sent");
    lease.retire();
    assert.equal(hints.at(-1), "disabled");
  } finally { lease.retire(); }
});

test("background disables a waiting hint and a late open cannot restore it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const opened = deferred<string>();
  const hints: string[] = [];
  const lease = new KnowledgeEditingSession(scope, {
    open: () => opened.promise, readDesktop: async () => false,
    publish: async () => true, observe: () => {},
  }, true, (_scope, hint) => hints.push(hint));
  try {
    lease.committed(); t.mock.timers.tick(400);
    lease.setVisible(false);
    assert.equal(hints.at(-1), "disabled");
    opened.resolve("late-open"); await turn();
    assert.equal(hints.at(-1), "disabled");
  } finally { lease.retire(); }
});

test("current open or publish refusal reports only a fixed unavailable hint", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const failOpen of [true, false]) {
    const hints: string[] = [];
    const lease = new KnowledgeEditingSession(scope, {
      open: async () => { if (failOpen) throw new Error("private raw error"); return "server-a"; },
      readDesktop: async () => false,
      publish: async () => { throw new Error("private raw error"); }, observe: () => {},
    }, true, (_scope, hint) => hints.push(hint));
    try {
      lease.committed(); t.mock.timers.tick(400); await turn();
      assert.equal(hints.at(-1), "unavailable");
      assert.equal(hints.includes("sent"), false);
      assert.ok(hints.every(h => ["waiting", "unavailable", "disabled"].includes(h)));
    } finally { lease.retire(); }
  }
});

test("older generation ACK or error cannot overwrite the current sent hint", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const lateError of [false, true]) {
    const old = deferred<boolean>();
    const hints: string[] = [];
    const lease = new KnowledgeEditingSession(scope, {
      open: async () => "server-a", readDesktop: async () => false,
      publish: (_scope, _token, gen) => gen === 1 ? old.promise : Promise.resolve(true),
      observe: () => {},
    }, true, (_scope, hint) => hints.push(hint));
    try {
      lease.committed(); t.mock.timers.tick(400); await turn();
      t.mock.timers.tick(5000); await turn();
      assert.equal(hints.at(-1), "sent");
      const count = hints.length;
      if (lateError) old.reject(new Error("late old error")); else old.resolve(true);
      await turn();
      assert.equal(hints.length, count);
      assert.equal(hints.at(-1), "sent");
    } finally { lease.retire(); }
  }
});

test("Done or owner replacement disables advice and ignores late publish settlement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const lateError of [false, true]) {
    const pending = deferred<boolean>();
    const hints: Array<[string, string]> = [];
    const observe = (owner: typeof scope, hint: string) => { hints.push([owner.instance, hint]); };
    const old = new KnowledgeEditingSession(scope, {
      open: async () => "server-a", readDesktop: async () => false,
      publish: (_scope, _token, _gen, editing) => editing ? pending.promise : Promise.resolve(false),
      observe: () => {},
    }, true, observe);
    old.committed(); t.mock.timers.tick(400); await turn();
    old.retire(); // exact Done/unmount cleanup
    assert.deepEqual(hints.at(-1), ["A", "disabled"]);
    const next = new KnowledgeEditingSession({...scope, instance: "B", vault: "other"}, {
      open: async () => "server-b", readDesktop: async () => false,
      publish: async () => true, observe: () => {},
    }, true, observe);
    try {
      next.committed(); t.mock.timers.tick(400); await turn();
      assert.deepEqual(hints.at(-1), ["B", "sent"]);
      const count = hints.length;
      if (lateError) pending.reject(new Error("late A error")); else pending.resolve(true);
      await turn();
      assert.equal(hints.length, count);
      next.setVisible(false);
      assert.deepEqual(hints.at(-1), ["B", "disabled"]);
    } finally { next.retire(); }
  }
});

test("void or inactive receipts cannot claim an editing hint was sent", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const receipt of [false, undefined]) {
    const hints: string[] = [];
    const lease = new KnowledgeEditingSession(scope, {
      open: async () => "server-a", readDesktop: async () => false,
      publish: async () => receipt, observe: () => {},
    }, true, (_scope, hint) => hints.push(hint));
    try {
      lease.committed(); t.mock.timers.tick(400); await turn();
      assert.equal(hints.at(-1), "unavailable");
      assert.equal(hints.includes("sent"), false);
    } finally { lease.retire(); }
  }
});
