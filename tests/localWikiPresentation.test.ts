import test from 'node:test';
import assert from 'node:assert/strict';
import { localWikiPreview, localWikiChoiceDetail, localWikiReferences, resolveLocalWiki } from '../src/still/kit/localWiki.ts';
test('choice previews are bounded plain text, not rendered HTML or full bodies', () => {
  assert.equal(localWikiPreview('\u202ehello\n world\t'), 'hello world');
  assert.equal(Array.from(localWikiPreview('😀'.repeat(1000))).length, 90);
  assert.equal(localWikiPreview(null), '');
  const detail = localWikiChoiceDetail({ noteId: 'note-123456789', title: 'same', preview: '<script>synthetic</script>', updatedAt: 'invalid' });
  assert.equal(detail, '<script>synthetic</script> · 编号 23456789');
});
test('ambiguous choices retain catalog previews without reading any arbitrary target', async () => {
  const rows = [{noteId:'note-first',title:'same',content:'first preview',updatedAt:'2026-10-08T12:00:00Z'}, {noteId:'note-second',title:'same',content:'second preview'}];
  let reads = 0;
  const result = await resolveLocalWiki(localWikiReferences('[[same]]')[0], { list:async()=>({items:rows,total:2,hasMore:false}),get:async()=>{reads++;return rows[0];} });
  assert.equal(result.kind,'ambiguous'); assert.equal(reads,0);
  assert.deepEqual(result.notes.map(note=>note.preview),['first preview','second preview']);
  assert.ok(result.notes.every(note=>!('content' in note)));
});
