"""Do not let CDP input pass behind an Android ANR/system error dialog."""
import json,os,pathlib,re,subprocess,sys,xml.etree.ElementTree as ET
if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('CI_GRAPH_QA_REVIEWED')!='yes' or os.environ.get('ANDROID_SERIAL')!='emulator-5554':raise SystemExit(2)
name=sys.argv[1]
if not re.fullmatch(r'[a-z0-9-]{1,50}',name):raise SystemExit(2)
out=pathlib.Path(os.environ['GRAPH_QA_EVIDENCE'])
def adb(*args):
    try:
        r=subprocess.run(['adb','-s','emulator-5554',*args],capture_output=True,text=True,timeout=12)
        return r.returncode,r.stdout[:1000000]
    except subprocess.TimeoutExpired:return 124,''
status,windows=adb('shell','dumpsys','window','windows')
focus=[{'field':m.group(1),'components':re.findall(r'[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+',line)} for line in windows.splitlines() if (m:=re.search(r'(mCurrentFocus|mFocusedApp)',line))]
error_windows=[line[:500] for line in windows.splitlines() if re.search(r'Application (?:Not Responding|Error):|TYPE_SYSTEM_ERROR|type=2010|ty=SYSTEM_ERROR',line,re.I)]
ui_status,_=adb('shell','uiautomator','dump','--compressed','/data/local/tmp/graph-qa-window.xml')
ui_read,xml=adb('exec-out','cat','/data/local/tmp/graph-qa-window.xml') if ui_status==0 else (ui_status,'')
alerts=[];ui_valid=False;ui_foreground_package=None
try:
    root=ET.fromstring(xml);nodes=list(root.iter('node'));ui_valid=bool(nodes);ui_foreground_package=nodes[0].attrib.get('package') if nodes else None
    for n in root.iter('node'):
        text=n.attrib.get('text','')+' '+n.attrib.get('content-desc','')
        if re.search(r"isn.t responding|not responding|无响应|没有响应|屡次停止|keeps stopping|已停止运行",text,re.I):
            alerts.append({'package':n.attrib.get('package','')[:100],'text':text[:300]})
except ET.ParseError:pass
blocked=bool(alerts or error_windows)
current=[f for f in focus if f['field']=='mCurrentFocus']
app_focused=all(f['components'] and all(c.startswith('com.luckyray.mobile/') for c in f['components']) for f in current) if current else ui_foreground_package=='com.luckyray.mobile'
observable=((status==0 and bool(current)) or ui_valid) and app_focused
result={'phase':name,'status':'infrastructure-blocked-system-dialog' if blocked else 'observable-no-system-error-dialog' if observable else 'infrastructure-ui-evidence-unavailable','appFocused':app_focused,'uiForegroundPackage':ui_foreground_package,'windowProbeExit':status,'uiProbeExit':ui_status,'focus':focus[:8],'systemErrorWindows':error_windows[:8],'alerts':alerts[:8],'dialogDismissed':False}
(out/('system-ui-'+name+'.json')).write_text(json.dumps(result,indent=2)+'\n')
print('GRAPH_QA_SYSTEM_UI '+json.dumps(result))
if blocked or not observable:raise SystemExit(3)
