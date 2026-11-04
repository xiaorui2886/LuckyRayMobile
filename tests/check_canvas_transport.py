#!/usr/bin/env python3
"""Focused host checks. Never an Android build or a pinning integration test.

--contract-only performs source-wiring checks without a Rust compiler.
The default additionally builds actual canvas_upstream.rs in an offline temporary
crate, using exact versions from the application lock. It replaces ONLY the
unavailable pinning module with a fail-closed adapter; tests use synthetic
loopback HTTP and cannot connect to a paired desktop. No dependency downloads,
production service, credentials, runner, or real user files are used.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def contract_checks():
    source = (ROOT / 'src-tauri/src/canvas_upstream.rs').read_text()
    connection = (ROOT / 'src-tauri/src/canvas_connection.rs').read_text()
    assert 'pub(crate) async fn load(&self, id: &str)' in source
    assert 'let path = canvas_load_path(id)?;' in source
    assert 'validate_document(&body, id)?;' in source
    assert 'remote_projection_version: u32' in source
    assert 'document.remote_projection_version != 1' in source
    assert 'MAX_MEDIA_BYTES: u64 = 1024 * 1024 * 1024' in source
    assert 'validate_media_response(response, range)' in source
    assert 'response.chunk()' in source
    assert 'Duration::from_secs(15)' in source
    assert 'request.header("range", range.header())' in source
    for method in ('media', 'media_chunk'):
        body = connection.split(f'pub(crate) async fn {method}(', 1)[1].split('\n    }', 1)[0]
        assert body.count('self.current()?;') == 2
    assert 'format!("/canvas/api/v1/canvases/{id}")' in source
    assert 'header.set_sensitive(true)' in source
    assert '.redirect(reqwest::redirect::Policy::none())' in source
    assert '.no_proxy()' in source
    assert 'headers.get_all(CONTENT_TYPE).iter().count() != 1' in source
    assert 'body.len().saturating_add(chunk.len()) > limit' in source
    assert 'StatusCode::OK => bounded_json_body' in source
    for method in ('list', 'load', 'asset'):
        body = connection.split(f'pub(crate) async fn {method}(', 1)[1].split('\n    }', 1)[0]
        before, after = body.split(f'self.upstream.{method}(', 1)
        assert 'canvas_connection_current(&self.state)?' in before
        assert 'canvas_connection_current(&self.state)?' in after
    assert 'pub(crate) async fn asset(&self, path: &str)' in source
    assert 'if !valid_asset_path(path)' in source
    assert 'asset_content_type(path, value)' in source
    assert 'bounded_body(response, MAX_ASSET_BYTES, false)' in source
    assert 'const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;' in source
    assert '#[tauri::command]' not in source + connection
    print('PASS: source-wiring contract checks (not Rust execution)', flush=True)


def rust_tests():
    if not shutil.which('cargo') or not shutil.which('rustc'):
        raise SystemExit('BLOCKED: cargo/rustc unavailable; Rust tests were not run.')
    original = (ROOT / 'src-tauri/Cargo.lock').read_bytes()
    packages = tomllib.loads(original.decode())['package']
    allowed = {(p['name'], p['version'], p.get('source'), p.get('checksum')) for p in packages}
    features = {
        'serde': ', features=["derive"]', 'serde_json': '', 'zeroize': '',
        'tokio': ', features=["full"]',
        'rustls': ', default-features=false, features=["ring","std","tls12"]',
        'reqwest': ', default-features=false, features=["rustls-tls-manual-roots","stream","json"]',
    }
    with tempfile.TemporaryDirectory(prefix='luckyray-canvas-read-test-') as temp:
        work = Path(temp)
        (work / 'src').mkdir()
        manifest = '[package]\nname="canvas-read-test"\nversion="0.0.0"\nedition="2021"\npublish=false\n[dependencies]\n'
        for name, flags in features.items():
            versions = [p['version'] for p in packages if p['name'] == name and (name != 'reqwest' or p['version'].startswith('0.12.')) and (name != 'rustls' or p['version'].startswith('0.23.'))]
            if len(versions) != 1:
                raise SystemExit(f'Ambiguous locked version for {name}')
            manifest += f'{name}={{version="={versions[0]}"{flags}}}\n'
        (work / 'Cargo.toml').write_text(manifest)
        (work / 'Cargo.lock').write_bytes(original)
        actual = ROOT / 'src-tauri/src/canvas_upstream.rs'
        (work / 'src/lib.rs').write_text(f'''// Pinning deliberately unavailable: fail closed if bootstrap reaches TLS.
mod pinning {{
    pub(crate) fn build_pinned_client_config(_: &str) -> Result<rustls::ClientConfig, String> {{
        Err("TEST_PINNING_UNAVAILABLE".into())
    }}
}}
#[path = "{actual}"]
mod canvas_upstream;
''')
        subprocess.run(['cargo', 'update', '--workspace', '--offline'], cwd=work, check=True)
        resolved = tomllib.loads((work / 'Cargo.lock').read_text())['package']
        for p in resolved:
            if 'source' in p and (p['name'], p['version'], p.get('source'), p.get('checksum')) not in allowed:
                raise SystemExit(f'Refusing dependency outside application lock: {p["name"]} {p["version"]}')
        assert (ROOT / 'src-tauri/Cargo.lock').read_bytes() == original
        subprocess.run(['cargo', 'test', '--offline', '--locked'], cwd=work, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract-only', action='store_true')
    args = parser.parse_args()
    contract_checks()
    if not args.contract_only:
        rust_tests()
