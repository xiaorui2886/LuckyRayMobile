import test from "node:test";
import assert from "node:assert/strict";
import { ManagedSyncSchedule, type ManagedSyncTarget } from "../src/services/managedSyncSchedule.ts";
import { SyncCoordinator } from "../src/services/syncCoordinator.ts";
import { desktopLibraries } from "../src/services/desktopLibraries.ts";
const target = (vaultId: string, pendingCount = 1, instanceId = "desktop"): ManagedSyncTarget => ({ instanceId, vaultId, localVaultId: `local-${vaultId}`, pendingCount });
const memory = () => { const map = new Map<string,string>(); return { getItem: (key: string) => map.get(key) || null, setItem: (key: string,value: string) => { map.set(key,value); } }; };

test("persisted round robin prioritizes pending while pull-only scopes cannot starve", () => {
  const store = memory(); const targets = [target("A"),target("B"),target("C",0)];
  const first = new ManagedSyncSchedule(store, () => 1000);
  assert.equal(first.choose("desktop", targets)?.vaultId, "A");
  const restored = new ManagedSyncSchedule(store, () => 1000);
  assert.equal(restored.choose("desktop", targets)?.vaultId, "B");
  const seen = new Set(Array.from({length:9}, () => restored.choose("desktop", targets)?.vaultId));
  assert.ok(seen.has("C"));
  const onlyA = new ManagedSyncSchedule(undefined, () => 1000);
  const scopes = [target("A"),target("B",0),target("C",0)];
  assert.ok(new Set(Array.from({length:9}, () => onlyA.choose("desktop", scopes)?.vaultId)).has("C"));
});

test("busy A yields to B; backoff and global 429 survive restart", () => {
  const store = memory(); let now = 1000; const targets = [target("A"),target("B")];
  const schedule = new ManagedSyncSchedule(store, () => now);
  const a = schedule.choose("desktop", targets)!;
  schedule.complete("desktop",a,true,true);
  assert.equal(schedule.choose("desktop",targets)?.vaultId,"B");
  schedule.fail("desktop", targets[1], "CONTENT_HTTP_429");
  const restored = new ManagedSyncSchedule(store, () => now);
  assert.equal(restored.choose("desktop",targets),undefined);
  now += 30001;
  assert.ok(restored.choose("desktop",targets));
  assert.equal(restored.choose("other",targets),undefined);
});

test("queued A is ACKed without changing visible selection, then B progresses", async () => {
  const targets = [target("A"),target("B")]; const calls: string[] = [];
  await desktopLibraries.refresh("desktop", async () => ({ scopeSelectionVersion:1, materials:[], knowledge:["A","B"].map(vaultId => ({vaultId,displayName:vaultId,activeInDesktop:vaultId === "A",available:true,readGranted:true,writeGranted:true,ingestGranted:false})) }));
  desktopLibraries.select("desktop","knowledge","B");
  const before = desktopLibraries.snapshot("desktop");
  assert.equal(before.vault,"B");
  const c = new SyncCoordinator(async (instance,vault) => {
    calls.push(vault!); targets.find(t => t.vaultId === vault)!.pendingCount = 0;
    return {instanceId:instance,vaultId:vault,pushed:1};
  }, {foundationBlocked:false,contentOnly:true,managed:{targets:async () => ({items:targets}),storage:memory(),now:()=>1000}});
  c.setOwner("desktop");
  try { await c.run(); await c.run(); assert.deepEqual(calls,["A","B"]); assert.equal(targets[0].pendingCount,0); assert.equal(desktopLibraries.snapshot("desktop"),before); }
  finally { c.dispose(); }
});

test("owner changes fence enumeration and late ACKs; never dispatch foreign targets", async () => {
  let resolve!: (result: {items:ManagedSyncTarget[]}) => void; const calls: string[] = [];
  const c = new SyncCoordinator(async (instance,vault) => { calls.push(`${instance}:${vault}`); return {instanceId:instance,vaultId:vault}; }, {
    foundationBlocked:false,contentOnly:true,managed:{targets: () => new Promise(r => {resolve=r;})},
  });
  c.setOwner("desktop"); const running = c.run(); c.setOwner("other"); resolve({items:[target("A")]}); await running;
  assert.deepEqual(calls,[]); assert.equal(c.snapshot().status,"idle"); c.dispose();
  let ack!: (value: unknown) => void;
  const d = new SyncCoordinator(() => new Promise(r => {ack=r;}),{foundationBlocked:false,contentOnly:true,managed:{targets:async () => ({items:[target("A")]})}});
  d.setOwner("desktop"); const p = d.run(); await Promise.resolve(); await Promise.resolve();
  d.setOwner("other"); ack({instanceId:"desktop",vaultId:"A",desktopBusyNoteIds:["old"],pushed:1}); await p;
  assert.deepEqual(d.snapshot().desktopBusyNotes,[]); d.dispose();
});

test("revoked binding is omitted on next enumeration, no persisted queue resurrects it", async () => {
  let items = [target("A"),target("B")]; const calls: string[] = [];
  const c = new SyncCoordinator(async (_instance,vault) => {calls.push(vault!); throw new Error("CONTENT_SOURCE_CHANGED");}, {
    foundationBlocked:false,contentOnly:true,managed:{targets:async () => ({items}),storage:memory()},
  });
  c.setOwner("desktop"); try { await c.run(); items = [target("B")]; await c.run(); assert.deepEqual(calls,["A","B"]); items=[]; await c.run(); assert.deepEqual(calls,["A","B"]); } finally {c.dispose();}
});

test("single flight coalesces callers and persisted eligibility cannot be bypassed by wake", async () => {
  let calls=0; const targets=[target("A")];
  const c = new SyncCoordinator(async () => {calls++; throw new Error("CONTENT_HTTP_429");}, {foundationBlocked:false,contentOnly:true,managed:{targets:async () => ({items:targets}),now:()=>1000}});
  c.setOwner("desktop"); try { const a=c.run(),b=c.run(); assert.equal(a,b); await a; await c.run(); assert.equal(calls,1); } finally {c.dispose();}
});


test("401/403 retirement persists and ordinary wake cannot bypass it, grant change resumes", () => {
  const store=memory(); const targets=[target("A"),target("B")];
  const schedule=new ManagedSyncSchedule(store,()=>1000);
  schedule.fail("desktop",targets[0],"CONTENT_MUTATION_HTTP_403 [SCOPE_DENIED]");
  const restored=new ManagedSyncSchedule(store,()=>100000);
  for(let i=0;i<6;i++) assert.equal(restored.choose("desktop",targets)?.vaultId,"B");
  assert.equal(restored.delay("desktop",[targets[0]]),undefined);
  restored.authorizationChanged("desktop");
  assert.equal(restored.choose("desktop",[targets[0]])?.vaultId,"A");
});

test("post-commit mutation burst coalesces and foreign-instance event never wakes", async () => {
  let calls=0;
  const c = new SyncCoordinator(async(instance,vault)=> {calls++; return {instanceId:instance,vaultId:vault};}, {foundationBlocked:false,contentOnly:true,managed:{targets:async()=>({items:[target("A")]})}});
  c.setOwner("desktop");
  try {
    c.localMutation("other"); await new Promise(r=>setTimeout(r,720)); assert.equal(calls,0);
    c.localMutation("desktop"); c.localMutation("desktop"); c.localMutation("desktop");
    assert.equal(calls,0); await new Promise(r=>setTimeout(r,730)); assert.equal(calls,1);
  } finally {c.dispose();}
});

test("same-instance reauthorization fences old rejected attempt without losing persisted position", async () => {
  let rejectOld!: (e: Error) => void; let calls=0; const visited: string[]=[];
  const c=new SyncCoordinator(async(instance,vault)=> {
    visited.push(vault!);
    if (++calls===1) return new Promise((_r,reject)=> {rejectOld=reject;});
    return {instanceId:instance,vaultId:vault,pushed:1};
  }, {foundationBlocked:false,contentOnly:true,managed:{targets:async()=>({items:[target("A"),target("B")]}),storage:memory()}});
  c.setOwner("desktop");
  try {
    const old=c.run(); await Promise.resolve(); await Promise.resolve();
    c.authorizationChanged("desktop"); rejectOld(new Error("CONTENT_HTTP_401")); await old; await c.run();
    assert.deepEqual(visited,["A","B"]); assert.equal(c.snapshot().error,null);
  } finally {c.dispose();}
});

test("401 retires connection, 403 only its scope, neither deletes queue metadata", () => {
  const store=memory();const targets=[target("A"),target("B")];
  const schedule=new ManagedSyncSchedule(store,()=>1000);
  schedule.choose("desktop",targets);schedule.fail("desktop",targets[0],"CONTENT_HTTP_401");
  const restored=new ManagedSyncSchedule(store,()=>100000);
  assert.equal(restored.choose("desktop",targets),undefined);
  restored.authorizationChanged("desktop");
  assert.equal(restored.choose("desktop",targets)?.vaultId,"B");
  assert.equal(targets[0].pendingCount,1);
});


test("native deferred move eligibility survives restart and wake does not busy-loop", () => {
  const store=memory(); let now=1000; const t=target("A");
  const schedule=new ManagedSyncSchedule(store,()=>now);
  schedule.complete("desktop",t,true,false,60000);
  const restored=new ManagedSyncSchedule(store,()=>now);
  assert.equal(restored.choose("desktop",[t]),undefined);
  assert.equal(restored.delay("desktop",[t]),60000);
  now+=60000; assert.equal(restored.choose("desktop",[t])?.vaultId,"A");
});


test("accepted managed sync refreshes file views, foreign and retired results never do", async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events: string[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: (event: Event) => { events.push(event.type); return true; } } });
  let result: unknown = { instanceId: "desktop", vaultId: "A" };
  const c = new SyncCoordinator(async () => result, { foundationBlocked: false, contentOnly: true, managed: { targets: async () => ({items: [target("A")]}) } });
  c.setOwner("desktop");
  try {
    await c.run(); assert.deepEqual(events, ["luckyray:managed-vault-change"]);
    result = { instanceId: "desktop", vaultId: "foreign" }; await c.run();
    assert.equal(events.length, 1);
  } finally { c.dispose(); if (prior) Object.defineProperty(globalThis, "window", prior); else delete (globalThis as any).window; }
});
