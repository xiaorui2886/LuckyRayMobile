import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { cachedResources } from "../src/services/noteProvenance.ts";
import { editingHintLabel } from "../src/services/knowledgeEditingSession.ts";

let server: Awaited<ReturnType<typeof createServer>>;
let DesktopNotePreview: any;
let DesktopKnowledgeReader: any;
let NoteSurface: any;
let NoteReadingContent: any;
let FolderRows: any;
let FolderBreadcrumbs: any;
before(async () => {
  // Module loading only: no listener, Desktop dev server, native IPC or profile.
  server = await createServer({ configFile: false, appType: "custom",
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    esbuild: { jsx: "automatic" } });
  DesktopNotePreview = (await server.ssrLoadModule("/src/components/DesktopNotePreview.tsx")).default;
  DesktopKnowledgeReader = (await server.ssrLoadModule("/src/still/kit/DesktopKnowledgeReader.tsx")).DesktopKnowledgeReader;
  NoteSurface = (await server.ssrLoadModule("/src/presentation/still01/Still.tsx")).NoteSurface;
  NoteReadingContent = (await server.ssrLoadModule("/src/still/kit/NoteReadingContent.tsx")).NoteReadingContent;
  ({ FolderRows, FolderBreadcrumbs } = await server.ssrLoadModule("/src/still/kit/knowledgeFolders.tsx"));
});
after(async () => { await server?.close(); });

// Execute the REAL DesktopStillNote readingContent expression with the REAL
// preview and authority surface. SSR covers markup/wiring, not effects/bitmap
// decoding or the entire hydrated app (resource effects have separate tests).
function readerMarkup(overrides: Record<string, unknown> = {}) {
  const source = readFileSync(new URL("../src/still/StillNote.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("StillNote.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "undefined";
  let found = false;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "DesktopStillNote") {
      function surface(child: ts.Node) {
        if (ts.isJsxSelfClosingElement(child) && child.tagName.getText(ast) === "NoteSurface") {
          found = true;
          const prop = child.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === "readingContent");
          if (prop && ts.isJsxAttribute(prop) && prop.initializer && ts.isJsxExpression(prop.initializer)) {
            expression = prop.initializer.expression?.getText(ast) ?? "undefined";
          }
        }
        ts.forEachChild(child, surface);
      }
      ts.forEachChild(node, surface);
    } else ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, "normal Desktop caller must still use the authority NoteSurface");
  const env = { React, DesktopNotePreview, DesktopKnowledgeReader, NoteReadingContent, cmScope: (...parts: string[]) => ["cm", ...parts].join("|"), cachedResources, registerOverlay: () => () => {}, current: true, retained: false, mode: "read", loaded: true,
    instance: "owner-a", vault: "vault-a", id: "note-a", title: "Owned note", content: "![[attachments/sample.png]]",
    searchTarget: undefined, setSearchTarget() {}, readingHeading: undefined, consumeReadingHeading() {},
    connectedOwner: true, epoch: { current: 7 },
    displayedRevision: { current: "r1" }, deferredIncoming: { current: null },
    pending: { current: new Map() }, failed: { current: false }, openLinkedNote: async () => {},
    loadedNoteScope: JSON.stringify(["owner-a", "vault-a", "note-a"]),
    note: { cachedDocument: { resources: [{ target: "attachments/sample.png", resourceId: "resource-a", mimeType: "image/png", status: "resolved", version: "v1" }] } },
    ...overrides };
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: {
    jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
  }}).outputText;
  const readingContent = Function(...Object.keys(env), code)(...Object.values(env));
  return renderToStaticMarkup(React.createElement(NoteSurface, {
    title: "Owned note", body: env.content, mode: env.mode, state: "synced", savedLabel: "已同步",
    readingContent, onBack() {}, onBrowse() {}, onMore() {}, onNew() {}, onEdit() {}, onChange() {},
    onFormat() {}, onSearch() {}, onState() {}, onAttach() {},
  }));
}

test("normal Desktop reader interprets published attachments instead of showing literal embeds", () => {
  const output = readerMarkup();
  assert.match(output, /sample\.png · 按需获取/);
  assert.doesNotMatch(output, /!\[\[attachments\/sample\.png\]\]/);
});

test("real preview preserves attachments beside decoded prose and differentiates wiki from HTTP", () => {
  const output = renderToStaticMarkup(React.createElement(DesktopNotePreview, {
    instance: "A", vault: "v", note: "n", online: false,
    content: "Tom &amp; Jerry \\* ![[attachments/sample.png]] [[Target|别名]] [网站](https://example.com) <script>bad()</script>",
    resources: [{ target: "attachments/sample.png", resourceId: "image", mimeType: "image/png", status: "resolved", version: "v1" }],
    onWikiLink() {},
  }));
  assert.match(output, /sample\.png · 附件尚未缓存/);
  assert.doesNotMatch(output, /!\[\[attachments\/sample\.png\]\]/);
  assert.match(output, /<button[^>]*class="st-wiki-link is-unknown"[^>]*><span[^>]*>别名<\/span><\/button>/);
  assert.match(output, /<a href="https:\/\/example\.com" target="_blank" rel="noreferrer noopener"><span[^>]*>网站<\/span><\/a>/);
  assert.doesNotMatch(output, /<script|javascript:/);
});

test("real preview never substitutes a later literal link for an entity-decoded token", () => {
  const content = "[[a&amp;b]] [[a&b]]";
  const output = renderToStaticMarkup(React.createElement(DesktopNotePreview, {
    instance: "A", vault: "v", note: "n", content, resources: [], online: false, onWikiLink() {},
  }));
  assert.equal((output.match(/class="st-wiki-link is-unknown"/g) || []).length, 1);
  assert.match(output, /data-note-source-start="12" data-note-source-end="19"/);
  assert.match(output, /\[\[a&amp;b\]\]/, "the transformed first token stays literal");
});

const folderSnapshot = (patch: Record<string, unknown> = {}) => ({ instance: "A", vault: "v", paths: ["", "Work", "Work/Nested", "Empty"],
  phase: "ready", complete: true, origin: "services", savedAt: 1, ...patch });
test("real folder surface includes empty folders and only immediate child folders", () => {
  const root = renderToStaticMarkup(React.createElement(FolderRows, { snapshot: folderSnapshot(), current: "", online: true, onSelect() {} }));
  assert.match(root, />Empty</); assert.match(root, />Work</); assert.doesNotMatch(root, />Nested</);
  const nested = renderToStaticMarkup(React.createElement(FolderRows, { snapshot: folderSnapshot(), current: "Work", online: true, onSelect() {} }));
  assert.match(nested, />Nested</); assert.doesNotMatch(nested, />Empty</);
  const empty = renderToStaticMarkup(React.createElement(FolderRows, { snapshot: folderSnapshot(), current: "Empty", online: true, onSelect() {} }));
  assert.doesNotMatch(empty, /st-folder-row/);
});

test("real breadcrumbs provide parent and root return paths, with the current location disabled", () => {
  const output = renderToStaticMarkup(React.createElement(FolderBreadcrumbs, { current: "Work/Nested", onSelect() {} }));
  assert.match(output, /aria-label="知识库目录路径"/);
  assert.match(output, />全部笔记<\/button>/); assert.match(output, />Work<\/button>/);
  assert.match(output, /aria-current="location" title="Work\/Nested">Nested<\/strong>/);
});

test("real folder status distinguishes denied, partial offline and complete cached inventory", () => {
  const render = (snapshot: any, online = false) => renderToStaticMarkup(React.createElement(FolderRows, { snapshot, current: "", online, onSelect() {} }));
  const denied = render(folderSnapshot({ paths: [], phase: "denied", complete: false, origin: "none" }), true);
  assert.match(denied, /未获电脑目录读取授权/); assert.doesNotMatch(denied, /st-folder-row|还没有文件夹/);
  const partial = render(folderSnapshot({ phase: "offline", complete: false, origin: "notes" }));
  assert.match(partial, /可能缺少空目录/); assert.doesNotMatch(partial, /显示上次完整目录/);
  assert.match(render(folderSnapshot({ phase: "offline" })), /显示上次完整目录/);
});

test("note resource IPC binds the requested owner before native download", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let request: unknown;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: unknown) => { request = { command, args }; return {}; },
  } } });
  try {
    const { api } = await server.ssrLoadModule("/src/services/client.ts");
    await api.contentNoteResource("owner-a", "vault-a", "note-a", "resource-a", "job-a");
    assert.deepEqual(request, { command: "content_note_resource", args: {
      instance: "owner-a", vault: "vault-a", note: "note-a", id: "resource-a", jobId: "job-a",
    } });
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("reader does not authorize old cached descriptors under a new route owner", () => {
  for (const patch of [{instance: "owner-b"}, {vault: "vault-b"}, {id: "note-b"}, {current: false}]) {
    assert.doesNotMatch(readerMarkup(patch), /按需获取|查看附件/);
  }
});

test("reader uses only complete cached-document resources and keeps raw drafts in edit mode", () => {
  const content = "![[attachments/sample.png]]\n\n![[attachments/new.png]]";
  const cached = {target: "attachments/sample.png", resourceId: "resource-a", mimeType: "image/png", status: "resolved", version: "v1"};
  const output = readerMarkup({content, note: {cachedDocument: {resources: [cached]},
    serverDocument: {resources: [{...cached, target: "attachments/new.png", resourceId: "resource-b"}]}}});
  assert.match(output, /sample\.png · 按需获取/);
  assert.match(output, /new\.png（尚未获取或不可访问）/);
  const edited = readerMarkup({content, mode: "edit"});
  assert.match(edited, /<textarea[^>]*>!\[\[attachments\/sample\.png\]\]/);
  assert.doesNotMatch(edited, /note-reading|查看附件/);
});

test("unpublished, absent and arbitrary image targets remain honest placeholders", () => {
  const content = "![[luckyray-attachment:own-staged]]\n\n![remote](https://example.invalid/private.png)\n\n![local](file:///private.png)\n\n`![[attachments/sample.png]]`\n\n<script>alert(1)</script>";
  const output = readerMarkup({content});
  assert.match(output, /尚未获取或不可访问/);
  assert.match(output, /<code[^>]*><span[^>]*>!\[\[attachments\/sample\.png\]\]<\/span><\/code>/);
  assert.doesNotMatch(output, /<img|<script|https:\/\/example|file:\/\/\/private|查看附件/);
});

test("hidden reader is cache-only, not an automatic network attachment reader", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: {hidden: true}});
  try { assert.match(readerMarkup(), /附件尚未缓存 · 请连接原电脑/); }
  finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("normal Source separates editing advice from body sync and hides stale/Done advice", () => {
  const source = readFileSync(new URL("../src/still/StillNote.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("StillNote.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "DesktopStillNote") {
      function row(child: ts.Node) {
        if (ts.isJsxElement(child) && child.getText(ast).startsWith('<div className="st-metadata-row"><span>编辑提示</span>')) {
          expression = child.getText(ast);
        } else ts.forEachChild(child, row);
      }
      ts.forEachChild(node, row);
    } else ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression, "the actual normal Source page must expose the fixed advisory row");
  const code = ts.transpileModule(`return (${expression});`, {compilerOptions: {jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
  const render = (patch: Record<string, unknown> = {}) => {
    const env = {React, editingHintLabel, mode: "edit", current: true, connectedOwner: true,
      instance: "owner-a", vault: "vault-a", id: "note-a", document: {hidden: false},
      mobileEditingHint: {scope: JSON.stringify(["owner-a", "vault-a", "note-a"]), hint: "sent"}, ...patch};
    return renderToStaticMarkup(Function(...Object.keys(env), code)(...Object.values(env)));
  };
  assert.match(render(), /编辑提示已发送/);
  for (const patch of [{mode: "read"}, {current: false}, {connectedOwner: false},
    {instance: "owner-b"}, {vault: "vault-b"}, {id: "note-b"}, {document: {hidden: true}}]) {
    assert.match(render(patch), /未启用/);
    assert.doesNotMatch(render(patch), /编辑提示已发送/);
  }
  assert.doesNotMatch(render(), /已同步|server-token|owner-a|vault-a|note-a/);
});
