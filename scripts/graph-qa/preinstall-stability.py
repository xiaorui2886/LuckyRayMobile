"""Read-only fresh-AVD launcher stability, not a RoleManager completion guarantee."""
import json, os, pathlib, re, subprocess, sys, time

def canonical(component):
    package, activity=component.split("/",1)
    return package+"/"+(package+activity if activity.startswith(".") else activity)

def assess(sample, previous_pid=None):
    if sample['systemErrorWindows']:
        return 'blocked-system-dialog'
    pid=sample['pid']
    if previous_pid and ((pid and previous_pid!=pid) or sample.get('pidProbeExit')==1):
        return 'blocked-system-server-restart'
    healthy=(sample['probeSuccess'] and pid.isdigit() and sample['boot']=='1'
        and sample['package']=='Service package: found' and sample['zygote']=='running'
        and sample['bootAnimation']=='stopped' and bool(sample['launcher'])
        and bool(sample['focus']) and all(canonical(c)==canonical(sample['launcher']) for c in sample['focus']))
    return 'healthy' if healthy else 'not-ready'

def main():
    if any(os.environ.get(k)!=v for k,v in [('GITHUB_ACTIONS','true'),('CI_GRAPH_QA_REVIEWED','yes'),('ANDROID_SERIAL','emulator-5554')]):return 2
    phase=sys.argv[1] if len(sys.argv)>1 else ''
    if phase not in ('preflight','before-install'):return 2
    out=pathlib.Path(os.environ['GRAPH_QA_EVIDENCE']);out.mkdir(parents=True,exist_ok=True)
    start=time.monotonic();deadline=start+300; samples=[]; waits=[];old_pid=None;stable_since=None
    def adb(*args, limit=12):
        remaining=deadline-time.monotonic()
        if remaining<=0:return 124,''
        try:
            p=subprocess.run(['adb','-s','emulator-5554',*args],text=True,capture_output=True,timeout=min(limit,remaining))
            return p.returncode,p.stdout[:200000]
        except subprocess.TimeoutExpired:return 124,''
    def finish(status):
        result={'phase':phase,'status':status,'elapsedSeconds':round(time.monotonic()-start,2),'requiredStableSeconds':120,'limitSeconds':300,'roleInitializationCompleteClaim':False,'settingsChanged':False,'packageQueueWaits':waits,'samples':samples}
        (out/('launcher-stability-'+phase+'.json')).write_text(json.dumps(result,indent=2)+'\n')
        print('GRAPH_QA_LAUNCHER_STABILITY '+json.dumps(result),flush=True)
        return 0 if status=='stable-observation-pass' else 3
    # These commands only observe/wait for PM queues. API30 has no such commands.
    code,help_text=adb('shell','cmd','package','help')
    if code==0:
        for command in ('wait-for-handler','wait-for-background-handler'):
            if re.search(r'^\s*'+re.escape(command)+r'(?:\s|$)',help_text,re.M):
                code,text=adb('shell','cmd','package',command,'--timeout','15000',limit=18)
                waits.append({'command':command,'exit':code,'success':text.strip()=='Success'})
    while time.monotonic()<deadline:
        fields={};success=True
        queries={'pid':('pidof','system_server'),'boot':('getprop','sys.boot_completed'),'package':('service','check','package'),'zygote':('getprop','init.svc.zygote'),'bootAnimation':('getprop','init.svc.bootanim')}
        for key,args in queries.items():
            code,value=adb('shell',*args);fields[key]=value.strip();success &= code==0
            if key=='pid':fields['pidProbeExit']=code
        code,raw=adb('shell','cmd','package','resolve-activity','--brief','-a','android.intent.action.MAIN','-c','android.intent.category.HOME')
        components=re.findall(r'^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$',raw,re.M)
        fields['launcher']=components[-1] if code==0 and components else None;success &= code==0
        code,windows=adb('shell','dumpsys','window');success &= code==0
        fields['focus']=[c for line in windows.splitlines() if 'mCurrentFocus=' in line for c in re.findall(r'[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+',line)]
        fields['systemErrorWindows']=[line[:400] for line in windows.splitlines() if re.search(r'Application (?:Not Responding|Error):|TYPE_SYSTEM_ERROR|type=2010|ty=SYSTEM_ERROR',line,re.I)][:8]
        fields['probeSuccess']=success;fields['elapsedSeconds']=round(time.monotonic()-start,2)
        state=assess(fields,old_pid);fields['observation']=state;samples.append(fields)
        print('GRAPH_QA_LAUNCHER_SAMPLE '+json.dumps(fields),flush=True)
        if state.startswith('blocked-'):return finish(state)
        if fields['pid'].isdigit():old_pid=fields['pid']
        if state=='healthy':
            if stable_since is None:stable_since=time.monotonic()
            if time.monotonic()-stable_since>=120:return finish('stable-observation-pass')
        else:stable_since=None
        time.sleep(min(10,max(0,deadline-time.monotonic())))
    return finish('infrastructure-stability-timeout')

if __name__=='__main__':sys.exit(main())
