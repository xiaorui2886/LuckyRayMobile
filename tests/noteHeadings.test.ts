import assert from 'node:assert/strict';
import test from 'node:test';
import { headingEditorOffset, noteHeadings, resolveNoteHeading, splitWikiHeading } from '../src/still/kit/noteHeadings.ts';

test('real ATX and setext headings retain exact source positions; code and escaped markers do not', () => {
  const body = '# 标题\r\n\r\nSetext **bold**\r\n---\r\n\r\n```md\r\n# fake\r\n```\r\n\r\n    # indented code\r\n\r\n\\# escaped\r\n\r\n> ## Nested `code`\r\n';
  const headings = noteHeadings(body);
  assert.deepEqual(headings.map(h => [h.label,h.depth]), [['标题',1],['Setext bold',2],['Nested code',2]]);
  assert.equal(body.slice(headings[1].from, headings[1].to), 'Setext **bold**\r\n---');
  assert.equal(headings[2].from, body.indexOf('## Nested')); assert.equal(headings[0].line, 1);
});
test('inline semantic labels agree with reader, including entities, images, code and wiki aliases', () => {
  const [heading] = noteHeadings('# **Bold** &amp; [Link](https://example.com) ![Alt](asset) `Code` [[note-id|Alias]]');
  assert.equal(heading.label, 'Bold & Link Alt Code Alias');
});
test('Unicode normalization, duplicates and literal suffix collisions have stable unique keys', () => {
  const body = '# 中文 标题\n# Café\n# Cafe\u0301\n# café-1\n# 中文 标题';
  const headings = noteHeadings(body);
  assert.deepEqual(headings.map(h => h.id), ['中文-标题','café','café-1','café-1-1','中文-标题-1']);
  assert.deepEqual(noteHeadings(body), headings);
  assert.equal(resolveNoteHeading(headings, 'CAFE\u0301'), headings[1]);
  assert.equal(resolveNoteHeading(headings, '中文-标题-1'), headings[4]);
  assert.equal(resolveNoteHeading(headings, encodeURIComponent('中文 标题')), headings[0]);
  assert.equal(resolveNoteHeading(headings, 'not present'), undefined);
  assert.equal(resolveNoteHeading(headings, '%broken'), undefined);
  assert.equal(resolveNoteHeading(headings, ''), undefined);
});
test('fragments split from identity without interpreting paths or decoding note IDs', () => {
  assert.deepEqual(splitWikiHeading('note-stable#中文 标题'), {noteTarget:'note-stable',heading:'中文 标题'});
  assert.deepEqual(splitWikiHeading('#中文 标题'), {noteTarget:'',heading:'中文 标题'});
  assert.deepEqual(splitWikiHeading('Note'), {noteTarget:'Note'});
  assert.deepEqual(splitWikiHeading('../Note.md#A#B'), {noteTarget:'../Note.md',heading:'A#B'});
  assert.equal(splitWikiHeading('Note#'), undefined);
  assert.equal(splitWikiHeading('Note#bad\u0000'), undefined);
});
test('CRLF source offsets map only to the same normalized editor document', () => {
  const source = '# one\r\n\r\n## two\r\n', editor = source.replace(/\r\n/g,'\n');
  const target = noteHeadings(source)[1].from;
  assert.equal(headingEditorOffset(source, editor, target), editor.indexOf('## two'));
  assert.equal(headingEditorOffset(source, 'different', target), undefined);
  assert.equal(headingEditorOffset(source, source, target), target);
  assert.equal(headingEditorOffset(source, editor, -1), undefined);
});

test('literal heading wins a slug collision and encoded hash resolves only inside the fragment', () => {
  const headings = noteHeadings('# Hello World\n# hello-world\n# A#B\n# 100% real');
  assert.equal(resolveNoteHeading(headings, 'hello-world'), headings[1]);
  assert.equal(resolveNoteHeading(headings, 'A%23B'), headings[2]);
  assert.equal(resolveNoteHeading(headings, '100% real'), headings[3]);
  assert.deepEqual(splitWikiHeading('Note%23Name#A%23B'), {noteTarget:'Note%23Name',heading:'A%23B'});
  assert.deepEqual(splitWikiHeading('Note%23Name'), {noteTarget:'Note%23Name'});
});
