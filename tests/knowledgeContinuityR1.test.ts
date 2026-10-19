import test from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";
import { bodyMatchRanges, noteSearchEvidence, readableNoteSearchEvidence, assertNoteSearchScope, desktopNoteRoute } from "../src/still/kit/noteSearch.ts";
import { noteSearchField, setNoteSearch } from "../src/presentation/still01/editor/cmNoteSearch.ts";
import { LocalNotesPager } from "../src/services/knowledgeNotesPager.ts";
import { KnowledgeBrowseController } from "../src/still/kit/knowledgeBrowseController.ts";
import { KnowledgeDirectoryController } from "../src/still/kit/knowledgeDirectoryController.ts";
import { orchestrateDesktopCreate } from "../src/still/kit/desktopCreate.ts";

const settle = async () => { for (let n = 0; n < 6; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test("continuity: literal full-body ranges preserve UTF-16 offsets, punctuation, and long tails", () => {
  const body = "😀前言".repeat(100) + "\nA+[字] and a+[字]\n第三处 A+[字]";
  const ranges = bodyMatchRanges(body, " A+[字] ");
  assert.equal(ranges.length, 3);
  assert.ok(ranges[0].from > 80);
  assert.deepEqual(ranges.map(range => body.slice(range.from, range.to)), ["A+[字]", "a+[字]", "A+[字]"]);
  const evidence = noteSearchEvidence("A+[字]", body, true)!;
  assert.deepEqual(evidence.bodyRange, ranges[0]);
  assert.match(evidence.snippet!, /A\+\[字\]/);
  assert.ok(evidence.outdated);
  assert.deepEqual(readableNoteSearchEvidence("旧正文", { content: "旧正文", cachedDocument: null, dirty: false }), { query: "旧正文" });
  assert.ok(readableNoteSearchEvidence("草稿", { content: "草稿", dirty: true })?.bodyRange);
  assert.equal(bodyMatchRanges("abc", " .* ").length, 0);
  assert.equal(bodyMatchRanges("İx needle", "needle")[0].from, 3, "case folding cannot shift source offsets");
  assert.deepEqual(noteSearchEvidence("标题", undefined), { query: "标题" }, "metadata does not invent a body range");
});

test("continuity: CM search and next-match effects preserve document, selection and undo", () => {
  let state = EditorState.create({ doc: "前言\n目标\n后段目标", selection: EditorSelection.range(1, 3), extensions: [history(), noteSearchField] });
  state = state.update({ changes: { from: 0, insert: "写" } }).state;
  const body = state.doc.toString(), selection = state.selection.toJSON(), undo = undoDepth(state);
  for (const index of [0, 1, 0]) {
    const transaction = state.update({ effects: setNoteSearch.of({ query: "目标", index }) });
    assert.equal(transaction.docChanged, false, "the real adapter's docChanged save gate stays closed");
    state = transaction.state;
    assert.equal(state.doc.toString(), body);
    assert.deepEqual(state.selection.toJSON(), selection);
    assert.equal(undoDepth(state), undo);
    assert.equal(state.field(noteSearchField).ranges.length, 2);
    assert.equal(state.field(noteSearchField).index, index);
  }
  state = state.update({ effects: setNoteSearch.of({ query: "", index: 0 }) }).state;
  assert.equal(state.field(noteSearchField).decorations.size, 0);
  assert.deepEqual(state.selection.toJSON(), selection);
  assert.equal(undoDepth(state), undo);
});

test("continuity: incoming body rechecks ranges without search changing saved content", () => {
  let state = EditorState.create({ doc: "目标", extensions: [noteSearchField] });
  state = state.update({ effects: setNoteSearch.of({ query: "目标", index: 0 }) }).state;
  state = state.update({ changes: { from: 0, insert: "长前言".repeat(100) } }).state;
  assert.equal(state.field(noteSearchField).ranges[0].from, 300);
  state = state.update({ changes: { from: 300, to: 302, insert: "正文" } }).state;
  assert.equal(state.field(noteSearchField).ranges.length, 0);
  assert.equal(state.doc.toString().slice(-2), "正文");
});

test("continuity: exact-scope S1 reader + existing pager searches all 112 bodies before paging", async () => {
  const scope = { instance: "pc-A", vault: "vault-A", directory: "" };
  const calls: any[] = [];
  const rows = Array.from({ length: 112 }, (_, i) => ({ instanceId: "pc-A", vaultId: "vault-A", noteId: `n${i}`, title: "普通标题", content: "前言".repeat(100) + (i === 111 ? "唯一尾词" : "共同尾词") }));
  const pager = new LocalNotesPager(async filters => {
    calls.push({ ...scope, ...filters });
    const all = rows.filter(row => row.content.includes(filters.q || ""));
    const items = all.slice((filters.page - 1) * filters.limit, filters.page * filters.limit);
    assertNoteSearchScope(items, scope);
    return { items, hasMore: filters.page * filters.limit < all.length };
  });
  pager.reload({ q: "" }); await settle();
  await pager.loadMore({ q: "" }); await pager.loadMore({ q: "" });
  assert.equal(pager.getState().items.length, 112);
  pager.invalidate(); pager.reload({ q: "唯一尾词" }); await settle();
  assert.deepEqual(pager.getState().items.map(row => row.noteId), ["n111"]);
  assert.ok(calls.every(call => call.instance === "pc-A" && call.vault === "vault-A"));
  assert.throws(() => assertNoteSearchScope([{ instanceId: "pc-A", vaultId: "vault-B" }], scope), /CONTENT_SOURCE_CHANGED/);
  assert.throws(() => assertNoteSearchScope([{ instanceId: "pc-B", vaultId: "vault-A" }], scope), /CONTENT_SOURCE_CHANGED/);
  assert.equal(desktopNoteRoute("pc:A", "库/B", "n:1"), "desktop:pc%3AA:%E5%BA%93%2FB:n%3A1");
  pager.suspend();
});

test("continuity: query/close invalidation rejects a late page and a late old error", async () => {
  const old = deferred<any>(), more = deferred<any>();
  const pager = new LocalNotesPager(async ({ q, page }) => q === "old" ? old.promise : page === 2 ? more.promise : { items: [{ noteId: "new" }], hasMore: true });
  pager.reload({ q: "old" }); pager.invalidate(); pager.reload({ q: "new" }); await settle();
  old.resolve({ items: [{ noteId: "old" }], hasMore: false }); await settle();
  assert.deepEqual(pager.getState().items.map(row => row.noteId), ["new"]);
  const next = pager.loadMore({ q: "new" }); pager.suspend();
  more.resolve({ items: [{ noteId: "late" }], hasMore: false }); await next;
  assert.deepEqual(pager.getState().items.map(row => row.noteId), ["new"]);
});

test("continuity: actual S1 browse/directory mappings carry >80 character body evidence", async () => {
  const row = { instanceId: "A", vaultId: "V", noteId: "n", title: "title", relativePath: "Docs/n.md", revision: "r", content: "序".repeat(250) + "深处词", cachedDocument: {content: "序".repeat(250) + "深处词"} };
  const library = { instanceId: "A", vaultId: "V", confirmed: true, name: "V", writeState: "granted" };
  const browse = new KnowledgeBrowseController({ registry: {} as any, knowledge: {} as any, debounceMs: 0,
    replica: { libraries: async () => [library] as any, notes: async () => ({ items: [row], hasMore: false }) } });
  browse.setConnection({ paired: true, connected: false, instanceId: "A", isLive: () => true }); await settle();
  browse.setQuery("深处词"); await new Promise(resolve => setTimeout(resolve, 5)); await settle();
  assert.deepEqual(browse.snapshot().rows[0].searchHit?.bodyRange, { from: 250, to: 253 });
  const directory = new KnowledgeDirectoryController(async () => ({ items: [row], hasMore: false, source: "cache" }), { debounceMs: 0 });
  directory.setOwner({ paired: true, connected: false, instanceId: "A", localReplica: true, writeGranted: true, isLive: () => true });
  directory.setVault("V"); directory.setDirectory("Docs"); directory.setQuery("深处词"); await settle();
  assert.deepEqual(directory.snapshot().rows[0].searchHit?.bodyRange, { from: 250, to: 253 });
  browse.suspend(); directory.suspend();
});

test("continuity: edit/composition incarnation cancels create before authority resolves", async () => {
  const authority = deferred<{ usable: boolean }>(); let activity = 1, calls = 0;
  const result = orchestrateDesktopCreate({ resolveAuthority: () => authority.promise,
    create: async () => { calls++; return "n"; }, currentness: {
      instance: () => "A", vault: () => "V", parent: () => "Docs", generation: () => activity, connected: () => true,
    } });
  activity++; authority.resolve({ usable: true });
  assert.equal((await result).kind, "stale"); assert.equal(calls, 0);
});

test("continuity: newly typed text during create keeps durable original-scope draft without navigation", async () => {
  const created = deferred<string>(); let activity = 1, calls = 0;
  const result = orchestrateDesktopCreate({ resolveAuthority: async () => ({ usable: true }),
    create: async scope => { assert.deepEqual(scope, { instance: "A", vault: "V", parent: "Docs/Sub", generation: 1 }); calls++; return created.promise; },
    currentness: { instance: () => "A", vault: () => "V", parent: () => "Docs/Sub", generation: () => activity, connected: () => true } });
  await settle(); activity++; created.resolve("new-note-id");
  const actual = await result;
  assert.equal(actual.kind, "created-stale"); assert.equal(calls, 1);
  if (actual.kind === "created-stale") assert.equal(actual.scope.parent, "Docs/Sub");
});

test("continuity geometry: a 2/3 counter and outer scroll cannot pass an offscreen inner hit", async () => {
  const { classifySearchGeometry } = await import("../scripts/qa/knowledgeContinuityGeometry.mjs");
  const clip = { top: 120, bottom: 660, left: 22, right: 338 };
  const sample = { count: "2 / 3", paperScrollTop: 50, cmScrollTop: 0,
    clips: [clip, { top: 0, bottom: 800, left: 0, right: 360 }],
    hits: [{ text: "独有命中", display: "inline", visibility: "visible", rects: [{ top: 2500, bottom: 2522, left: 22, right: 86 }] }] };
  assert.equal(classifySearchGeometry(sample).visible, false);
  const visible = { ...sample, hits: [{ ...sample.hits[0], rects: [{ top: 380, bottom: 402, left: 22, right: 86 }] }] };
  assert.equal(classifySearchGeometry(visible).visible, true);
  assert.equal(classifySearchGeometry({ ...visible, clips: [...visible.clips, { top: 450, bottom: 650, left: 22, right: 338 }] }).visible, false,
    "the paper/page clip still matters when the CM viewport alone contains the hit");
});

test("continuity geometry: empty, collapsed, hidden and horizontally clipped hits fail", async () => {
  const { classifySearchGeometry } = await import("../scripts/qa/knowledgeContinuityGeometry.mjs");
  const clips = [{ top: 100, bottom: 600, left: 20, right: 340 }];
  const hit = { text: "独有命中", display: "inline", visibility: "visible", rects: [{ top: 200, bottom: 223, left: 22, right: 86 }] };
  for (const hits of [[], [{ ...hit, display: "none" }], [{ ...hit, visibility: "hidden" }],
    [{ ...hit, rects: [{ top: 200, bottom: 200, left: 22, right: 86 }] }],
    [{ ...hit, rects: [{ top: 200, bottom: 223, left: 330, right: 390 }] }]]) {
    assert.equal(classifySearchGeometry({ clips, hits }).visible, false);
  }
});

test("continuity geometry: virtual CM gaps remain in layout after search controls close", async () => {
  const { readFileSync } = await import("node:fs");
  const stylesheet = readFileSync(new URL("../src/still/kit/noteSearch.css", import.meta.url), "utf8");
  assert.match(stylesheet, /\.st-note-editor\.is-cm \.cm-content \.cm-gap\s*\{\s*display:\s*block\s*\}/);
  assert.doesNotMatch(stylesheet, /\.st-note-find[^{}]*\.cm-gap\s*\{/, "the repair cannot disappear with the temporary search bar");
});

test("continuity geometry: editor-internal layout updates never inherit reduced-motion transitions", async () => {
  const { readFileSync } = await import("node:fs");
  const stylesheet = readFileSync(new URL("../src/still/kit/noteSearch.css", import.meta.url), "utf8");
  assert.match(stylesheet, /\.st-note-editor\.is-cm \.cm-editor,\s*\.st-note-editor\.is-cm \.cm-editor \*\s*\{transition-property:none!important\}/);
  assert.doesNotMatch(stylesheet, /\.st-note-find[^{}]*transition-property/, "closing find must not re-enable layout interpolation");
});
