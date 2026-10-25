import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
let server: Awaited<ReturnType<typeof createServer>>;
let NoteOutline: any;
before(async () => {
  server = await createServer({configFile:false,appType:'custom',optimizeDeps:{noDiscovery:true,entries:[]},server:{middlewareMode:true,watch:null,hmr:false},esbuild:{jsx:'automatic'}});
  ({ NoteOutline } = await server.ssrLoadModule('/src/still/kit/NoteOutline.tsx'));
});
after(async () => { await server?.close(); });
const render = (body: string) => renderToStaticMarkup(createElement(NoteOutline, {body,registerOverlay:()=>()=>{},onClose(){},onSelect(){}}));
test('outline is a sheet with accessible heading navigation and semantic depth', () => {
  const html = render('# Main\n\n### Child\n\n## &lt;script&gt;');
  assert.match(html, /笔记大纲/); assert.match(html, /aria-label="笔记标题"/);
  assert.match(html, /aria-label="3级标题"/); assert.match(html, />Child</);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});
test('empty and code-only documents explain how to add real headings', () => {
  assert.match(render('```\n# not a heading\n```'), /还没有标题/);
  assert.doesNotMatch(render('plain'), /aria-label="笔记标题"/);
});
test('source navigation dispatch is scroll-only and does not replace selection, history or source', () => {
  const source = readFileSync(new URL('../src/presentation/still01/editor/MobileCmEditor.tsx', import.meta.url), 'utf8');
  const method = source.split('scrollToSource: (offset) => {')[1]?.split('\n    },')[0];
  assert.ok(method); assert.match(method, /EditorView\.scrollIntoView/);
  assert.doesNotMatch(method, /changes:|selection:|EditorState\.create|setState|focus\(/);
  assert.match(method, /Number\.isFinite/);
});
