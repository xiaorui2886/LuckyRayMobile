import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {safeError} from './safe-diagnostics.mjs';
test('nested JSON, escaped JSON and Bearer native failures never publish values',()=>{
 for(const text of ['{"outer":{"secret":"DO-NOT-PRINT"}}','{"error":"payload: {\\"secret\\":\\"DO-NOT-PRINT\\"}"}','HTTP failure Authorization: Bearer DO-NOT-PRINT','{"credential":"DO-NOT-PRINT"}','Pairing failed with DO-NOT-PRINT','{"token":"DO-NOT-PRINT"}']){
 assert.equal(safeError(new Error(text)),'Sensitive native diagnostic withheld');assert.ok(!safeError(text).includes('DO-NOT-PRINT'));
 }
 assert.equal(safeError('UI target missing: 图谱'),'UI target missing: 图谱');assert.equal(safeError('x'.repeat(1500)).length,1000);
});
test('public runtime, evaluate and final catch all route through sanitizer',()=>{
 const s=readFileSync(new URL('./installed-unified.mjs',import.meta.url),'utf8');
 assert.match(s,/const text=safeError\(raw\)/);assert.match(s,/safeError\(r.exceptionDetails.exception\?\.description\|\|r.exceptionDetails.text\)/);assert.match(s,/throw new Error\(safeError\(error\)\)/);assert.ok(!s.includes('message:String(error)'));
 const sh=readFileSync(new URL('./run-installed.sh',import.meta.url),'utf8');assert.ok(!/adb shell (?:svc|pm clear)/.test(sh));assert.match(sh,/umask 077/);assert.match(sh,/mkdir -m 700 "\$UNIFIED_PEER_RUNTIME"/);
});

test('native ANR line sanitizer rejects bare Bearer/payload/fingerprint lines',async()=>{
 const {spawnSync}=await import('node:child_process');
 const path=new URL('./app-anr-evidence.py',import.meta.url).pathname;
 const result=spawnSync('python3',['-c',"import runpy,sys,json; f=runpy.run_path(sys.argv[1])['redact']; print(json.dumps(f(['Bearer DO-NOT-PRINT','payload DO-NOT-PRINT','fp DO-NOT-PRINT','{\"secret\":\"DO-NOT-PRINT\"}'])))",path],{encoding:'utf8'});
 assert.equal(result.status,0);assert.ok(!result.stdout.includes('DO-NOT-PRINT'));assert.equal(JSON.parse(result.stdout).length,4);
});
