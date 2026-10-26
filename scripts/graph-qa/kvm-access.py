"""One approved disposable runner only; exact-user KVM ACL, never world access."""
import json, os, pathlib, shutil, stat, subprocess, sys

REPO='xiaorui2886/LuckyRayMobile'
REF='refs/heads/ray/mobile-unified-vault-kvm-20261026-2124'
BASIC_ACL='user::rw-\ngroup::rw-\nother::---\n'

def expected_acl(uid):
    return f'user::rw-\nuser:{uid}:rw-\ngroup::rw-\nmask::rw-\nother::---'

def classify_acl(text, uid):
    text=text.strip()
    if text==expected_acl(uid):return 'exact-grant'
    if text in (BASIC_ACL.strip(), 'user::rw-\ngroup::rw-\nmask::rw-\nother::---'):return 'only-our-entry-missing'
    raise ValueError('Unexpected ACL principals/permissions; no overwrite or wider repair permitted')

def validate_context(env, event, uid, system):
    required={'GITHUB_ACTIONS':'true','CI_GRAPH_QA_REVIEWED':'yes','GITHUB_REPOSITORY':REPO,
              'GITHUB_REF':REF,'GITHUB_EVENT_NAME':'push','GITHUB_RUN_ATTEMPT':'1',
              'RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux'}
    if any(env.get(key)!=value for key,value in required.items()):
        raise ValueError('This approval is only for the first attempt of the exact fresh branch creation')
    if event.get('created') is not True or event.get('deleted') is not False or event.get('ref')!=REF:
        raise ValueError('Not the authorized fresh branch creation event')
    if event.get('repository',{}).get('full_name')!=REPO or event.get('before')!='0'*40:
        raise ValueError('Unexpected repository or existing ref update')
    if event.get('after')!=env.get('GITHUB_SHA') or len(env.get('GITHUB_SHA',''))!=40:
        raise ValueError('Commit identity mismatch')
    if system!='Linux' or uid<=0 or not str(env.get('GITHUB_RUN_ID','')).isdigit():
        raise ValueError('Expected non-root disposable Linux runner identity')

def call(*args):
    return subprocess.run(args,check=True,text=True,capture_output=True).stdout

def private_write(path,text):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:stream.write(text)

def main(action):
    env=os.environ;uid=os.getuid()
    event=json.loads(pathlib.Path(env['GITHUB_EVENT_PATH']).read_text())
    validate_context(env,event,uid,os.uname().sysname)
    root=pathlib.Path(env['RUNNER_TEMP']).resolve()/'graph-kvm-private'
    proof=root/'grant.json';backup=root/'original.acl'
    if action=='restore' and not proof.exists():
        print('KVM ACL was not changed; no restoration needed');return
    for tool in ('getfacl','setfacl','sudo'):
        if not shutil.which(tool):raise ValueError('Required existing ACL tool unavailable: '+tool)
    device=pathlib.Path('/dev/kvm');st=device.lstat()
    if not stat.S_ISCHR(st.st_mode) or st.st_uid!=0:
        raise ValueError('Expected root-owned KVM character device, not a link or ordinary file')
    identity={'runId':env['GITHUB_RUN_ID'],'attempt':'1','uid':uid,'device':st.st_rdev,'inode':st.st_ino}
    if action=='restore' or action in ('recheck-preflight-reopen','recheck-installed'):
        saved=json.loads(proof.read_text())
        if saved!=identity or backup.read_text()!=BASIC_ACL:
            raise ValueError('ACL restoration/recheck provenance mismatch; refusing changes')
        current=call('getfacl','-cpn','/dev/kvm')
        state=classify_acl(current,uid)
        if stat.S_IMODE(st.st_mode)!=0o660:
            raise ValueError('Device mode drift; refusing permission repair')
        if action!='restore':
            marker_name='empty-avd-preflight.json' if action=='recheck-preflight-reopen' else 'empty-avd-reopen-preflight.json'
            marker=json.loads((pathlib.Path(env['RUNNER_TEMP'])/'graph-qa/evidence'/marker_name).read_text())
            required={'runId':env['GITHUB_RUN_ID'],'attempt':'1','noApp':True,'preflightPassed':True,'normalShutdown':True}
            if action=='recheck-installed':required['reopenPreflightPassed']=True
            if any(marker.get(key)!=value for key,value in required.items()):
                raise ValueError('Successful prior empty-AVD phase proof missing; no permission reapply')
            # At most one recheck/reapply for each of the two planned reopen stages.
            # Existing private proof and exact UID/device/inode identity are mandatory.
            private_write(root/(action+'.json'),json.dumps({**identity,'action':action,'before':state}))
            if state=='only-our-entry-missing':
                call('sudo','-n','setfacl','-m',f'u:{uid}:rw','/dev/kvm')
            if call('getfacl','-cpn','/dev/kvm').strip()!=expected_acl(uid) or not os.access(device,os.R_OK|os.W_OK):
                raise ValueError('Bounded exact-user ACL recheck failed; no retries')
            print('KVM bounded '+action+': '+state+'; same UID/device only')
            return
        call('sudo','-n','setfacl','--set-file='+str(backup),'/dev/kvm')
        if call('getfacl','-cpn','/dev/kvm').strip()!=BASIC_ACL.strip():
            raise ValueError('Original device ACL restoration verification failed')
        print('Restored original KVM ACL; no persistent grant remains');return
    if action!='grant':raise ValueError('Unsupported action')
    if root.exists():raise ValueError('Refusing a repeated permission grant')
    original=call('getfacl','-cpn','/dev/kvm')
    if stat.S_IMODE(st.st_mode)!=0o660 or original.strip()!=BASIC_ACL.strip():
        raise ValueError('Unexpected initial KVM mode/ACL; no normalization or wider permission attempted')
    root.mkdir(mode=0o700)
    private_write(backup,BASIC_ACL)
    # Save restoration proof before the single mutation, so even a later failed
    # verification gets the always-run cleanup. No user-controlled device path.
    private_write(proof,json.dumps(identity))
    call('sudo','-n','setfacl','-m',f'u:{uid}:rw','/dev/kvm')
    expected=expected_acl(uid)
    if call('getfacl','-cpn','/dev/kvm').strip()!=expected or not os.access(device,os.R_OK|os.W_OK):
        raise ValueError('Exact-user KVM ACL verification failed')
    if stat.S_IMODE(device.stat().st_mode)!=0o660:
        raise ValueError('Unexpected device mode after exact-user ACL grant')
    print('KVM access granted to this non-root test UID only; original owner/group/world permissions preserved')

if __name__=='__main__':
    try:main(sys.argv[1] if len(sys.argv)==2 else '')
    except (ValueError,KeyError,OSError,subprocess.CalledProcessError) as error:
        print('KVM authorization/access gate failed: '+str(error),file=sys.stderr);sys.exit(3)
