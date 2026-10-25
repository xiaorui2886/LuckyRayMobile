"""Bounded read-only system-service evidence for a fresh synthetic AVD only."""
import json,os,pathlib,re,subprocess,sys,time

def clean(line):
    return '[credential-related line redacted]' if re.search(r'token|secret|password|authorization|credential|jwt|cookie',line,re.I) else line[:1000]

if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('CI_GRAPH_QA_REVIEWED')!='yes' or os.environ.get('ANDROID_SERIAL')!='emulator-5554':
    raise SystemExit('isolated reviewed AVD required')
phase=sys.argv[1]
if phase not in ('before-install','after-install','install-failure'):raise SystemExit(2)
out=pathlib.Path(os.environ['GRAPH_QA_EVIDENCE']);started=time.monotonic()
def adb(*args):
    try:
        r=subprocess.run(['adb','-s','emulator-5554',*args],capture_output=True,text=True,timeout=10)
        return {'exit':r.returncode,'text':r.stdout.strip()[:2000],'stderr':clean(r.stderr.strip())}
    except subprocess.TimeoutExpired:return {'exit':124,'text':'','stderr':'bounded diagnostic timeout'}

state={'phase':phase,'bootCompleted':adb('shell','getprop','sys.boot_completed'),'packageService':adb('shell','service','check','package'),'systemServerPid':adb('shell','pidof','system_server'),'zygote':adb('shell','getprop','init.svc.zygote'),'zygote64':adb('shell','getprop','init.svc.zygote64')}
healthy=all(state[k]['exit']==0 for k in ('bootCompleted','packageService','systemServerPid')) and state['bootCompleted']['text']=='1' and 'not found' not in state['packageService']['text'] and 'found' in state['packageService']['text'] and bool(re.fullmatch(r'\d+(?: \d+)*',state['systemServerPid']['text']))
state['serviceReady']=healthy
if phase=='install-failure' or not healthy:
    pids=set(state['systemServerPid']['text'].split())
    before=out/'system-state-before-install.json'
    if before.exists():
        pids.update(json.loads(before.read_text()).get('systemServerPid',{}).get('text','').split())
    pids={p for p in pids if p.isdigit()}
    # Only system/crash buffers, bounded in adb and time; publish only selected service/PID records.
    try:
        r=subprocess.run(['adb','-s','emulator-5554','logcat','-b','system','-b','crash','-d','-t','250'],capture_output=True,text=True,timeout=10)
        lines=r.stdout.splitlines();selected=[]
        for line in lines:
            m=re.match(r'^\S+\s+\S+\s+(\d+)\s+\d+\s',line)
            if (m and m.group(1) in pids) or re.search(r'system_server|Watchdog|FATAL EXCEPTION IN SYSTEM PROCESS|PackageManager|lowmemorykiller|lmkd',line,re.I):selected.append(clean(line))
        state['systemServiceRecords']=selected[-80:]
    except subprocess.TimeoutExpired:state['systemServiceRecords']=['bounded system record timeout']
state['elapsedMs']=round((time.monotonic()-started)*1000)
(out/('system-state-'+phase+'.json')).write_text(json.dumps(state,indent=2)+'\n')
print('GRAPH_QA_SYSTEM_STATE '+json.dumps(state))
if not healthy and phase!='install-failure':raise SystemExit(3)
