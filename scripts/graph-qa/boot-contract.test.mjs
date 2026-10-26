import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const source=readFileSync(new URL('./boot-avd.sh',import.meta.url),'utf8');
const guard=source.split("<<'PY_REUSE'\n")[1].split('\nPY_REUSE')[0];
test('actual reuse guard rejects changed run/attempt/API/profile and missing proof',()=>{
 const dir=mkdtempSync(join(tmpdir(),'unified-avd-guard-'));try{
 const config=join(dir,'config.ini'),marker=join(dir,'marker.json');writeFileSync(config,'synthetic config');
 const proof={avd:'lr_test',api:'35',runId:'1',attempt:'1',noApp:true,preflightPassed:true,normalShutdown:true,configSha256:createHash('sha256').update('synthetic config').digest('hex')};
 const run=()=>spawnSync('python3',['-',marker,'lr_test','35','1','1',config],{input:guard,encoding:'utf8'}).status;
 writeFileSync(marker,JSON.stringify(proof));assert.equal(run(),0);
 for(const [key,value] of [['runId','2'],['attempt','2'],['api','30'],['noApp',false],['normalShutdown',false],['preflightPassed',false]]){writeFileSync(marker,JSON.stringify({...proof,[key]:value}));assert.notEqual(run(),0,key);}
 writeFileSync(marker,JSON.stringify(proof));writeFileSync(config,'changed config');assert.notEqual(run(),0);
 rmSync(marker);assert.notEqual(run(),0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('normal-shutdown marker is after driver and failed runs do not publish it',()=>{
 assert.ok(source.indexOf('"$GRAPH_TEST_DRIVER"\n')<source.indexOf("<<'PY_MARKER'"));
 assert.ok(source.indexOf('wait "$pid"')<source.indexOf("<<'PY_MARKER'"));
 assert.match(source,/\[\[ "\$phase" != preflight \]\] \|\| wipe_args=\(-wipe-data\)/);
 assert.match(source,/packages=\$\([^\n]+\) \|\| exit 3/);
 assert.ok(!source.includes('-no-snapshot -wipe-data'));
});
