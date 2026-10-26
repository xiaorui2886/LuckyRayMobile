#!/usr/bin/env python3
"""Run real endpoint contract/pinning/HTTPS tests with application-locked deps.

No Tauri mocks, pairing credentials, real profiles or phone configuration are
used. Tauri command assembly still requires the full Android build separately.
"""
from pathlib import Path
import argparse,os,re,shutil,subprocess,tempfile,tomllib
ROOT=Path(__file__).resolve().parent.parent

def function(text,name):
    match=re.search(r'(?m)^(?:pub(?:\(crate\))?\s+)?fn '+re.escape(name)+r'\(',text)
    if not match:raise RuntimeError('Missing canonical validator '+name)
    start=match.start();body=text.index('{',match.end());depth=0
    for end in range(body,len(text)):
        if text[end]=='{':depth+=1
        elif text[end]=='}':
            depth-=1
            if depth==0:return text[start:end+1]+'\n'
    raise RuntimeError('Incomplete validator '+name)

def identity(p):return tuple(p.get(k) for k in ('name','version','source','checksum'))

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--target');args=parser.parse_args()
    lock=ROOT/'src-tauri/Cargo.lock';original=lock.read_bytes();pkgs=tomllib.loads(original.decode())['package'];allowed={identity(p) for p in pkgs if 'source' in p}
    product=tomllib.loads((ROOT/'src-tauri/Cargo.toml').read_text());declared={**product['dependencies'],**product.get('dev-dependencies',{})}
    def version(name):
        requirement=declared[name];requirement=requirement['version'] if isinstance(requirement,dict) else requirement;prefix=requirement.lstrip('^~=')
        matches=[p['version'] for p in pkgs if p['name']==name and (p['version']==prefix or p['version'].startswith(prefix+'.'))]
        if len(matches)!=1:raise RuntimeError('Ambiguous locked version '+name)
        return matches[0]
    with tempfile.TemporaryDirectory(prefix='luckyray-endpoint-') as temp:
        work=Path(temp);src=work/'src';(src/'endpoint_recovery').mkdir(parents=True)
        for name in ['contract.rs','transport.rs']:shutil.copyfile(ROOT/'src-tauri/src/endpoint_recovery'/name,src/'endpoint_recovery'/name)
        shutil.copyfile(ROOT/'src-tauri/src/pinning.rs',src/'pinning.rs')
        shutil.copyfile(ROOT/'tests/endpointRecovery/transport.native.rs',src/'endpoint_recovery/transport_tests.rs')
        root_source=(ROOT/'src-tauri/src/lib.rs').read_text('utf-8')
        canonical='\n'.join(function(root_source,n) for n in ['is_private_lan_ipv4','is_lower_hex','validate_hello_identity','validate_pair_response','validate_session_response'])
        (src/'lib.rs').write_bytes(('mod pinning;\nmod endpoint_recovery {mod contract;mod transport;#[cfg(test)]mod transport_tests;}\n'+canonical).encode())
        (work/'Cargo.lock').write_bytes(original)
        manifest='''[package]
name="luckyray-endpoint-recovery-check"
version="0.0.0"
edition="2021"
publish=false
[dependencies]
'''
        extra={
            'serde':',features=["derive"]','serde_json':'','uuid':',features=["v4"]',
            'tokio':',features=["full"]',
            'reqwest':',default-features=false,features=["rustls-tls-manual-roots","stream","json"]',
            'rustls':',default-features=false,features=["ring","std","tls12"]',
            'sha2':'','x509-parser':'',
            'rcgen':'','tokio-rustls':',default-features=false,features=["ring","tls12"]',
        }
        manifest+=''.join(name+'={version="='+version(name)+'"'+features+'}\n' for name,features in extra.items())
        (work/'Cargo.toml').write_bytes(manifest.encode())
        env=os.environ.copy();env.setdefault('CARGO_BUILD_JOBS','2');env.setdefault('CARGO_TARGET_DIR',str(work/'target'))
        subprocess.run(['cargo','fetch','--offline'],cwd=work,env=env,check=True)
        for p in tomllib.loads((work/'Cargo.lock').read_text())['package']:
            if p['name']=='luckyray-endpoint-recovery-check' and 'source' not in p:continue
            if identity(p) not in allowed:raise RuntimeError('Dependency differs from application lock: '+p['name'])
        if lock.read_bytes()!=original:raise RuntimeError('Application lock changed')
        print('Canonical production validators, pinning and endpoint modules; every dependency matches application lock.',flush=True)
        cmd=['cargo','test','--lib','--locked','--offline']
        if args.target:cmd+=['--target',args.target]
        subprocess.run(cmd+['--','--test-threads=1'],cwd=work,env=env,check=True)
        print('Tauri commands/full Android assembly and real-device endpoint changes NOT_RUN by this focused gate.',flush=True)

if __name__=='__main__':main()
