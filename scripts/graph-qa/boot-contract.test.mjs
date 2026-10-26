import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync,chmodSync} from 'node:fs';
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
 assert.match(source,/packages=\$\([^\n]+\) \|\| exit 3/);
 assert.ok(!source.includes('-no-snapshot -wipe-data'));
});

// Execute the production launch block, not a reimplementation or regex check.
// On macOS CI this explicitly uses Apple's /bin/bash (3.2), before any APK build.
test('real emulator argv: only preflight wipes; installed reopens without wipe under nounset',()=>{
 const shell=process.env.GRAPH_QA_TEST_BASH || '/bin/bash';
 const version=spawnSync(shell,['--version'],{encoding:'utf8'});
 assert.equal(version.status,0); console.log(version.stdout.split('\n')[0]);
 const launch=source.split('echo GRAPH_QA_PHASE_START_emulator_boot\n')[1]?.split('\nreport_boot_failure() {')[0];
 assert.ok(launch?.includes('pid=$!'),'production launch block found');
 const dir=mkdtempSync(join(tmpdir(),'avd argv contract '));
 try {
  const sdk=join(dir,'sdk with spaces'); mkdirSync(join(sdk,'emulator'),{recursive:true});
  const stub=join(sdk,'emulator','emulator');
  writeFileSync(stub,`#!/bin/bash\nset -eu\nprintf '%s\\0' "$@" > "$CAPTURE"\n`); chmodSync(stub,0o755);
  for(const phase of ['preflight','installed']) {
   const capture=join(dir,phase+'.argv');
   const result=spawnSync(shell,['-c','set -euo pipefail\n'+launch+'\nwait "$pid"\n','contract','unexpected-inherited-argument'],{
    env:{...process.env,ANDROID_HOME:sdk,RUNNER_TEMP:dir,CAPTURE:capture,phase,name:'synthetic avd',accel:'on'},encoding:'utf8'
   });
   assert.equal(result.status,0,phase+': '+result.stderr);
   const argv=readFileSync(capture,'utf8').split('\0'); assert.equal(argv.pop(),'');
   assert.deepEqual(argv,['-avd','synthetic avd','-accel','on','-port','5554','-no-window','-no-audio','-no-snapshot',
    ...(phase==='preflight'?['-wipe-data']:[]),'-gpu','software','-memory','3072','-partition-size','4096','-no-boot-anim'],phase);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
