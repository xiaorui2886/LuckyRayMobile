"""Pure/mocked authorization and ACL contracts. Never accesses or modifies KVM."""
import importlib.util,json,os,pathlib,stat,tempfile,types,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('kvm_access',pathlib.Path(__file__).with_name('kvm-access.py'))
k=importlib.util.module_from_spec(spec);spec.loader.exec_module(k)
class Contracts(unittest.TestCase):
    def setUp(self):
        self.env={'GITHUB_ACTIONS':'true','CI_GRAPH_QA_REVIEWED':'yes','GITHUB_REPOSITORY':k.REPO,'GITHUB_REF':k.REF,'GITHUB_EVENT_NAME':'push','GITHUB_RUN_ATTEMPT':'1','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux','GITHUB_RUN_ID':'123','GITHUB_SHA':'a'*40}
        self.event={'created':True,'deleted':False,'ref':k.REF,'repository':{'full_name':k.REPO},'before':'0'*40,'after':'a'*40}
    def test_exact_creation_first_attempt_allowed(self):
        k.validate_context(self.env,self.event,1001,'Linux')
    def test_existing_push_rerun_wrong_repo_or_other_host_denied(self):
        for key,value in [('GITHUB_RUN_ATTEMPT','2'),('GITHUB_EVENT_NAME','workflow_dispatch'),('RUNNER_ENVIRONMENT','self-hosted'),('GITHUB_REPOSITORY','other/repo'),('GITHUB_REF','refs/heads/main')]:
            with self.subTest(key=key),self.assertRaises(ValueError):k.validate_context({**self.env,key:value},self.event,1001,'Linux')
        for key,value in [('created',False),('deleted',True),('before','b'*40),('after','b'*40),('ref','refs/heads/main')]:
            with self.subTest(key=key),self.assertRaises(ValueError):k.validate_context(self.env,{**self.event,key:value},1001,'Linux')
        with self.assertRaises(ValueError):k.validate_context(self.env,self.event,0,'Linux')
    def test_mock_grant_repeat_rejected_and_exact_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            event_path=pathlib.Path(tmp)/'event.json';event_path.write_text(json.dumps(self.event))
            env={**self.env,'RUNNER_TEMP':tmp,'GITHUB_EVENT_PATH':str(event_path)}
            device=types.SimpleNamespace(st_mode=stat.S_IFCHR|0o660,st_uid=0,st_rdev=123,st_ino=456)
            acl=k.BASIC_ACL;mutations=[]
            def call(*args):
                nonlocal acl
                if args==('getfacl','-cpn','/dev/kvm'):return acl
                mutations.append(args)
                if args==('sudo','-n','setfacl','-m','u:1001:rw','/dev/kvm'):
                    acl='user::rw-\nuser:1001:rw-\ngroup::rw-\nmask::rw-\nother::---\n';return ''
                if args[:3]==('sudo','-n','setfacl') and args[3].startswith('--set-file='):
                    acl=k.BASIC_ACL;return ''
                self.fail('Unexpected operation '+repr(args))
            original_stat=pathlib.Path.stat
            def path_stat(path,*args,**kwargs):return device if str(path)=='/dev/kvm' else original_stat(path,*args,**kwargs)
            with patch.dict(os.environ,env,clear=True),patch.object(os,'getuid',return_value=1001),patch.object(os,'uname',return_value=types.SimpleNamespace(sysname='Linux')),patch.object(k.shutil,'which',return_value='/usr/bin/existing'),patch.object(pathlib.Path,'lstat',return_value=device),patch.object(pathlib.Path,'stat',path_stat),patch.object(os,'access',return_value=True),patch.object(k,'call',side_effect=call):
                k.main('restore');self.assertEqual(mutations,[])
                k.main('grant');self.assertEqual(len(mutations),1)
                with self.assertRaises(ValueError):k.main('grant')
                self.assertEqual(len(mutations),1)
                k.main('restore');self.assertEqual(len(mutations),2)
                self.assertEqual(acl,k.BASIC_ACL)
                self.assertEqual((pathlib.Path(tmp)/'graph-kvm-private/original.acl').stat().st_mode&0o777,0o600)
if __name__=='__main__':unittest.main()
