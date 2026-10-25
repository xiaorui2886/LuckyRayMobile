import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { noteMediaLabel } from "../src/components/noteMediaLabel.ts";
let server: Awaited<ReturnType<typeof createServer>>;
let SafeNoteMarkdown: any, LocalKnowledgeReader: any, NoteReadingContent: any, NoteImagePreview: any;
before(async () => {
  server = await createServer({ configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, watch: null, hmr: false }, esbuild: { jsx: "automatic" } });
  ({ SafeNoteMarkdown } = await server.ssrLoadModule("/src/components/SafeNoteMarkdown.tsx"));
  ({ LocalKnowledgeReader } = await server.ssrLoadModule("/src/still/kit/LocalKnowledgeReader.tsx"));
  ({ NoteReadingContent } = await server.ssrLoadModule("/src/still/kit/NoteReadingContent.tsx"));
  ({ NoteImagePreview } = await server.ssrLoadModule("/src/components/NoteImagePreview.tsx"));
});
after(async () => { await server?.close(); });
const render = (component: any, props: any) => renderToStaticMarkup(createElement(component, props));
test("local reader and default reader render Markdown semantics without changing source", () => {
  const content = "# Heading\n\n**bold** and `code`\n\n- one\n- two\n\n> quote\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[[Target|Alias]]";
  const html = render(LocalKnowledgeReader, { source: "id", content, current: true, find: {body: content, ranges: [], index: 0}, registerOverlay: () => () => {}, onNavigate: async () => {} });
  for (const tag of ["h1", "strong", "code", "ul", "blockquote", "table"]) assert.match(html, new RegExp(`<${tag}[ >]`));
  assert.match(html, /class="st-wiki-link is-unknown"/); assert.match(html, />Alias</);
  assert.match(render(NoteReadingContent, { scope: "test", body: "# Heading" }), /<h1/);
  assert.ok(content.startsWith("# Heading"));
});
test("reader blocks HTML, unscoped remote images and unsafe link schemes", () => {
  const html = render(SafeNoteMarkdown, {content: '<script>alert(1)</script>\n\n![remote](https://bad.example/x.png) ![file](file:///secret) ![data](data:image/png;base64,abc) [bad](javascript:alert) [file](file:///secret) [site](https://example.com)'});
  assert.doesNotMatch(html, /<script|<img|src=|href="(?:file|javascript|data):|bad\.example/);
  assert.match(html, /href="https:\/\/example.com"/);
});
test("search positions and wiki source offsets survive Markdown rendering", () => {
  const content = "# Heading\n\nFind [[Target|Alias]]";
  const html = render(SafeNoteMarkdown, {content, find: {body: content, ranges: [{from: 11, to: 15}], index: 0}, onWikiLink() {}});
  assert.match(html, /st-note-find-hit is-current/);
  assert.match(html, /data-note-source-start="16" data-note-source-end="32"/);
});
test("display basename is decoded once and cannot change transport identity", () => {
  const target = "attachments/%E4%B8%AD%E6%96%87%20image.png";
  assert.equal(noteMediaLabel(target), "中文 image.png"); assert.equal(target, "attachments/%E4%B8%AD%E6%96%87%20image.png");
  assert.equal(noteMediaLabel("dir/bad%name.png"), "bad%name.png");
  assert.equal(noteMediaLabel("dir/%252F.png"), "%2F.png");
  assert.equal(noteMediaLabel("dir/%E2%80%AEname.png"), "name.png");
});
test("image preview is a bounded button with separate modal and overlay dismissal", () => {
  const html = render(NoteImagePreview, {source: "asset://verified/image", label: "image.png"});
  assert.match(html, /aria-haspopup="dialog"/); assert.match(html, /st-note-image-trigger/); assert.doesNotMatch(html, /<dialog/);
  const source = readFileSync(new URL("../src/components/NoteImagePreview.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/components/SafeNoteMarkdown.css", import.meta.url), "utf8");
  assert.match(source, /registerOverlay\?\.\(\(\) => setOpen\(false\)\)/);
  assert.match(source, /showModal\(\)/); assert.match(source, /onCancel=/); assert.match(source, /preventScroll: true/);
  assert.match(css, /st-note-image-trigger img[^}]*max-width: 100%/);
  assert.doesNotMatch(source, /maxWidth.*none|contentUpdate|localNoteUpdate/);
});
