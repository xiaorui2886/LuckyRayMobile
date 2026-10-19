// Windows/local executor: production React + synthetic IPC, never native UAT.
// Required: LUCKYRAY_QA_BROWSER, LUCKYRAY_QA_PLAYWRIGHT. Runs only opt-in.
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {withoutToolbarOverscroll} from './navigationBoundaryVariant.mjs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const compareBoundary=process.env.LUCKYRAY_QA_BOUNDARY_AB==='1';
const browser=process.env.LUCKYRAY_QA_BROWSER;
if(!browser||!existsSync(browser))throw new Error('Set LUCKYRAY_QA_BROWSER to the verified installed Chromium executable');
const parent=resolve(process.argv[2]||'output/playwright/navigation-repair');mkdirSync(parent,{recursive:true});
const out=mkdtempSync(resolve(parent,'run-')),bundle=resolve(out,'production');
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const report={kind:'production-React-synthetic-IPC-NOT-Android-UAT',outcome:'RUNNING',historyMode:process.env.LUCKYRAY_QA_HISTORY_ISOLATE==='1'?'single-document-QA-host-NOT-native-edge-Back':'browser-default',nativeEdgeBack:'NOT_RUN',out,runId:out,startedAt:new Date().toISOString(),browser:{executable:browser,sha256:sha(browser)},git:{},stages:[],suites:[]};
for(const [key,args] of [['head',['rev-parse','HEAD']],['status',['status','--short']],['indexTree',['write-tree']]])report.git[key]=spawnSync('git',args,{encoding:'utf8',windowsHide:true}).stdout.trim();
const save=()=>writeFileSync(resolve(out,'matrix-report.json'),JSON.stringify(report,null,2));
function run(name,args,env=process.env,required=true){
 report.stages.push({name,event:'START',at:new Date().toISOString()});save();
 const r=spawnSync(process.execPath,args,{env,encoding:'utf8',maxBuffer:32*1024*1024,timeout:300000,windowsHide:true});
 writeFileSync(resolve(out,name+'.log'),(r.stdout||'')+(r.stderr||'')+'\n'+JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message}));
 const result={name,exitCode:r.status,signal:r.signal,error:r.error?.message};report.stages.push({...result,event:'END',at:new Date().toISOString()});save();
 if(required&&(r.status!==0||r.signal||r.error))throw new Error(name+' failed; inspect stage log');return result;
}
try{
 run('build',['scripts/qa/buildReplicaS1Qa.mjs',bundle]);
 report.assets=['production/bundle.js','production/luckyray-mobile.css','production-base.css'].map(path=>({path,sha256:sha(resolve(out,path))}));save();
 const variants=[{name:'B-contained',bundle,required:true}];
 if(compareBoundary){
  const baseline=resolve(out,'A-uncontained','production');mkdirSync(baseline,{recursive:true});
  copyFileSync(resolve(bundle,'bundle.js'),resolve(baseline,'bundle.js'));
  copyFileSync(resolve(out,'production-base.css'),resolve(out,'A-uncontained','production-base.css'));
  writeFileSync(resolve(baseline,'luckyray-mobile.css'),withoutToolbarOverscroll(readFileSync(resolve(bundle,'luckyray-mobile.css'),'utf8')));
  report.comparison={kind:'same diagnostic harness and browser; only generated toolbar overscroll CSS differs',
   baselineCssSha256:sha(resolve(baseline,'luckyray-mobile.css')),candidateCssSha256:sha(resolve(bundle,'luckyray-mobile.css')),
   bundleSha256:sha(resolve(bundle,'bundle.js'))};
  if(sha(resolve(baseline,'bundle.js'))!==report.comparison.bundleSha256)throw new Error('A/B JS mismatch');
  variants.unshift({name:'A-uncontained',bundle:baseline,required:false});
 }
 let failed=false;
 for(const variant of variants)for(const reduced of ['on','off'])for(const suite of (variant.required?['knowledgeNavigationRepair','knowledgeTapEditing']:['knowledgeNavigationRepair'])){
  const name=variant.name+'-'+reduced+'-'+suite,dest=resolve(out,name);
  const result=run(name,['--test','scripts/qa/'+suite+'.test.mjs'],{...process.env,LUCKYRAY_QA_BUNDLE:variant.bundle,LUCKYRAY_QA_OUT:dest,LUCKYRAY_QA_REDUCED:reduced,LUCKYRAY_QA_RUN_ID:out},false);
  const reportPath=resolve(dest,'report.json');
  let cases,reportError;
  try{cases=JSON.parse(readFileSync(reportPath,'utf8'));}catch(error){reportError=String(error);}
  const pass=result.exitCode===0&&!result.signal&&!result.error&&Array.isArray(cases?.cases)&&Array.isArray(cases?.errors)
    &&!cases.errors.length&&cases.cases.every(c=>c.outcome==='PASS')&&cases.cases.length>=(suite==='knowledgeNavigationRepair'?6:9);
  report.suites.push({name,variant:variant.name,required:variant.required,gateOutcome:pass?'PASS':'FAIL',reportPath,
    reportSha256:existsSync(reportPath)?sha(reportPath):null,reportError,...cases});save();
  if(variant.required&&!pass)failed=true;
 }
 if(failed)throw new Error('Candidate matrix failed; stop APK work and return all unique reports. No automatic retry.');
 report.outcome='PASS';
}catch(e){report.outcome='FAIL';report.error=String(e);process.exitCode=1}finally{report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({outcome:report.outcome,report:resolve(out,'matrix-report.json')}))}
