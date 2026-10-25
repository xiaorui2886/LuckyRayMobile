import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../src/presentation/still01/editor/'+p,import.meta.url),'utf8');
const css=read('cmLivePreview.css'), typography=read('noteTypography.css');
const declarations=(source,selector)=>{const values={};for(const [,selectors,body]of source.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g))if(selectors.split(',').map(s=>s.trim()).includes(selector))for(const part of body.split(';')){const i=part.indexOf(':');if(i>=0)values[part.slice(0,i).trim()]=part.slice(i+1).trim()}return values};
// Structural CSS contracts only. These are not screenshot or Android IME tests.
test('selection never changes table width, margins or edge-lane geometry',()=>{
 assert.doesNotMatch(css,/\.has-table-selection[^{}]*\{[^}]*(?:padding|margin|width|height)/);
 assert.doesNotMatch(css,/--table-edit-width/);
 assert.equal(declarations(css,'.st-note-editor .cm-lp-table-wrap').padding,'18px 0 22px');
 assert.equal(declarations(css,'.st-note-editor .cm-lp-table')['min-width'],'0');
 assert.equal(declarations(css,'.st-note-editor .cm-lp-table')['table-layout'],'fixed');
});
test('preview cell widths are controlled by colgroup, not cell min-content',()=>{
 for(const selector of ['.st-note-surface .st-note-editor .cm-lp-table td','.st-note-surface .st-note-editor .cm-lp-table th']){const d=declarations(typography,selector);assert.equal(d['min-width'],'0');assert.equal(d['max-width'],'none');assert.equal(d['overflow-wrap'],'anywhere');assert.equal(d['word-break'],'break-word')}
});
test('reading and editing use the same compact padding, leading and quiet header',()=>{
 for(const [a,b]of [['.st-note-surface .st-safe-note-markdown td','.st-note-surface .st-note-editor .cm-lp-table td'],['.st-note-surface .st-safe-note-markdown th','.st-note-surface .st-note-editor .cm-lp-table th']]){assert.equal(declarations(typography,a).padding,'.25em .5em');assert.equal(declarations(typography,a).padding,declarations(typography,b).padding)}
 for(const s of ['.st-note-surface .st-safe-note-markdown table','.st-note-surface .st-note-editor .cm-lp-table'])assert.equal(declarations(typography,s)['line-height'],'1.5');
 for(const s of ['.st-note-surface .st-safe-note-markdown th','.st-note-surface .st-note-editor .cm-lp-table th'])assert.equal(declarations(typography,s).background,'transparent');
});
test('long URL, code and native input can wrap without widening grid',()=>{
 for(const s of ['.st-note-editor .cm-lp-table code','.cm-lp-table-input']){const d=declarations(css,s);assert.equal(d['overflow-wrap'],'anywhere');assert.equal(d['word-break'],'break-word');assert.notEqual(d['white-space'],'nowrap')}
 assert.equal(declarations(css,'.cm-lp-table-input')['min-width'],'0');
});
test('icons remain quiet with explicit drag handles and larger menu targets',()=>{
 const b=declarations(css,'.cm-lp-table-tools button'), svg=declarations(css,'.cm-lp-table-tools svg');
 assert.equal(svg.width,'16px');assert.ok(parseFloat(b['min-width'])>=28);assert.ok(parseFloat(b['min-height'])>=28);assert.equal(b.cursor,'pointer');
 assert.equal(declarations(css,'.cm-lp-table-menu button')['min-height'],'44px');
 assert.match(css,/cursor:grab/);assert.match(css,/\[data-table-grip\]/);
});
test('selected cell uses one-pixel inset, not a filled cross or layout border',()=>{
 assert.match(css,/data-table-drag/);assert.match(css,/data-table-selection/);
 const d=declarations(css,'.st-note-editor .cm-lp-table .is-editing');assert.equal(d.background,'transparent');assert.match(d['box-shadow'],/inset 0 0 0 1px/);assert.equal(d.border,undefined);
});
test('scroll containment belongs to each table, no document-wide horizontal scroller',()=>{
 const d=declarations(css,'.st-note-editor .cm-lp-table-viewport');assert.equal(d['overflow-x'],'auto');assert.equal(d['max-width'],'100%');assert.equal(d['overscroll-behavior-x'],'contain');
});

test('side controls stay inside the clipped editor and outside cell content',()=>{
 for(const [selector,side]of [['.cm-lp-table-edge--left','left'],['.cm-lp-table-edge--right','right']])assert.equal(declarations(css,selector)[side],'-22px');
 for(const selector of ['.cm-lp-table-tools .cm-lp-table-edge--left','.cm-lp-table-tools .cm-lp-table-edge--right']){const d=declarations(css,selector);assert.equal(d.width,'20px');assert.equal(d['min-width'],'20px');assert.equal(d['min-height'],'36px')}
 assert.equal(declarations(css,'.cm-lp-table-edge--top').top,'0');
});

test('theme menu never references absent panel/text tokens; plus has visible boundary',()=>{
 const menu=declarations(css,'.cm-lp-table-menu');assert.equal(menu.position,'fixed');assert.equal(menu.background,'var(--st-sheet,#f4f5f8)');assert.equal(menu.color,'var(--st-ink,#26312f)');assert.equal(menu['flex-direction'],'column');assert.doesNotMatch(menu.background,/st-panel/);
 const plus=declarations(css,'.cm-lp-table-tools .cm-lp-table-edge--right');assert.equal(plus.border,'1px solid var(--st-line)');assert.equal(plus['border-radius'],'0 4px 4px 0');
});
test('reader table fills available width and wraps instead of max-content sizing',()=>{
 const table=declarations(typography,'.st-note-surface .st-safe-note-markdown table');assert.equal(table.width,'100%');assert.equal(table['table-layout'],'fixed');assert.equal(table.display,'table');
 const quote=declarations(typography,'.st-note-surface .st-safe-note-markdown blockquote');assert.match(quote['border-left'],/--st-accent/);
});

test('editor borrows page gutters rather than shrinking rendered tables',()=>{
 assert.equal(declarations(css,'.st-note-surface .st-note-editor.is-cm').width,'calc(100% + 44px)');
 assert.equal(declarations(css,'.st-note-surface .st-note-editor.is-cm')['margin-left'],'-22px');
 assert.equal(declarations(css,'.st-note-surface .st-note-editor.is-cm .cm-content')['padding-left'],'var(--st-note-editor-inset,22px)');
 assert.equal(declarations(css,'.st-note-surface .st-note-editor.is-cm .cm-content')['padding-right'],'var(--st-note-editor-inset,22px)');
});
test('reader and editor highlights use accent-derived fill with legacy fallback',()=>{
 assert.match(typography,/--note-highlight:linear-gradient/);assert.match(typography,/linear-gradient[^;]+var\(--st-accent\)/);
 assert.match(declarations(css,'.st-note-editor .cm-lp-highlight').background,/--note-highlight/);assert.match(declarations(typography,'.st-note-surface .st-safe-note-markdown mark').background,/--note-highlight/);
});

test('add controls are full grid-border strips and idle handles have no visible exception',()=>{
 const right=declarations(css,'.cm-lp-table-tools .cm-lp-table-edge--right'),bottom=declarations(css,'.cm-lp-table-tools .cm-lp-table-edge--bottom');
 assert.equal(right.height,'var(--table-height,100%)');assert.equal(right.top,'var(--table-top,18px)');assert.equal(right['border-left'],'0');assert.equal(right.transform,'none');
 assert.equal(bottom.width,'100%');assert.equal(bottom.left,'0');assert.equal(bottom['border-top'],'0');assert.equal(bottom.transform,'none');
 assert.equal(declarations(css,'.cm-lp-table-wrap:not(.has-table-selection) .cm-lp-table-tools').display,'none');
 assert.equal(declarations(css,'.cm-lp-table-input[hidden]').display,'none');
 assert.equal(declarations(css,'.st-note-editor.is-cm .cm-line.cm-lp-blank-separator')['line-height'],'.55em');
 assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g,''),/\.cm-gap[^{}]*\{/,'native virtualization geometry must not be styled');
});
