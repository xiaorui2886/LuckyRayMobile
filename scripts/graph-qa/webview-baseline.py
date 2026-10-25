"""Read actual selected provider, fail closed before expensive app build if below target."""
import json,pathlib,re,sys

def classify(text):
    match=re.search(r'Current WebView package \(name, version\):\s*\(([^,]+),\s*([0-9]+(?:\.[0-9]+)+)\)',text)
    provider,version=match.groups() if match else (None,None)
    major=int(version.split('.')[0]) if version else None
    return {'baselineMajor':83,'actualProvider':provider,'actualVersion':version,'status':'supported-baseline' if major is not None and major>=83 else 'unsupported-baseline' if major is not None else 'unknown-provider','productTests':'eligible' if major is not None and major>=83 else 'NOT_RUN','physicalDeviceEquivalence':False}

if __name__=='__main__':
    result=classify(pathlib.Path(sys.argv[1]).read_text())
    pathlib.Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
    print('GRAPH_QA_WEBVIEW_BASELINE '+json.dumps(result))
    if result['status']!='supported-baseline':
        print('App build/tests blocked: '+('actual WebView below Chrome 83 baseline' if result['status']=='unsupported-baseline' else 'infrastructure provider unavailable during startup')+'. This is NOT a product pass.')
        raise SystemExit(4 if result['status']=='unsupported-baseline' else 5)
