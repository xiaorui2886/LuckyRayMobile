#!/usr/bin/env python3
"""Download only the focused test dependency closure selected by the app lock.

Run once in a fresh CARGO_HOME before the unchanged offline test harnesses.
No application build, signing, credentials, user files, or device access.
"""
from pathlib import Path
import os
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
lock_path = ROOT / 'src-tauri/Cargo.lock'
original = lock_path.read_bytes()
packages = tomllib.loads(original.decode())['package']
registry = 'registry+https://github.com/rust-lang/crates.io-index'
allowed = {(p['name'], p['version'], p.get('source'), p.get('checksum')) for p in packages}
assert all(p.get('source', registry) == registry for p in packages), 'non-registry source refused'
home = Path(os.environ['CARGO_HOME'])
home.mkdir(parents=True, exist_ok=True)
assert not any(home.iterdir()), 'a fresh isolated Cargo home is required'
features = {
    'serde': ', features=["derive"]', 'serde_json': '', 'zeroize': '',
    'tokio': ', features=["full"]', 'getrandom': '',
    'rustls': ', default-features=false, features=["ring","std","tls12"]',
    'reqwest': ', default-features=false, features=["rustls-tls-manual-roots","stream","json"]',
}
with tempfile.TemporaryDirectory(prefix='canvas-qa-cache-') as temp:
    work = Path(temp)
    (work / 'src').mkdir()
    (work / 'src/lib.rs').write_text('// Dependency preparation only.\n')
    manifest = '[package]\nname="canvas-qa-cache"\nversion="0.0.0"\nedition="2021"\npublish=false\n[dependencies]\n'
    for name, flags in features.items():
        versions = [p['version'] for p in packages if p['name'] == name
                    and (name != 'reqwest' or p['version'].startswith('0.12.'))
                    and (name != 'rustls' or p['version'].startswith('0.23.'))
                    and (name != 'getrandom' or p['version'].startswith('0.2.'))]
        assert len(versions) == 1, f'ambiguous locked dependency: {name}'
        manifest += f'{name}={{version="={versions[0]}"{flags}}}\n'
    (work / 'Cargo.toml').write_text(manifest)
    (work / 'Cargo.lock').write_bytes(original)
    # Cargo may add the synthetic package and prune unused packages. Every
    # registry package must retain the application's exact version/checksum.
    # Resolve the synthetic workspace lock using registry metadata before any
    # crate archive fetch. Do not update existing non-workspace selections.
    subprocess.run(['cargo', 'update', '--workspace'], cwd=work, check=True)
    selected = tomllib.loads((work / 'Cargo.lock').read_text())['package']
    for p in selected:
        if 'source' in p:
            assert (p['name'], p['version'], p.get('source'), p.get('checksum')) in allowed, \
                f'dependency outside app lock: {p["name"]} {p["version"]}'
    subprocess.run(['cargo', 'fetch', '--locked'], cwd=work, check=True)
assert lock_path.read_bytes() == original, 'application lock changed'
print('Prepared exact application-locked registry dependencies for focused offline tests.')
