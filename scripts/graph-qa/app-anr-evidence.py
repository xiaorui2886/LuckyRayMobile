"""Normal-shell, bounded, package-scoped ANR diagnostics; never changes device state."""
import json,os,pathlib,re,subprocess,sys
PACKAGE='com.luckyray.mobile'
def redact(lines,limit=100):
    return ['[credential-related line redacted]' if re.search(r'token|secret|password|authorization|credential|jwt|cookie|bearer|pairing|payload|\bfp\b',s,re.I) else s[:1000] for s in lines[:limit]]
def package_anr_blocks(text):
    selected=[];active=False;count=0
    for line in text.splitlines():
        if re.search(r'ANR in |Application Not Responding:',line):
            active=bool(re.search(r'\bcom\.luckyray\.mobile\b',line));count=0
        if active:
            if count>=60:active=False;continue
            # Only AM/ATM event records; stop at an unrelated tag or later ANR.
            if re.search(r'ActivityManager:|ActivityTaskManager:',line):selected.append(line);count+=1
            elif line.strip():active=False
    return redact(selected)
def main():
    if any(os.environ.get(k)!=v for k,v in [('GITHUB_ACTIONS','true'),('CI_GRAPH_QA_REVIEWED','yes'),('ANDROID_SERIAL','emulator-5554')]):return 2
    phase=sys.argv[1] if len(sys.argv)>1 else ''
    if not re.fullmatch(r'[a-z0-9-]{1,50}',phase):return 2
    def adb(*args):
        try:
            p=subprocess.run(['adb','-s','emulator-5554',*args],capture_output=True,text=True,timeout=10)
            return p.returncode,p.stdout[:500000]
        except subprocess.TimeoutExpired:return 124,''
    pid_exit,pid=adb('shell','pidof',PACKAGE);pid=pid.strip()
    native_exit,native=adb('logcat','-d','-t','150','--pid='+pid) if pid.isdigit() else (1,'')
    am_exit,am=adb('logcat','-b','system','-d','-t','500','ActivityManager:I','ActivityTaskManager:I','*:S')
    last_exit,last=adb('shell','dumpsys','activity','lastanr')
    # lastanr can describe another package: keep nothing unless its Process line is exact.
    own_last=bool(re.search(r'^\s*(?:Process:|ANR in)\s+com\.luckyray\.mobile(?:\s|$)',last,re.M))
    result={'phase':phase,'package':PACKAGE,'pid':pid if pid.isdigit() else None,'pidProbeExit':pid_exit,'nativeProbeExit':native_exit,'nativeLines':redact(native.splitlines()),'activityManagerProbeExit':am_exit,'packageAnrRecords':package_anr_blocks(am),'lastAnrProbeExit':last_exit,'lastAnrMatchesPackage':own_last,'lastAnrLines':redact(last.splitlines(),120) if own_last else [],'rootOrPermissionChanges':False,'privateAnrDirectoryRead':False,'mainThreadTraceAvailableClaim':False}
    out=pathlib.Path(os.environ['GRAPH_QA_EVIDENCE']);(out/('app-anr-'+phase+'.json')).write_text(json.dumps(result,indent=2)+'\n')
    print('GRAPH_QA_APP_ANR_EVIDENCE '+json.dumps(result),flush=True)
    return 0
if __name__=='__main__':sys.exit(main())
