import assert from "node:assert/strict";
import test from "node:test";
import { NoteResourceSession, type ResourceView, type ResourceFile } from "../src/services/noteResourceSession.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const cached = deferred<ResourceFile>();
  const fetched = deferred<ResourceFile>();
  const requests: unknown[][] = [];
  const cancellations: string[] = [];
  const views: ResourceView[] = [];
  const scope = {instance: "owner-a", vault: "vault-a", note: "note-a"};
  const resource = {resourceId: "resource-a", target: "attachments/sample.png", status: "resolved", mimeType: "image/png", version: "v1"};
  const effects = {
    contentCachedResource: async (...args: string[]) => { requests.push(["cache", ...args]); return cached.promise; },
    contentNoteResource: async (...args: string[]) => { requests.push(["fetch", ...args]); return fetched.promise; },
    contentCancel: async (job: string) => { cancellations.push(job); },
  };
  const session = new NoteResourceSession(scope, resource, effects, view => views.push(view));
  return {session, cached, fetched, requests, cancellations, views, scope, resource, effects};
}

test("cancelled attachment cannot publish a late download result", async () => {
  const f = fixture();
  const pending = f.session.download();
  assert.equal(f.views.at(-1)?.busy, true);
  f.session.cancel();
  f.fetched.resolve({path: "old-result.png", mime: "image/png"});
  await pending;
  assert.equal(f.views.at(-1)?.file, null);
  assert.equal(f.views.at(-1)?.busy, false);
  assert.deepEqual(f.cancellations, [f.requests[0][5]]);
  f.session.retire();
});

test("offline reader uses scoped cache without downloading or damaging cached bytes", async () => {
  const f = fixture();
  const offline = new NoteResourceSession(f.scope, f.resource, f.effects, view => f.views.push(view), false);
  const pending = offline.start();
  f.cached.resolve({path: "cached.png", mime: "image/png"});
  f.fetched.resolve({path: "wrong-network.png", mime: "image/png"});
  await pending;
  assert.deepEqual(f.requests, [["cache", "owner-a", "resource-a", "vault-a", "note-a"]]);
  assert.equal(f.views.at(-1)?.file?.path, "cached.png");
  await offline.download();
  assert.equal(f.requests.length, 1);
  offline.retire(); f.session.retire();
});

test("retired reader cannot start a download from a late cache read", async () => {
  const f = fixture();
  const pending = f.session.start();
  f.session.retire();
  f.cached.resolve({path: "late-cache.png", mime: "image/png"});
  await pending;
  assert.equal(f.views.length, 0);
  assert.deepEqual(f.requests, [["cache", "owner-a", "resource-a", "vault-a", "note-a"]]);
});

test("scope replacement cancels only the old job and rejects its result", async () => {
  const f = fixture();
  const pending = f.session.download();
  const oldJob = f.requests[0][5];
  f.session.retire();
  // Next mounted reader may be another owner, vault, note, or editor epoch.
  const nextViews: ResourceView[] = [];
  const next = new NoteResourceSession({instance: "owner-b", vault: "vault-b", note: "note-b"}, f.resource,
    f.effects, view => nextViews.push(view), false);
  const cached = next.start();
  f.cached.resolve({path: "owner-b-cache.png", mime: "image/png"});
  await cached;
  f.fetched.resolve({path: "owner-a-late.png", mime: "image/png"});
  await pending;
  assert.deepEqual(f.cancellations, [oldJob]);
  assert.equal(f.views.at(-1)?.file, null);
  assert.equal(nextViews.at(-1)?.file?.path, "owner-b-cache.png");
  assert.deepEqual(f.requests[1], ["cache", "owner-b", "resource-a", "vault-b", "note-b"]);
  next.retire();
});

test("captured scope cannot be rewritten while an attachment is read", async () => {
  const f = fixture();
  f.scope.instance = "owner-b"; f.scope.vault = "vault-b"; f.scope.note = "note-b";
  f.resource.resourceId = "resource-b";
  f.fetched.resolve({path: "owner-a.png", mime: "image/png"});
  await f.session.download();
  assert.deepEqual(f.requests[0].slice(0, 5), ["fetch", "owner-a", "vault-a", "note-a", "resource-a"]);
  f.session.retire();
});

test("failed revalidation preserves a legitimately cached attachment", async () => {
  const f = fixture();
  const pending = f.session.start();
  f.cached.resolve({path: "cached.png", mime: "image/png"});
  f.fetched.reject(new Error("offline"));
  await pending;
  assert.equal(f.views.at(-1)?.file?.path, "cached.png");
  assert.equal(f.views.at(-1)?.busy, false);
  assert.match(f.views.at(-1)?.message ?? "", /已缓存的内容仍可查看/);
  f.session.retire();
});

test("missing or unpublished descriptors never grant a network resource read", async () => {
  const f = fixture();
  const missing = new NoteResourceSession(f.scope, {...f.resource, status: "missing"}, f.effects, view => f.views.push(view));
  const pending = missing.start();
  f.cached.reject(new Error("not cached"));
  await pending; await missing.download();
  assert.equal(f.requests.length, 1);
  assert.equal(f.views.length, 0);
  missing.retire(); f.session.retire();
});

test("a late cache lookup cannot repaint older bytes after a manual download", async () => {
  const f = fixture();
  const cache = f.session.start();
  const manual = f.session.download();
  f.fetched.resolve({path: "new.png", mime: "image/png"});
  await manual;
  const afterDownload = f.views.length;
  f.cached.resolve({path: "old.png", mime: "image/png"});
  await cache;
  assert.ok(f.views.slice(afterDownload).every(view => view.file?.path !== "old.png"));
  assert.equal(f.requests.filter(req => req[0] === "fetch").length, 1);
  f.session.retire();
});

test('cancel also fences a pending cache read', async()=>{
 const f=fixture();const p=f.session.start();f.session.cancel();const n=f.views.length;
 f.cached.resolve({path:'cancelled-cache.png',mime:'image/png'});await p;
 assert.equal(f.views.length,n);assert.equal(f.requests.length,1);f.session.retire();
});
test('offline transition keeps displayed cache and fences background response',async()=>{
 const f=fixture();const p=f.session.start();f.cached.resolve({path:'cached.png',mime:'image/png'});
 await new Promise(resolve=>setTimeout(resolve,0));f.session.setOnline(false);
 f.fetched.resolve({path:'late.png',mime:'image/png'});await p;
 assert.equal(f.views.at(-1)?.file?.path,'cached.png');assert.equal(f.views.at(-1)?.busy,false);
 f.session.setOnline(false);assert.equal(f.requests.length,2);f.session.retire();
});
test('going offline during initial cache lookup still obtains offline cache without network',async()=>{
 const f=fixture();const p=f.session.start();f.session.setOnline(false);
 f.cached.resolve({path:'offline-cache.png',mime:'image/png'});await p;await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(f.views.at(-1)?.file?.path,'offline-cache.png');assert.equal(f.requests.filter(r=>r[0]==='fetch').length,0);f.session.retire();
});
