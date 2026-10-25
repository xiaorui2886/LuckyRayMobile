import test from "node:test";
import assert from "node:assert/strict";
import { localWikiReferences, resolveLocalWiki, type LocalWikiNote, type LocalWikiClient } from "../src/still/kit/localWiki.ts";
import { NavigationController } from "../src/navigation.ts";
const rows: LocalWikiNote[] = [{ noteId: "note-source", title: "QA99 source" }, { noteId: "note-target", title: "本机目标" }];
const catalog = (notes: LocalWikiNote[]): LocalWikiClient => ({
  list: async () => ({ items: notes, total: notes.length, hasMore: false }),
  get: async id => notes.find(n => n.noteId === id)!,
});
const reference = (syntax: string) => localWikiReferences(syntax)[0];
test("local Wiki root-relative .md spelling resolves the local title, not a guessed directory", async () => {
  const result = await resolveLocalWiki(reference("[[./本机目标.md|显示别名]]"), catalog(rows));
  assert.equal(result.kind, "resolved");
  assert.equal(result.notes[0]?.noteId, "note-target");
});
test("local Wiki paths escaping the logical root stop before catalog access", async () => {
  let requests = 0;
  const client = { list: async () => { requests++; return { items: rows, total: rows.length, hasMore: false }; }, get: catalog(rows).get };
  for (const syntax of ["[[../本机目标]]", "[[./Folder/../../本机目标]]", "[[Folder/..]]"]) {
    await assert.rejects(resolveLocalWiki(reference(syntax), client), /LOCAL_WIKI_(?:PATH|ANCHOR)_UNSUPPORTED/);
  }
  assert.equal(requests, 0);
});
test("local Wiki ID identity wins over a coincidental title, aliases are display-only, missing creates nothing", async () => {
  const notes = [...rows, { noteId: "note-decoy", title: "note-target" }, { noteId: "note-alias", title: "显示别名" }];
  assert.equal((await resolveLocalWiki(reference("[[note-target|显示别名]]"), catalog(notes))).notes[0]?.noteId, "note-target");
  assert.equal((await resolveLocalWiki(reference("[[不存在|显示别名]]"), catalog(notes))).kind, "missing");
  assert.equal((await resolveLocalWiki(reference("[[note-missing]]"), catalog([...notes, { noteId: "note-decoy2", title: "note-missing" }]))).kind, "missing");
  assert.equal(notes.length, 4);
});
test("local Wiki parsed tokens exclude code, existing links, HTML, escapes, embeds and entity-created syntax", () => {
  const body = "`[[code]]`\n\n```md\n[[fence]]\n```\n\n[existing [[nested]]](https://example.invalid)\n\n<div>[[html]]</div>\n\n\\[[escaped]] ![[embed]] &#91;&#91;entity]]\n\n[[本机目标|别名]] [[本机目标]]";
  const references = localWikiReferences(body);
  assert.deepEqual(references.map(r => [r.target, r.label]), [["本机目标", "别名"], ["本机目标", "本机目标"]]);
  for (const ref of references) assert.match(body.slice(ref.from, ref.to), /^\[\[本机目标/);
  // Inline HTML tags are separate AST nodes: intervening parsed text is
  // Markdown text in the inherited grammar. Tags themselves are never executed.
  assert.deepEqual(localWikiReferences("<span>[[parsed text]]</span>").map(r => r.target), ["parsed text"]);
});
test("local Wiki complete pagination exposes a duplicate on later pages instead of claiming unique", async () => {
  const duplicate = [{ noteId: "note-a", title: "same" }, { noteId: "note-b", title: "SAME.md" }];
  const pages: number[] = [];
  const result = await resolveLocalWiki(reference("[[same]]"), {
    list: async ({ page }) => { pages.push(page); return { items: [duplicate[page - 1]], total: 2, hasMore: page === 1 }; },
    get: async () => { throw Error("must not read one chosen target while ambiguous"); },
  });
  assert.equal(result.kind, "ambiguous"); assert.deepEqual(result.notes.map(n => n.noteId), ["note-a", "note-b"]);
  assert.deepEqual(pages, [1, 2]);
});
test("local Wiki malformed/changed catalog and a mismatched target identity fail closed", async () => {
  for (const response of [{ items: [], total: 2, hasMore: false }, { items: [], total: 2, hasMore: true },
    { items: [{ noteId: "desktop:other:vault:id", title: "本机目标" }], total: 1, hasMore: false },
    { items: [rows[1], rows[1]], total: 2, hasMore: false }]) {
    await assert.rejects(resolveLocalWiki(reference("[[本机目标]]"), { ...catalog(rows), list: async () => response }), /LOCAL_WIKI_CHANGED/);
  }
  await assert.rejects(resolveLocalWiki(reference("[[本机目标]]"), { ...catalog(rows), get: async () => ({ noteId: "note-foreign", title: "本机目标" }) }), /LOCAL_WIKI_CHANGED/);
  await assert.rejects(resolveLocalWiki(reference("[[本机目标]]"), { ...catalog(rows), get: async () => ({ noteId: "note-target", title: "已重命名" }) }), /LOCAL_WIKI_CHANGED/);
});
test("linked detail navigation retains the same route objects, cycles collapse and normal opens remain bounded", () => {
  const nav = new NavigationController({ tab: "knowledge" });
  nav.pushDetail({ tab: "knowledge", detail: "note-source" }); const source = nav.current();
  nav.pushDetail({ tab: "knowledge", detail: "note-target" }, { retainDetail: true });
  assert.equal(nav.snapshot()[1], source); nav.goBack(); assert.equal(nav.current(), source);
  for (let i = 0; i < 30; i++) nav.pushDetail({ tab: "knowledge", detail: `note-next-${i}` }, { retainDetail: true });
  assert.equal(nav.snapshot().length, 9);
  const retained = nav.snapshot()[3]; nav.pushDetail({ ...retained, detail: retained.detail! }, { retainDetail: true });
  assert.equal(nav.current(), retained); assert.equal(nav.snapshot().length, 4);
  const ordinary = new NavigationController({ tab: "knowledge" });
  for (let i = 0; i < 30; i++) ordinary.pushDetail({ tab: "knowledge", detail: `note-${i}` });
  assert.equal(ordinary.snapshot().length, 2);
});

test("ordinary edit-prefixed A and linked reading A share one retained route identity", () => {
  const nav = new NavigationController({ tab: "home" });
  nav.pushDetail({ tab: "knowledge", detail: "edit:note-A" }, { originRoot: "home" });
  const owner = nav.current();
  nav.pushDetail({ tab: "knowledge", detail: "note-A" });
  assert.equal(nav.current(), owner);
  nav.pushDetail({ tab: "knowledge", detail: "note-B" }, { retainDetail: true });
  nav.pushDetail({ tab: "knowledge", detail: "note-A" }, { retainDetail: true });
  assert.equal(nav.current(), owner);
  assert.deepEqual(nav.snapshot(), [{ tab: "home" }, owner]);
  assert.equal(nav.goBack(), true); assert.deepEqual(nav.current(), { tab: "home" });
});

test("search for a retained note reveals its original owner instead of replacing the top with another copy", () => {
  const nav = new NavigationController({ tab: "knowledge" });
  nav.pushDetail({ tab: "knowledge", detail: "note-A" }); const owner = nav.current();
  nav.pushDetail({ tab: "knowledge", detail: "note-B" }, { retainDetail: true });
  nav.pushDetail({ tab: "knowledge", detail: "note-A" }); // ordinary search open, no retain flag
  assert.equal(nav.current(), owner); assert.equal(nav.snapshot().length, 2);
  nav.pushDetail({ tab: "knowledge", detail: "note-B" }, { retainDetail: true });
  nav.openSearch();
  const searchParent = nav.current();
  nav.pushDetail({ tab: "knowledge", detail: "edit:note-A" });
  assert.equal(nav.current(), owner); assert.equal(nav.snapshot().length, 3);
  assert.equal(nav.goBack(), true); assert.equal(nav.current(), searchParent, "a real Search page remains the immediate Back destination");
  assert.equal(nav.snapshot().filter(item => item.detail === "note-A").length, 0, "moving the reused owner above Search must not leave its second copy below");
});

test("note navigation identity includes source, instance and vault, while equivalent encoded routes reuse their owner", () => {
  const nav = new NavigationController({ tab: "knowledge" });
  for (const detail of ["note-same", "desktop:pc-A:vault-A:note-same", "desktop:pc-B:vault-A:note-same", "desktop:pc-A:vault-B:note-same"]) {
    nav.pushDetail({ tab: "knowledge", detail }, { retainDetail: true });
  }
  assert.equal(nav.snapshot().length, 5, "same bare ID must not merge different actual owners");
  const desktopA = nav.snapshot()[2];
  nav.pushDetail({ tab: "knowledge", detail: "edit:desktop:pc-%41:vault-%41:note-same" }, { retainDetail: true });
  assert.equal(nav.current(), desktopA); assert.equal(nav.snapshot().length, 3);
  nav.pushDetail({ tab: "knowledge", detail: "desktop:pc-%:vault-A:note-same" }, { retainDetail: true });
  assert.equal(nav.snapshot().length, 4, "malformed encoding must not alias a valid owner");
  nav.pushDetail({ tab: "library", detail: "edit:note-same" });
  nav.pushDetail({ tab: "library", detail: "note-same" }, { retainDetail: true });
  assert.equal(nav.snapshot().length, 3, "note identity rules must not deduplicate material routes");
});
