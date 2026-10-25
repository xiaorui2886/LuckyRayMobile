import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lshDiagnosticCode,lshErrorCopy} from '../src/still/kit/lshSurface.ts';
test('diagnostic output contains fixed codes/stages, never arbitrary input',()=>{for(const stage of ['source_gate','hello','state','session_mint','carrier_bootstrap'])assert.equal(lshDiagnosticCode('LSH_BOOTSTRAP_TIMEOUT:'+stage),'LSH_BOOTSTRAP_TIMEOUT:'+stage);assert.equal(lshDiagnosticCode('LSH_BOOTSTRAP_TIMEOUT:secret_token'),'LSH_BOOTSTRAP_TIMEOUT');assert.equal(lshDiagnosticCode('https://private.example/token?value=secret'),'LSH_UNKNOWN');assert.equal(lshDiagnosticCode('LSH_PAGE_LOAD_FAILED https://private.example'),'LSH_PAGE_LOAD_FAILED');assert.equal(lshDiagnosticCode(''),'');});
test('slow timer copy is neutral and unsupported engine copy requests an update without claiming success',()=>{const source=readFileSync(new URL('../src/still/kit/EmbeddedLshView.tsx',import.meta.url),'utf8');assert.ok(!source.includes('电脑仍在准备'));assert.ok(source.includes('连接时间较长，正在等待对话界面'));assert.ok(source.includes('<details'));assert.ok(lshErrorCopy('LSH_WEBVIEW_UPDATE_REQUIRED').includes('更新系统 WebView'));});

test('resume timeout is a specific fixed code and native lifecycle diagnostics contain no variable payload',()=>{
 assert.equal(lshDiagnosticCode('LSH_REVALIDATION_TIMEOUT'), 'LSH_REVALIDATION_TIMEOUT');
 assert.match(lshErrorCopy('LSH_REVALIDATION_TIMEOUT'), /恢复连接/);
 const source=readFileSync(new URL('../scripts/android-src/LshEmbeddedSurface.kt',import.meta.url),'utf8');
 for(const value of ['lease=retired','revalidation=timeout','revalidation=stale_lifecycle','renderer=resumed','renderer=paused']) assert.ok(source.includes('"'+value+'"'));
 const lines=source.split('\n').filter(line=>line.includes('Log.i("LshPresentationDiag"')&&/lease=|revalidation=|renderer=/.test(line));
 assert.equal(lines.length,5);
 for(const line of lines)assert.doesNotMatch(line,/sessionUrl|pendingCapabilityUrl|owner|\+|\$/);
});
