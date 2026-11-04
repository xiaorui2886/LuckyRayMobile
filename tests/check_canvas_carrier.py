#!/usr/bin/env python3
"""Offline focused carrier harness: real carrier, synthetic CanvasConnection.
Not an Android, TLS pinning, production gateway or WebView integration test.
--contract-only performs source wiring checks without running Rust or a server.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def contract_checks():
    source = (ROOT / 'src-tauri/src/canvas_carrier.rs').read_text()
    connection = (ROOT / 'src-tauri/src/canvas_connection.rs').read_text()
    for expected in ['Ipv4Addr::LOCALHOST, 0', 'HttpOnly; SameSite=Strict; Path=/canvas',
                     'cookie_name: format!("{COOKIE_PREFIX}{lease}")',
                     'MAX_HEAD_BYTES: usize = 16 * 1024', 'MAX_CONNECTIONS: usize = 8',
                     'Duration::from_secs(5)', 'Duration::from_secs(300)', 'else { 20 }',
                     'runtime.connection.current()', 'runtime.stop.cancelled()',
                     'runtime.connection.asset(path)', 'runtime.connection.list()',
                     'runtime.connection.load(id)', 'runtime.connection.media(id, range)', 'runtime.connection.media_chunk(&mut media)', 'Cache-Control: no-store',
                     'Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff',
                     'Content-Security-Policy:', 'Cross-Origin-Resource-Policy: same-origin']:
        assert expected in source, expected
    assert 'DetailBlocked' not in source
    assert 'document.remote_projection_version != 1' in (ROOT / 'src-tauri/src/canvas_upstream.rs').read_text()
    assert 'lsh_carrier::' not in source
    assert '#[tauri::command]' not in source
    assert 'reqwest::' not in source
    assert 'pub(crate) fn current(&self)' in connection
    assert 'equal_secret(lease, &self.lease)' in source
    print('PASS: carrier source-wiring contracts (not Rust execution)', flush=True)


def run_rust():
    if not shutil.which('cargo') or not shutil.which('rustc'):
        raise SystemExit('BLOCKED: cargo/rustc unavailable; carrier Rust tests were not run.')
    lock = ROOT / 'src-tauri/Cargo.lock'
    original = lock.read_bytes()
    packages = tomllib.loads(original.decode())['package']
    allowed = {(p['name'], p['version'], p.get('source'), p.get('checksum')) for p in packages}
    with tempfile.TemporaryDirectory(prefix='luckyray-canvas-carrier-test-') as temp:
        work = Path(temp)
        (work / 'src').mkdir()
        manifest = '[package]\nname="canvas-carrier-test"\nversion="0.0.0"\nedition="2021"\npublish=false\n[dependencies]\n'
        for name, features in {'tokio': ', features=["full"]', 'zeroize': '', 'getrandom': ''}.items():
            versions = [p['version'] for p in packages if p['name'] == name and (name != 'getrandom' or p['version'].startswith('0.2.'))]
            assert len(versions) == 1, name
            manifest += f'{name}={{version="={versions[0]}"{features}}}\n'
        (work / 'Cargo.toml').write_text(manifest)
        (work / 'Cargo.lock').write_bytes(original)
        stub = '''mod canvas_connection {
    use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
    use zeroize::Zeroizing;
    pub(crate) struct CanvasConnection {
        pub current: Arc<AtomicBool>, pub calls: Arc<AtomicUsize>, pub hanging: Arc<AtomicBool>,
    }
    pub(crate) struct Asset { pub bytes: Zeroizing<Vec<u8>>, pub content_type: &'static str }
    pub(crate) struct Media {
        pub status: u16, pub content_type: &'static str, pub content_length: u64,
        pub content_range: Option<String>, pub chunks: std::collections::VecDeque<Zeroizing<Vec<u8>>>,
    }
    impl CanvasConnection {
        pub(crate) fn current(&self) -> Result<(), String> {
            if self.current.load(Ordering::SeqCst) { Ok(()) } else { Err("STALE_OWNER".into()) }
        }
        pub(crate) async fn list(&self) -> Result<Zeroizing<Vec<u8>>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.hanging.load(Ordering::SeqCst) { std::future::pending::<()>().await; }
            self.current()?;
            Ok(Zeroizing::new(br#"{"canvases":[]}"#.to_vec()))
        }
        pub(crate) async fn load(&self, id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.current()?;
            Ok(Zeroizing::new(format!(r#"{{"canvasId":"{id}","remoteProjectionVersion":1}}"#).into_bytes()))
        }
        pub(crate) async fn media(&self, _: &str, range: Option<&str>) -> Result<Media, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.current()?;
            let (status, content_length, content_range, chunks): (_, _, _, Vec<&[u8]>) = match range {
                Some("bytes=99-") => (416, 0, Some("bytes */3".into()), vec![]),
                Some("bytes=0-1") => (206, 2, Some("bytes 0-1/3".into()), vec![b"a", b"b"]),
                None => (200, 3, None, vec![b"a", b"bc"]),
                _ => return Err("CANVAS_RANGE_INVALID".into()),
            };
            Ok(Media { status, content_type: "video/mp4", content_length, content_range,
                chunks: chunks.into_iter().map(|chunk| Zeroizing::new(chunk.to_vec())).collect() })
        }
        pub(crate) async fn media_chunk(&self, media: &mut Media) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
            self.current()?;
            if self.hanging.load(Ordering::SeqCst) { std::future::pending::<()>().await; }
            self.current()?;
            Ok(media.chunks.pop_front())
        }
        pub(crate) async fn asset(&self, _: &str) -> Result<Asset, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.current()?;
            Ok(Asset { bytes: Zeroizing::new(b"fixture".to_vec()), content_type: "text/html" })
        }
    }
}
'''
        stub += f'#[path="{ROOT / "src-tauri/src/canvas_carrier.rs"}"] mod canvas_carrier;\n'
        stub += f'#[cfg(test)] #[path="{ROOT / "tests/canvasCarrier.fixture.rs"}"] mod fixture;\n'
        (work / 'src/lib.rs').write_text(stub)
        # Reuse the app lock's transitive selections when creating the focused
        # package; no dependency downloads or app lock modifications are allowed.
        subprocess.run(['cargo', 'metadata', '--offline', '--format-version=1'], cwd=work, stdout=subprocess.DEVNULL, check=True)
        for p in tomllib.loads((work / 'Cargo.lock').read_text())['package']:
            if 'source' in p and (p['name'], p['version'], p.get('source'), p.get('checksum')) not in allowed:
                raise SystemExit(f'Dependency differs from app lock: {p["name"]} {p["version"]}')
        assert lock.read_bytes() == original
        subprocess.run(['cargo', 'test', '--offline', '--locked'], cwd=work, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract-only', action='store_true')
    args = parser.parse_args()
    contract_checks()
    if not args.contract_only:
        run_rust()
