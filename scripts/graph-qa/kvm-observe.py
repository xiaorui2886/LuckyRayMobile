"""Read-only device ACL evidence. No sudo, device open, chmod or ACL writes."""
import json,os,pathlib,stat,subprocess,sys,time
PHASES={'preflight','preflight-reopen','installed'}
CHECKPOINTS={'before-capability-check','after-permission-recheck','before-emulator-shutdown','after-emulator-shutdown'}
def observe():
    result={'atUnixNs':time.time_ns(),'uid':os.getuid(),'effectiveUid':os.geteuid(),'system':os.uname().sysname}
    device=pathlib.Path('/dev/kvm')
    try:
        s=device.lstat()
        result.update({'exists':True,'isCharacterDevice':stat.S_ISCHR(s.st_mode),'inode':s.st_ino,'deviceId':s.st_rdev,
                       'ownerUid':s.st_uid,'ownerGid':s.st_gid,'modeOctal':oct(stat.S_IMODE(s.st_mode)),
                       'mtimeNs':s.st_mtime_ns,'ctimeNs':s.st_ctime_ns,
                       'readable':os.access(device,os.R_OK),'writable':os.access(device,os.W_OK)})
    except FileNotFoundError:result['exists']=False
    try:
        p=subprocess.run(['getfacl','-cpn','/dev/kvm'],capture_output=True,text=True,timeout=5)
        result['aclProbeExit']=p.returncode
        # Numeric ACL lines only; do not publish arbitrary stderr or metadata.
        result['aclLines']=[line for line in p.stdout.splitlines() if line.startswith(('user:','group:','mask:','other:'))][:32]
    except (OSError,subprocess.TimeoutExpired) as error:result['aclProbeError']=type(error).__name__
    return result

def main(phase,checkpoint):
    if phase not in PHASES or checkpoint not in CHECKPOINTS:raise ValueError('Unsupported evidence stage')
    result={'phase':phase,'checkpoint':checkpoint,**observe()}
    out=pathlib.Path(os.environ['RUNNER_TEMP'])/'graph-qa/evidence';out.mkdir(parents=True,exist_ok=True)
    (out/f'kvm-{phase}-{checkpoint}.json').write_text(json.dumps(result,indent=2)+'\n')
    print('GRAPH_QA_KVM_OBSERVATION '+json.dumps(result))
if __name__=='__main__':main(*sys.argv[1:])
