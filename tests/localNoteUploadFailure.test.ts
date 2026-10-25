import test from 'node:test';
import assert from 'node:assert/strict';
import { localNoteUploadFailure } from '../src/services/localNoteUploadFailure.ts';
const code = 'LOCAL_NOTE_UPLOAD_RESOURCES_UNSUPPORTED';
test('known native diagnostic gives line and filename without a success claim', () => {
  const result = localNoteUploadFailure(`${code}:${JSON.stringify({line:42,reference:'原型.html'})}`);
  assert.match(result, /第 42 行的「原型.html」/);
  assert.match(result, /未提交上传，本机原件保留/);
  assert.doesNotMatch(result, /上传成功|已加入同步队列/);
});
test('old native versions and malformed diagnostics remain friendly', () => {
  for (const value of [code, `${code}:oops`, `${code}:null`, `${code}:[]`, `${code}:{"line":-1,"reference":"a"}`, `${code}:{"line":1,"reference":{}}`]) {
    assert.match(localNoteUploadFailure(value), /暂不支持转移/);
    assert.doesNotMatch(localNoteUploadFailure(value), /LOCAL_NOTE|oops/);
  }
});
test('display metadata is bounded and strips bidi/control characters', () => {
  const result = localNoteUploadFailure(`${code}:${JSON.stringify({line:1,reference:'\u202e\n'+'测'.repeat(100)})}`);
  assert.equal((result.match(/测/g) || []).length, 64);
  assert.doesNotMatch(result, /\u202e|\n/);
});
test('unknown backend diagnostics are not copied into the interface', () => {
  assert.doesNotMatch(localNoteUploadFailure('file:///private/secret?token=abc'), /private|secret|abc/);
  assert.match(localNoteUploadFailure('LOCAL_NOTE_UPLOAD_TOO_LARGE'), /4 MiB/);
  assert.match(localNoteUploadFailure('TARGET_CHANGED'), /重新选择/);
});
