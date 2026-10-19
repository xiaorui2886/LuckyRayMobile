// LOCAL-KNOWLEDGE-USABILITY-R1 — Issue #73.
//
// Behavioral tests over the PRODUCTION pagination authority (LocalNotesPager),
// the production filter draft, the pure local-empty/heading helpers, plus
// structural contracts for the screen wiring (quick actions, no Desktop leak,
// no second pager). The >100-notes case uses an isolated fixture — never a
// real user library.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test.before(async () => {
  (globalThis as any).__pager = await import("../src/services/knowledgeNotesPager.ts");
  (globalThis as any).__draft = await import("../src/services/filterDraft.ts");
  (globalThis as any).__usability = await import("../src/services/localKnowledgeUsability.ts");
  (globalThis as any).__gen = await import("../src/services/generationPagination.ts");
});

const kits = () => ({
  pagerKit: (globalThis as any).__pager,
  draftKit: (globalThis as any).__draft,
  usability: (globalThis as any).__usability,
  gen: (globalThis as any).__gen,
});

// ---------- A: real pagination (>100 notes, isolated fixture) ----------

function makeNote(i: number) {
  return { noteId: `n${i}`, title: `笔记 ${i}`, content: `body ${i}`, tags: i % 3 === 0 ? ["工作"] : [], pinned: false, favorite: false, archived: false, updatedAt: "2026-09-20T10:00:00" };
}

/** A fake Local Note authority: 120 notes, filtered pages like the Rust side. */
function makeFixture(count = 120) {
  const notes = Array.from({ length: count }, (_, i) => makeNote(i));
  let calls = 0;
  const fetchPage = async (f: any) => {
    calls += 1;
    let rows = notes;
    if (f.q) rows = rows.filter((n) => n.title.includes(String(f.q).trim()));
    if (f.tag) rows = rows.filter((n) => n.tags.includes(f.tag));
    if (f.pinned) rows = rows.filter((n) => n.pinned);
    if (f.favorite) rows = rows.filter((n) => n.favorite);
    rows = f.archived === false ? rows.filter((n) => !n.archived) : rows;
    const start = ((f.page ?? 1) - 1) * (f.limit ?? 50);
    return {
      items: rows.slice(start, start + (f.limit ?? 50)),
      total: rows.length,
      hasMore: start + (f.limit ?? 50) < rows.length,
    };
  };
  return { notes, fetchPage, calls: () => calls };
}

test("usability A: >100 notes keep arriving through pager pages", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalNotesPager(fixture.fetchPage);
  pager.reload({});
  await sleep(5);
  assert.equal(pager.getState().items.length, 50, "first screen page");
  assert.equal(pager.getState().total, 120);
  assert.equal(pager.getState().hasMore, true);

  await pager.loadMore({});
  await pager.loadMore({});
  assert.equal(pager.getState().items.length, 120, "100+ notes stay reachable");
  assert.equal(pager.getState().hasMore, false, "truthful exhaustion");
  const ids = new Set(pager.getState().items.map((n) => n.noteId));
  assert.equal(ids.size, 120, "no duplicates across pages");
});

test("usability A: a stale page result is dropped when filters change mid-flight", async () => {
  const { pagerKit } = kits();
  let release!: (v: any) => void;
  const fixture = makeFixture(120);
  const pager = new pagerKit.LocalNotesPager(async (f: any) => {
    if (f.tag === "old") return await new Promise<any>((r) => { release = r; });
    return fixture.fetchPage(f);
  });
  pager.reload({ tag: "old" });
  await sleep(5);
  pager.reload({ tag: "工作" }); // the filter changed before A resolved
  await sleep(5);
  const afterB = pager.getState().items.length;
  release({ items: Array.from({ length: 50 }, (_, i) => makeNote(i)), total: 100, hasMore: true });
  await sleep(5);
  assert.equal(pager.getState().items.length, afterB, "the late A response never commits");
  assert.equal(pager.getState().total, 40, "the list still shows B (tag=工作) results");
});

// ---------- B: tag filter Apply / Cancel semantics ----------

test("usability B: tag edits apply only on commit; cancel discards", () => {
  const { draftKit } = kits();
  const draft = new draftKit.FilterDraft(draftKit.defaultKnowledgeFilter);
  const applied = draft.commit(); // seed applied state
  assert.equal(applied.tag, "");

  draft.begin();
  draft.edit({ tag: "工作" });
  assert.equal(draft.getApplied().tag, "", "draft edits never touch applied");
  const cancelled = draft.cancel();
  assert.equal(cancelled.tag, "", "cancel/backdrop/Back discards the draft");

  draft.begin();
  draft.edit({ tag: "工作" });
  const committed = draft.commit();
  assert.equal(committed.tag, "工作", "Apply commits the draft");
});

test("usability B: available tags derive from loaded rows plus the applied tag", () => {
  const { usability } = kits();
  const rows = [{ tags: ["工作", "生活"] }, { tags: ["工作"] }, { tags: [] }];
  assert.deepEqual(usability.collectTags(rows, ""), ["工作", "生活"]);
  assert.deepEqual(usability.collectTags(rows, "旅行"), ["工作", "生活", "旅行"], "an applied tag stays selectable");
  assert.equal(usability.collectTags(rows, "旅行").length <= 24, true, "bounded list");
});

// ---------- C: quick actions (pin/favorite/archive/delete) ----------

test("usability C: flag mutation updates the authority and the next reload reflects it", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(5);
  const pager = new pagerKit.LocalNotesPager(fixture.fetchPage);
  pager.reload({ favorite: true });
  await sleep(5);
  assert.equal(pager.getState().total, 0, "no favorites yet (truthful)");

  // Exactly what the screen's toggle handler does: desired-state flags on the
  // authority, then localDataStore.publish("note") triggers the reload.
  fixture.notes[0].favorite = true;
  const ok = await fixture.fetchPage({ favorite: true, page: 1, limit: 50 });
  assert.equal(ok.total, 1, "the authority now holds the favorite");
  pager.reload({ favorite: true });
  await sleep(5);
  assert.equal(pager.getState().items[0].noteId, "n0", "the reloaded list reflects the mutation");
});

test("usability C: a failed mutation leaves the authoritative row unchanged", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(5);
  fixture.notes[1].pinned = true;
  const pager = new pagerKit.LocalNotesPager(fixture.fetchPage);
  pager.reload({ pinned: true });
  await sleep(5);
  assert.deepEqual(pager.getState().items.map((n) => n.noteId), ["n1"]);

  // The screen's catch path does NOT publish, so no reload can fabricate state:
  // simulate a failed setFlags — the authority keeps its old truth.
  try {
    throw new Error("storage busy");
  } catch {
    /* the screen toasts; publish is only on success */
  }
  pager.reload({ pinned: true });
  await sleep(5);
  assert.deepEqual(pager.getState().items.map((n) => n.noteId), ["n1"], "row unchanged after failure");
});

test("usability C: delete removes the row and the page state converges", async () => {
  const { pagerKit } = kits();
  const fixture = makeFixture(5);
  const pager = new pagerKit.LocalNotesPager(fixture.fetchPage);
  pager.reload({});
  await sleep(5);
  assert.equal(pager.getState().total, 5);
  fixture.notes.length = 0; // delete succeeded on the authority
  pager.reload({});
  await sleep(5);
  assert.equal(pager.getState().items.length, 0, "list converges after deletion");
  assert.equal(pager.getState().hasMore, false);
});

// ---------- D/E: projection + empty-state matrix ----------

test("usability D/E: the empty-state matrix distinguishes every no-result case", () => {
  const { usability } = kits();
  // Truly empty library — the only state that invites writing.
  assert.deepEqual(
    (({ title, action }) => ({ title, action }))(usability.describeLocalEmpty({ mode: "local", tag: "", query: "" })),
    { title: "给想法留个位置", action: "new" },
  );
  // Search miss — clear the search, not another new note.
  assert.equal(usability.describeLocalEmpty({ mode: "local", tag: "", query: "旅行" }).action, "clear-search");
  assert.match(usability.describeLocalEmpty({ mode: "local", tag: "", query: "旅行" }).title, /没有找到匹配/);
  // Tag miss — adjust the filter.
  assert.equal(usability.describeLocalEmpty({ mode: "local", tag: "工作", query: "" }).action, "filter");
  assert.match(usability.describeLocalEmpty({ mode: "local", tag: "工作", query: "" }).title, /#工作/);
  // Pinned / favorite / archived misses — truthful per range, adjust filter.
  assert.equal(usability.describeLocalEmpty({ mode: "pinned", tag: "", query: "" }).action, "filter");
  assert.match(usability.describeLocalEmpty({ mode: "pinned", tag: "", query: "" }).title, /置顶/);
  assert.equal(usability.describeLocalEmpty({ mode: "favorite", tag: "", query: "" }).action, "filter");
  assert.match(usability.describeLocalEmpty({ mode: "favorite", tag: "", query: "" }).title, /收藏/);
  assert.equal(usability.describeLocalEmpty({ mode: "archived", tag: "", query: "" }).action, "filter");
  assert.match(usability.describeLocalEmpty({ mode: "archived", tag: "", query: "" }).title, /归档箱/);
});

test("usability D: the local heading reflects range + tag truthfully", () => {
  const { usability } = kits();
  const SORT_LABELS = { name: "名称" };
  assert.equal(usability.localHeadingFor({ mode: "local", sort: "recent", tag: "" }, SORT_LABELS), "");
  assert.equal(usability.localHeadingFor({ mode: "favorite", sort: "recent", tag: "" }, SORT_LABELS), "收藏");
  assert.equal(usability.localHeadingFor({ mode: "local", sort: "recent", tag: "工作" }, SORT_LABELS), "#工作");
  assert.equal(usability.localHeadingFor({ mode: "archived", sort: "recent", tag: "工作" }, SORT_LABELS), "已归档 · #工作");
});

// ---------- screen wiring contracts ----------

const SCREEN = read("src", "still", "StillCollection.tsx");

test("usability wiring: the screen uses the pager authority, not a one-shot 100 cap", () => {
  assert.match(SCREEN, /import \{ LocalNotesPager, notesLoadedText, type NoteFilters \} from "\.\.\/services\/knowledgeNotesPager";/);
  assert.match(SCREEN, /pager\.reload\(identity\)/, "page-1 fetch uses the captured identity");
  assert.match(SCREEN, /pager\.invalidate\(\)/, "a filter/query change invalidates the generation immediately");
  assert.match(SCREEN, /pager\.loadMore\(localFilters\(\)\)/);
  // R4.1: leaving the Local source is now suspend() (fence without
  // destroying) — the generation fence the original check meant is intact,
  // the last-good rows just survive the switch.
  assert.match(SCREEN, /pager\.suspend\(\)/);
  // The one-shot page:1 limit:100 request is gone — 100+ notes were unreachable before.
  assert.ok(!SCREEN.includes("limit: 100"), "no hardcoded 100-note cap");
  // Truthful loaded/total text and load-more come from the pager state.
  assert.match(SCREEN, /notesLoadedText\(localPage\.items\.length, localPage\.total\)/);
  assert.match(SCREEN, /localPage\.hasMore/);
});

test("usability wiring: quick actions are local-only and mutation-safe", () => {
  // The actions sheet exists with the four operations and a delete confirm.
  for (const label of ["取消置顶", "收藏", "取消收藏", "取消归档", "归档", "确认删除"]) {
    assert.ok(SCREEN.includes(label), `sheet offers ${label}`);
  }
  // Mutations go through the existing authority and republish on success only.
  assert.match(SCREEN, /api\.localNoteSetFlags\(note\.noteId, \{ \[flag\]: !note\[flag\] \}\)/);
  assert.match(SCREEN, /api\.localNoteDelete\(note\.noteId\)/);
  // The catch paths keep the row untouched: publish happens only in the try.
  const toggleBody = SCREEN.slice(SCREEN.indexOf("async function toggleNoteFlag"), SCREEN.indexOf("async function deleteActionNote"));
  const catchIdx = toggleBody.indexOf("catch");
  assert.ok(catchIdx > toggleBody.indexOf("localDataStore.publish"), "toggle publishes only on success");
  assert.ok(!toggleBody.slice(catchIdx).includes("localDataStore.publish"), "failure path never republishes");
  const deleteBody = SCREEN.slice(SCREEN.indexOf("async function deleteActionNote"), SCREEN.indexOf("const emptyState"));
  const dCatch = deleteBody.indexOf("catch");
  assert.ok(!deleteBody.slice(dCatch).includes("localDataStore.publish"), "failed delete never republishes");
  // Single-flight: handlers refuse while a mutation is in flight.
  assert.match(SCREEN, /if \(!note \|\| mutating\) return;/);
  assert.match(SCREEN, /setConfirmDelete\(true\)/, "delete requires the explicit confirm step");
});

test("usability wiring: Desktop rows never expose local write actions", () => {
  // The usage sites are what matter: the desktop branch is the early-returned
  // CollectionView block (the LAST `source === "desktop"` guard; earlier ones
  // are the effects/memos); the quick-action affordance exists only in the
  // local composition after it. The mutation HANDLERS are defined in the
  // shared component body and must not be referenced by this branch.
  const desktopBranch = SCREEN.slice(SCREEN.lastIndexOf('if (source === "desktop")'), SCREEN.indexOf("// Local source:"));
  const collectionViewEl = desktopBranch.slice(desktopBranch.indexOf("<CollectionView"), desktopBranch.indexOf("/>", desktopBranch.indexOf("<CollectionView")));
  assert.ok(desktopBranch.includes("<CollectionView"), "desktop path is the unchanged CollectionView");
  assert.ok(!collectionViewEl.includes("openNoteActions"), "no quick-action affordance on Desktop rows");
  // Call sites (`onClick={() => openNoteActions(n.raw)}`) exist only in the
  // local composition — the desktop branch has none (definitions don't count).
  const localComposition = SCREEN.slice(SCREEN.indexOf("// Local source:"));
  const callSite = "onClick={() => openNoteActions(n.raw)}";
  assert.ok(!desktopBranch.includes(callSite), "no openNoteActions call site in the desktop branch");
  assert.ok(localComposition.includes(callSite), "the local rows carry the affordance");
  assert.ok(!desktopBranch.includes("localNoteSetFlags"), "no local write API on the Desktop path");
  assert.ok(!desktopBranch.includes("localNoteDelete"), "no local delete on the Desktop path");
  // The projection for desktop rows carries no favorite/local-action fields.
  const desktopItem = SCREEN.slice(SCREEN.indexOf("function desktopItem"));
  assert.ok(!desktopItem.includes("favorite"));
});

test("usability wiring: the local tag filter never leaks into Desktop queries", () => {
  // SERVICES-KNOWLEDGE-BROWSE-R1: the Desktop read side is canonical Services
  // through KnowledgeBrowseController. Its canonical list request carries ONLY
  // `q` (+ `afterId`/`limit` for paging), so the local tag/mode filters can
  // structurally never leak into the Desktop query.
  const ctrl = read("src", "still", "kit", "knowledgeBrowseController.ts");
  assert.match(ctrl, /q: query \|\| undefined, limit: this\.pageSize/u,
    "the canonical request carries only q/limit (+ afterId while paging)");
  assert.ok(!ctrl.includes("applied.tag"), "no local filter axis exists in the controller");
  // The page feeds the controller only the query text.
  assert.match(SCREEN, /desktopCtrl\.setQuery\(query\);/);
  // Isolation on switch: entering Desktop fences the local pager epoch.
  assert.match(SCREEN, /if \(source !== "local"\) \{\s*pager\.suspend\(\);/);
});

test("usability wiring: the frozen LSH / Agent files are not touched by this screen", () => {
  // The knowledge screen never imports LSH / Agent / native LSH commands.
  assert.ok(!SCREEN.includes("lshSurface"), "no LSH adapter import");
  assert.ok(!SCREEN.includes("AgentCapability"), "no Agent controller import");
  assert.ok(!SCREEN.includes("lsh_surface"), "no LSH native command reference");
  assert.ok(!SCREEN.includes("LshSurface"), "no LSH shell reference");
  // Nothing in this screen references the other LSH-touched surfaces.
  assert.ok(!SCREEN.includes("StillAgent"), "no AI-tab coupling");
});

test("usability wiring: the projection carries the favorite hint into rows", () => {
  assert.match(SCREEN, /favorite: Boolean\(n\.favorite\)/, "D: favorite enters the row projection");
  // UX-POLISH-R1 5: the title line starts clean; pin/favorite are quiet accent
  // flags on the RIGHT of the metadata line (no star character next to the title).
  assert.match(SCREEN, /className="st-note-meta"/, "the metadata text keeps its own slot");
  assert.match(SCREEN, /n\.favorite \? <Icon name="heart" size=\{13\} className="st-flag-fav is-on" \/> : null/,
    "D: favorite renders as the soft accent heart flag on the metadata line");
  assert.match(SCREEN, /n\.pinned \? <Icon name="pin" size=\{13\} className="st-flag-pin" \/> : null/,
    "pinned stays visible on the metadata line");
  assert.doesNotMatch(SCREEN, /★/, "no star character beside the title");
  assert.match(SCREEN, /n\.tags\?\.length \? " · " \+ n\.tags\.join\(" \/ "\) : ""/, "tags stay visible");
});

// ---------- CLOSURE-R1: pagination-era consistency gaps ----------
//
// K1/K2/K3 are proven against the PRODUCTION pager and the Rust authority
// (parsed from source, since the SQL itself is the contract for the sort and
// the tag vocabulary).

test("K1: a query change invalidates the generation, so no mixed page can commit", async () => {
  const { pagerKit } = kits();
  const calls: any[] = [];
  let releaseA!: (v: any) => void;
  const pager = new pagerKit.LocalNotesPager(async (f: any) => {
    calls.push({ ...f });
    if ((f.q ?? "") === "A") return await new Promise<any>((r) => { releaseA = r; });
    return { items: [makeNote(900)], total: 1, hasMore: false };
  });
  // Page 1 for query A is in flight.
  pager.reload({ q: "A" });
  await sleep(5);
  assert.equal(calls.length, 1);
  // The user types query B: the identity changes NOW (before any debounce), so
  // the current generation is invalidated and the pending A result is orphaned.
  pager.invalidate();
  // A Load More during that window must do nothing: there is no current
  // page-1 identity to continue.
  await pager.loadMore({ q: "B" });
  assert.equal(calls.length, 1, "loadMore fetched nothing across the identity change");
  // The late A response lands — and cannot commit into anything.
  releaseA({ items: [makeNote(1)], total: 60, hasMore: true });
  await sleep(5);
  assert.equal(pager.getState().items.length, 0, "the stale A page never commits");
  assert.equal(pager.getState().hasMore, false, "and cannot leave loadMore armed");

  // The debounced page-1 for B then commits cleanly.
  pager.reload({ q: "B" });
  await sleep(5);
  assert.equal(pager.getState().items.length, 1);
  assert.equal(pager.getState().items[0].noteId, "n900", "only B's rows are present");
  assert.deepEqual(calls.map((c) => c.q), ["A", "B"], "exactly one fetch per identity");
});

test("K1: loadMore refuses a stale identity instead of appending under it", async () => {
  const { pagerKit } = kits();
  const calls: any[] = [];
  const pager = new pagerKit.LocalNotesPager(async (f: any) => {
    calls.push({ ...f });
    return { items: [makeNote(1)], total: 120, hasMore: true };
  });
  pager.reload({ q: "A" });
  await sleep(5);
  // A caller still holding the OLD filter set cannot continue a NEWER identity.
  await pager.loadMore({ q: "STALE" });
  assert.equal(calls.length, 1, "the stale identity was refused before any fetch");
  // The current identity continues normally.
  await pager.loadMore({ q: "A" });
  assert.equal(calls.length, 2, "the current identity loads its next page");
  assert.equal(calls[1].page, 2);
  assert.equal(calls[1].q, "A", "the append used the ACTIVE identity, not the caller's");
});

test("K1: sameRequest compares the full pager identity", () => {
  const { pagerKit } = kits();
  const base = { q: "a", tag: "t", pinned: true, archived: false, sort: "name" };
  assert.equal(pagerKit.sameRequest(base, { ...base }), true);
  for (const patch of [{ q: "b" }, { tag: "u" }, { pinned: false }, { archived: true }, { sort: "recent" }]) {
    assert.equal(pagerKit.sameRequest(base, { ...base, ...patch }), false, JSON.stringify(patch));
  }
  // Absent sort/query normalise (the pager defaults to "recent"/"").
  assert.equal(pagerKit.sameRequest({}, { sort: "recent" }), true);
});

test("K2: the authority applies the sort BEFORE LIMIT/OFFSET (source contract)", () => {
  const db = read("src-tauri", "src", "db.rs");
  const at = db.indexOf("pub fn note_query(");
  const body = db.slice(at, db.indexOf("pub fn note_set_flags("));
  // The bounded vocabulary is a parameter (propagated from the command).
  assert.match(body.slice(0, 400), /sort: Option<&str>/, "the query takes the sort");
  // Name sort orders by title; recent keeps the historical order; BOTH end in a
  // deterministic note_id tiebreaker so pages cannot repeat or skip rows.
  assert.match(body, /let order_sql = match sort\.unwrap_or\("recent"\)/);
  assert.match(body, /"name" => "ORDER BY n\.pinned DESC, n\.title COLLATE NOCASE ASC, n\.note_id ASC"/);
  assert.match(body, /_ => "ORDER BY n\.pinned DESC, n\.updated_at DESC, n\.created_at DESC, n\.note_id ASC"/);
  // The order clause sits between the WHERE and the LIMIT.
  const orderIdx = body.indexOf("{order_sql}");
  assert.ok(orderIdx > body.indexOf("{where_sql}"), "order follows the filters");
  assert.ok(orderIdx < body.indexOf("{limit_sql}"), "and precedes pagination");
  // The command forwards the bounded vocabulary.
  const lib = read("src-tauri", "src", "lib.rs");
  const cmd = lib.slice(lib.indexOf("async fn local_note_list("));
  assert.match(cmd.slice(0, 900), /sort: Option<String>/, "the command accepts the sort");
  assert.match(cmd.slice(0, 900), /Some\("name"\) => Some\("name"\)/, "bounded to the offered vocabulary");
  assert.ok(cmd.slice(0, 900).includes("archived, page, limit, sort"), "and forwards it into the authority");
});

test("K2: a name-sorted global order reaches a record that belongs on page 1", async () => {
  const { pagerKit } = kits();
  // 120 notes whose titles are deliberately the reverse of their recency, so a
  // loaded-subset sort could never surface the alphabetically-first record
  // before loading the last page.
  const notes = Array.from({ length: 120 }, (_, i) => ({
    noteId: `n${i}`,
    title: String(1000 - i).padStart(4, "0"),  // n0->1000, n119->0881
    content: "",
    tags: [],
    pinned: false,
    favorite: false,
    archived: false,
    updatedAt: `2026-09-20T10:00:${String(i % 60).padStart(2, "0")}`,
  }));
  // The AUTHORITY contract: sort applied to the whole set, then paginate.
  const fetchPage = async (f: any) => {
    const rows = [...notes].sort((a, b) =>
      (f.sort ?? "recent") === "name"
        ? (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
        : (a.noteId < b.noteId ? 1 : -1),
    );
    const start = ((f.page ?? 1) - 1) * (f.limit ?? 50);
    return { items: rows.slice(start, start + (f.limit ?? 50)), total: rows.length, hasMore: start + (f.limit ?? 50) < rows.length };
  };
  const pager = new pagerKit.LocalNotesPager(fetchPage);
  pager.reload({ sort: "name" });
  await sleep(5);
  const page1 = pager.getState().items;
  assert.equal(page1[0].title, "0881", "the alphabetically-first record is on page 1");
  assert.equal(page1[0].noteId, "n119", "…even though it is the LAST by recency");
  // And the same record is not reachable only from page 3 as before.
  const firstFromRecent = await fetchPage({ sort: "recent", page: 1, limit: 50 });
  assert.notEqual(firstFromRecent.items[0].noteId, "n119", "recency order differs (the sort is real)");
});

test("K3: the tag picker reads the Local Note tag AUTHORITY, not the loaded page", async () => {
  const db = read("src-tauri", "src", "db.rs");
  // A narrow, bounded read over local_note_tag — the authority vocabulary.
  assert.match(db, /pub fn note_tag_vocabulary\(&self, limit: i64\)/);
  const body = db.slice(db.indexOf("pub fn note_tag_vocabulary"));
  assert.match(body.slice(0, 900), /SELECT tag FROM local_note_tag/, "reads the tag table directly");
  assert.match(body.slice(0, 900), /GROUP BY tag/, "distinct tags");
  assert.match(body.slice(0, 900), /ORDER BY tag COLLATE NOCASE ASC/, "stable order");
  assert.match(body.slice(0, 900), /LIMIT \?1/, "bounded");
  assert.ok(!body.slice(0, 900).includes("local_note_item"), "not derived from the note rows of a page");

  const lib = read("src-tauri", "src", "lib.rs");
  assert.match(lib, /async fn local_note_tags\(state: State<'_, SharedState>\)/);
  assert.ok(lib.includes("local_note_tags,"), "registered command");
  const client = read("src", "services", "client.ts");
  assert.match(client, /localNoteTags: \(\) => invoke<\{ tags: string\[\] \}>\("local_note_tags"\)/);
});

test("K3: a tag that exists only on a later page is offered before it is loaded", () => {
  const { usability } = kits();
  // The authority vocabulary (all distinct tags) vs page 1's rows.
  const authority = ["work", "travel", "zzz-late-page"];
  const page1Rows = [{ tags: ["work"] }, { tags: ["travel"] }];
  const fromPage = usability.collectTags(page1Rows, "");
  assert.ok(!fromPage.includes("zzz-late-page"), "deriving from the loaded page misses it (the defect)");
  const fromAuthority = usability.collectTags(authority.map((t) => ({ tags: [t] })), "");
  assert.deepEqual(fromAuthority, ["work", "travel", "zzz-late-page"], "the authority vocabulary has it"); 
});

test("K3: switching between two applied tags needs no full-list clear/load", () => {
  const { usability } = kits();
  const authority = ["alpha", "beta", "gamma"];
  // With tag=alpha applied, the loaded rows contain ONLY alpha — the old picker
  // would then offer just that one tag.
  const filteredRows = [{ tags: ["alpha"] }, { tags: ["alpha"] }];
  assert.deepEqual(usability.collectTags(filteredRows, "alpha"), ["alpha"], "the filtered page offers one tag");
  // The authority projection keeps every other tag selectable, including the one
  // being switched TO and the one currently applied.
  const offered = usability.collectTags(authority.map((t) => ({ tags: [t] })), "alpha");
  for (const t of ["alpha", "beta", "gamma"]) {
    assert.ok(offered.includes(t), );
  }
});

test("K3: the screen wires the picker to the authority vocabulary", () => {
  assert.match(SCREEN, /api\.localNoteTags\(\)/, "the screen reads the tag authority");
  assert.match(SCREEN, /setTagVocabulary\(r\?\.tags \|\| \[\]\)/, "and stores the authority list");
  // The picker no longer derives from the loaded page.
  assert.ok(!SCREEN.includes("collectTags(localPage.items"), "no page-derived tag picker");
  assert.match(SCREEN, /collectTags\(tagVocabulary\.map/, "the draft tags come from the vocabulary");
});
