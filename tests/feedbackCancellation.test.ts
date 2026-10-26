import test from 'node:test';
import assert from 'node:assert/strict';
import {failureCopy,isExpectedRequestCancellation} from '../src/services/feedback.ts';
test('normal cancellation is distinguishable from real source changes',()=>{
 for(const error of [new DOMException('aborted','AbortError'),new Error('CANCELLED'),{code:'CONTENT_CANCELLED'},'THUMBNAIL_CANCELLED']) assert.equal(isExpectedRequestCancellation(error),true);
 for(const error of [new Error('SOURCE_CHANGED'),{code:'SOURCE_CHANGED',message:'CANCELLED'},new Error('network failed'),'NOT_CANCELLED_ERROR',null]) assert.equal(isExpectedRequestCancellation(error),false);
 assert.equal(failureCopy('CANCELLED'),'操作已取消。');
 assert.equal(failureCopy(new DOMException('aborted','AbortError')),'操作已取消。');
 assert.match(failureCopy('SOURCE_CHANGED'),/笔记库来源已变化/);
 assert.match(failureCopy({code:'SOURCE_CHANGED',message:'CANCELLED'}),/笔记库来源已变化/);
 assert.equal(failureCopy('NOT_CANCELLED_ERROR'),'操作没有完成，请重试。');
 assert.notEqual(failureCopy('CANCELLED'),'');
 assert.match(failureCopy('VAULT_IMPORT_SOURCE_CHANGED'),/导入来源或目标/);
});

test('vault creation failures explain the actionable recovery',()=>{
 assert.match(failureCopy('VAULT_REQUEST_CHANGED'),/原名称重试/);
 assert.match(failureCopy('VAULT_REQUEST_INVALID'),/请求无效/);
 assert.match(failureCopy('VAULT_NAME_INVALID'),/1–120/);
});

test('binding failures explain read-only recovery without exposing raw codes',()=>{
 for (const code of ['MANAGED_SYNC_BINDING_AMBIGUOUS','VAULT_BINDING_INVALID']) {
  assert.match(failureCopy(code),/只能阅读/);
  assert.match(failureCopy(code),/知识库管理/);
  assert.match(failureCopy(code),/尚未写入/);
  assert.ok(!failureCopy(code).includes(code));
 }
 assert.match(failureCopy('MANAGED_VAULT_UNAVAILABLE'),/返回知识库列表/);
});
