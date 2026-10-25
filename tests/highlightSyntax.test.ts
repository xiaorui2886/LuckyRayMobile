import test from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { highlightSyntax } from '../src/still/kit/highlightSyntax.ts';
const parse = (source: string): any => { const p = unified().use(remarkParse).use(remarkGfm).use(highlightSyntax(source)); return p.runSync(p.parse(source)); };
const all = (tree: any, type: string): any[] => [...(tree.type === type ? [tree] : []), ...(tree.children || []).flatMap((n: any) => all(n, type))];
for (const [source, expected] of [ ['==高亮==',1], ['文字 ==高亮== 和 ==第二处==',2], ['==**加粗**与*斜体*==',1], ['`==代码==`',0], ['```\n==代码==\n```',0], ['\\==转义==',0], ['&#61;&#61;实体==',0], ['===三等号===',0], ['====',0], ['== 空白 ==',0], ['==\n\n跨块==',0], ['标题\n====',0], ['[链接](https://example.com/==path==)',0], ['![==alt==](x)',0] ] as const) {
 test(`highlight ${JSON.stringify(source)}`, () => assert.equal(all(parse(source),'highlight').length, expected));
}
test('positions preserve UTF16, CRLF and entities before literal delimiter', () => {
 const source = '😀 &amp;\r\n==高亮😀=='; const node = all(parse(source),'highlight')[0];
 assert.equal(source.slice(node.position.start.offset,node.position.end.offset),'==高亮😀==');
 assert.equal(node.position.start.line,2); assert.equal(node.position.start.column,1);
 assert.equal(source.slice(node.children[0].position.start.offset,node.children[0].position.end.offset),'高亮😀');
});
test('mark wraps existing strong syntax; source remains unchanged', () => { const source='==**重要**=='; const node=all(parse(source),'highlight')[0]; assert.equal(node.children[0].type,'strong'); assert.equal(node.data.hName,'mark'); assert.equal(source,'==**重要**=='); });
test('highlight inside table cell and task text', () => { assert.equal(all(parse('| 标题 |\n|---|\n| ==内容== |\n\n- [ ] ==任务=='),'highlight').length,2); });
test('escaped neighbors do not prevent later literal highlight', () => assert.equal(all(parse('\\==literal== 与 ==真实=='),'highlight').length,1));
import { wikiSyntax } from '../src/still/kit/wikiSyntax.ts';
test('wiki destination and alias semantics are preserved; surrounding highlight works', () => {
 const source='==[[Target|Alias]]== 和 [[==Target==|Alias]]'; const refs = new Map();
 const p=unified().use(remarkParse).use(remarkGfm).use(wikiSyntax(source,refs)).use(highlightSyntax(source));
 const tree=p.runSync(p.parse(source)); assert.equal(refs.size,2); assert.equal(all(tree,'highlight').length,1);
 assert.equal(all(tree,'link').length,2); assert.deepEqual([...refs.values()].map(r=>r.target),['Target','==Target==']);
});
