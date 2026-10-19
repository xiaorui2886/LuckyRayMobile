// Knowledge Local Notes pager tests (M2.10 FIX-V1 P1-2):
// ONE epoch authority across local → Desktop → local excursions. Desktop mode
// invalidates in-flight Local Note requests and clears rows with an ALIGNED
// generation (never an unrelated zero), so returning to any local filter
// commits its page-1 normally; late responses from the pre-Desktop epoch are
// ignored; load-more after a Desktop return uses the correct next page.
import test from "node:test";
import assert from "node:assert/strict";
import { LocalNotesPager, notesLoadedText } from "../src/services/knowledgeNotesPager.ts";

type PagerCall = { f: any; resolve: (r: any) => void; reject: (e: any) => void };

function controlledPager() {
  const calls: PagerCall[] = [];
  const pager = new LocalNotesPager(
    (f) =>
      new Promise<any>((resolve, reject) => {
        calls.push({ f, resolve, reject });
      }),
    () => {}
  );
  return { pager, calls };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function note(id: string) {
  return { noteId: id, title: `n-${id}` };
}
function notes(from: number, to: number) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(note(`n${i}`));
  return out;
}

test("knowledge pager — loaded/total text is truthful (FIX-V1B P1-C)", () => {
  assert.equal(notesLoadedText(0, 0), null, "nothing loaded -> no text");
  assert.equal(notesLoadedText(0, 120), null, "nothing loaded -> no text");
  assert.equal(notesLoadedText(50, 50), null, "fully loaded -> no fake partial text");
  assert.equal(notesLoadedText(50, 120), "已加载 50 / 共 120", "partially loaded -> truthful text");
  assert.equal(notesLoadedText(100, 120), "已加载 100 / 共 120");
});

test("knowledge pager — local page-1 loaded → Desktop → Local → new Local page-1 commits", async () => {
  const { pager, calls } = controlledPager();
  pager.reload({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].f.page, 1);
  calls[0].resolve({ items: [note("n1")], total: 1, hasMore: false });
  await flush();
  let st = pager.getState();
  assert.equal(st.items.length, 1);
  assert.equal(st.generation, 1);

  pager.enterDesktop(); // clear rows, ALIGNED generation
  st = pager.getState();
  assert.equal(st.items.length, 0, "Desktop clears Local Note rows");
  assert.equal(st.generation, 2, "generation aligned to the epoch — never an unrelated zero");

  pager.reload({}); // back to a local filter — page-1 must commit immediately
  assert.equal(calls.length, 2);
  calls[1].resolve({ items: [note("n2")], total: 1, hasMore: false });
  await flush();
  st = pager.getState();
  assert.equal(st.items.length, 1, "new Local page-1 commits");
  assert.equal(st.items[0].noteId, "n2");
  assert.equal(st.generation, 3);
});

test("knowledge pager — local request A in flight → switch Desktop → late A ignored", async () => {
  const { pager, calls } = controlledPager();
  pager.reload({}); // request A in flight
  assert.equal(calls.length, 1);
  pager.enterDesktop(); // invalidates A
  calls[0].resolve({ items: [note("a1")], total: 1, hasMore: false });
  await flush();
  const st = pager.getState();
  assert.equal(st.items.length, 0, "late A never commits after Desktop");
  assert.equal(st.generation, 2);
});

test("knowledge pager — Desktop → pinned / archive / local transitions remain aligned", async () => {
  const { pager, calls } = controlledPager();
  pager.reload({ pinned: true });
  calls[0].resolve({ items: [note("p1")], total: 1, hasMore: false });
  await flush();
  assert.equal(pager.getState().generation, 1);

  pager.enterDesktop();
  assert.equal(pager.getState().generation, 2);
  pager.reload({ archived: true });
  calls[1].resolve({ items: [note("a1")], total: 1, hasMore: false });
  await flush();
  assert.equal(pager.getState().generation, 3);

  pager.enterDesktop();
  assert.equal(pager.getState().generation, 4);
  pager.reload({});
  calls[2].resolve({ items: [note("l1")], total: 1, hasMore: false });
  await flush();

  const st = pager.getState();
  assert.deepEqual(
    st.items.map((n: any) => n.noteId),
    ["l1"],
    "every local filter commits after a Desktop excursion"
  );
  assert.equal(st.generation, 5, "generation strictly monotonic across all transitions");
});

test("knowledge pager — load-more after returning from Desktop uses the correct next page and generation", async () => {
  const { pager, calls } = controlledPager();
  pager.reload({});
  calls[0].resolve({ items: notes(1, 50), total: 120, hasMore: true });
  await flush();

  pager.enterDesktop();
  pager.reload({});
  calls[1].resolve({ items: notes(1, 50), total: 120, hasMore: true });
  await flush();
  assert.equal(pager.getState().items.length, 50);

  let lm = pager.loadMore({}); // do not await yet — its fetch resolves below
  assert.equal(calls.length, 3);
  assert.equal(calls[2].f.page, 2, "next page after a Desktop return is page 2");
  assert.equal(calls[2].f.limit, 50);
  calls[2].resolve({ items: notes(51, 100), total: 120, hasMore: true });
  await Promise.resolve();
  await lm;
  assert.equal(pager.getState().items.length, 100);

  lm = pager.loadMore({});
  assert.equal(calls.length, 4);
  assert.equal(calls[3].f.page, 3, "subsequent page advances normally");
  calls[3].resolve({ items: notes(101, 120), total: 120, hasMore: false });
  await Promise.resolve();
  await lm;

  const st = pager.getState();
  assert.equal(st.items.length, 120, "all pages append without duplicates");
  assert.equal(st.hasMore, false);
  assert.equal(st.generation, 3, "load-more commits under the current epoch");
  assert.equal(st.loading, false);
});

test("knowledge pager — late load-more response after a filter change is ignored", async () => {
  const { pager, calls } = controlledPager();
  pager.reload({});
  calls[0].resolve({ items: notes(1, 50), total: 120, hasMore: true });
  await flush();

  const lm = pager.loadMore({}); // page 2 of the first filter
  assert.equal(calls.length, 2);
  pager.reload({ archived: true }); // filter change -> new epoch
  calls[1].resolve({ items: [note("a51")], total: 120, hasMore: true });
  await Promise.resolve(); // late load-more resolves
  await lm;
  let st = pager.getState();
  assert.equal(st.items.length, 0, "stale load-more never appends into the new filter");

  calls[2].resolve({ items: [note("ar1")], total: 1, hasMore: false });
  await flush();
  st = pager.getState();
  assert.deepEqual(
    st.items.map((n: any) => n.noteId),
    ["ar1"],
    "new filter's page-1 commits normally"
  );
});
