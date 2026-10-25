import test from 'node:test';
import assert from 'node:assert/strict';
import { wikiChoiceRows } from '../src/still/kit/wikiChoiceRows.ts';
import { wikiInsertion, wikiCompletionAt, wikiCompletionInsertion } from '../src/presentation/still01/editor/wikiCompletion.ts';

test('same-name local suggestions expose folders and previews but insert exact stable IDs', () => {
  const rows = [
    { noteId: 'note-alpha', title: '计划', folder: '工作/本周', content: '会议\n资料' },
    { noteId: 'note-beta', title: '计划', folder: '生活', content: '出行安排' },
  ];
  const choices = wikiChoiceRows(rows, '计划');
  assert.equal(choices.length, 2);
  assert.match(choices[0].detail!, /文件夹：工作\/本周 · 会议 资料/);
  assert.match(choices[1].detail!, /文件夹：生活 · 出行安排/);
  assert.deepEqual(choices.map(wiki => wikiInsertion(wiki)), ['[[note-alpha|计划]]', '[[note-beta|计划]]']);
  assert.deepEqual(rows.map(row => row.content), ['会议\n资料', '出行安排']);
});
test('empty root notes have a human fallback and unsafe local IDs cannot enter suggestions', () => {
  const choices = wikiChoiceRows([{ noteId: 'note-root', title: '空白' }, { noteId: '../other.md', title: '空白' }], '');
  assert.equal(choices.length, 1);
  assert.match(choices[0].detail!, /^文件夹：根目录 · 暂无摘要/);
});
test('desktop suggestions retain exact scoped paths and reject any foreign row', () => {
  const scope = { instance: 'desktop-a', vault: 'vault-a' };
  const row = { instanceId: scope.instance, vaultId: scope.vault, noteId: 'kn-a', title: '计划', relativePath: '工作/计划.md', content: 'not trusted for preview' };
  assert.deepEqual(wikiChoiceRows([row], '', scope), [{ id: 'kn-a', title: '计划', target: '工作/计划.md', detail: '工作/计划.md' }]);
  assert.throws(() => wikiChoiceRows([row, { ...row, vaultId: 'vault-b' }], '', scope), /CONTENT_SOURCE_CHANGED/);
  assert.throws(() => wikiChoiceRows([row, { ...row, instanceId: 'desktop-b' }], '', scope), /CONTENT_SOURCE_CHANGED/);
});
test('choosing a stable local target preserves an explicit alias and heading verbatim', () => {
  const choice = wikiChoiceRows([{ noteId: 'note-a', title: '新标题', folder: '资料', content: '摘要' }], '')[0];
  const source = '[[旧标题#章节|自定义别名]]';
  const match = wikiCompletionAt(source, 3)!;
  assert.equal(wikiCompletionInsertion(choice, match), '[[note-a#章节|自定义别名]]');
});

test('bounded secondary text does not leak a full body or alter Unicode targets', () => {
  const [choice] = wikiChoiceRows([{ noteId: 'note-unicode', title: '旅行😀', folder: '资料\u202e/旅行', content: '😀'.repeat(1000) }], '旅行');
  assert.ok(choice.detail!.length < 350);
  assert.equal(choice.detail!.includes('\u202e'), false);
  assert.equal(choice.target, 'note-unicode');
  assert.equal(wikiInsertion(choice), '[[note-unicode|旅行😀]]');
});
