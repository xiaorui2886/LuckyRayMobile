#!/usr/bin/env python3
"""Test actual Source, scope-proof, response-policy, gateway and pinning code.

This focused host check extracts actual Source/ExpectedGateway methods against
in-memory app-state adapters. It does not compile Tauri/UI glue or Android. Its
loopback gateway tests use synthetic HTTP, not a paired Desktop or TLS e2e.
Registry dependencies must exactly match the application Cargo.lock. No fixture
credentials, certificate, production network, device or runner is required.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent.parent


def identity(p):
    return tuple(p.get(k) for k in ("name", "version", "source", "checksum"))


def rust_item(source, needle):
    start = source.index(needle)
    end = source.index("{", start) + 1
    depth = 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


def main():
    lock = ROOT / "src-tauri/Cargo.lock"
    original = lock.read_bytes()
    packages = tomllib.loads(original.decode())["package"]
    allowed = {identity(p) for p in packages if "source" in p}
    specs = {
        "serde_json": "", "serde": ', features = ["derive"]', "sha2": "", "x509-parser": "", "rcgen": "",
        "tokio": ', features = ["full"]',
        "rustls": ', default-features = false, features = ["ring", "std", "tls12"]',
        "reqwest": ', default-features = false, features = ["rustls-tls-manual-roots", "stream", "json"]',
    }
    with tempfile.TemporaryDirectory(prefix="luckyray-scope-protocol-") as temp:
        work = Path(temp)
        (work / "src").mkdir()
        manifest = '[package]\nname="luckyray-scope-protocol-check"\nversion="0.0.0"\nedition="2021"\npublish=false\n[dependencies]\n'
        for name, features in specs.items():
            matches = [p for p in packages if p["name"] == name and (name != "reqwest" or p["version"].startswith("0.12."))]
            if len(matches) != 1:
                raise RuntimeError(f"Ambiguous application version of {name}")
            manifest += f'{name} = {{version = "={matches[0]["version"]}"{features}}}\n'
        (work / "Cargo.toml").write_text(manifest)
        (work / "Cargo.lock").write_bytes(original)
        rust = ROOT / "src-tauri/src"
        source = (rust / "lib.rs").read_text()
        # Only the two pure production helpers are extracted; their bodies are
        # not reimplemented. The Tauri application lifecycle is not included.
        (work / "src/gateway").mkdir()
        for name in ("gateway.rs", "gateway/response_policy.rs", "pinning.rs", "content.rs"):
            shutil.copyfile(rust / name, work / "src" / name)
        services = (rust / "services_v1.rs").read_text()
        services = services.replace("use tauri::State;", "").replace("use crate::content::expected_scoped_gateway;", "")
        start = services.index("#[tauri::command]")
        end = services.index("#[cfg(test)]", start)
        # Command glue needs Tauri. All actual wire structs, allowlist, helpers,
        # and their original unit tests remain intact in this focused crate.
        services = services[:start] + services[end:]
        (work / "src/services_v1.rs").write_text(services)
        harness = '''mod services_v1;
mod gateway;
mod pinning;
const THUMBNAIL_MAX_BYTES: usize = 8 * 1024 * 1024;
'''
        for name in ("build_pair_request_body", "companion_error_note"):
            harness += rust_item(source, "pub(crate) fn " + name + "(") + "\n"
        harness += (ROOT / "scripts/qa/scopeSource.context.rs").read_text() + "\n"
        harness += "#[derive(Clone)]\n" + rust_item(source, "struct ConnectionLifecycle {") + "\n"
        harness += rust_item(source, "impl ConnectionLifecycle {") + "\n"
        content_source = (rust / "content.rs").read_text()
        content = f'''use crate::*; use serde_json::{{json,Value}};
use sha2::{{Digest,Sha256}}; use std::{{collections::HashMap,sync::OnceLock}};
#[path="{(rust / 'content/scope_probe.rs').as_posix()}"] mod scope_probe;
pub(crate) fn retire_protocol_proof(key: &str) {{ scope_probe::retire(key); }}
static CONTENT_SCOPE_EPOCHS: OnceLock<Mutex<HashMap<String,(u64,u64)>>> = OnceLock::new();
'''
        for needle in ("fn scope_epochs(", "pub(crate) fn material_cache_owner(",
                       "fn legacy_vault_matches(", "fn legacy_scope_catalog(",
                       "struct Source {", "impl Source {",
                       "pub(crate) struct ExpectedGateway {", "impl ExpectedGateway {", "async fn cancellable<T>("):
            content += rust_item(content_source, needle) + "\n"
        content += f'mod media {{ #[path="{(rust / "content/media/stream.rs").as_posix()}"] mod stream; }}\n'
        content += (ROOT / "scripts/qa/scopeSource.native.rs").read_text()
        (work / "src/source_harness.rs").write_text(content)
        harness += '#[path="source_harness.rs"] mod content;\n'
        (work / "src/lib.rs").write_text(harness)
        env = dict(os.environ)
        # Retain the caller's target cache when provided, never modify app lock.
        env.setdefault("CARGO_TARGET_DIR", str(work / "target"))
        subprocess.run(["cargo", "fetch"], cwd=work, env=env, check=True)
        resolved = tomllib.loads((work / "Cargo.lock").read_text())["package"]
        for package in resolved:
            if "source" in package and identity(package) not in allowed:
                raise RuntimeError(f"Dependency differs from application lock: {package['name']} {package['version']}")
        if lock.read_bytes() != original:
            raise RuntimeError("Application lockfile changed")
        subprocess.run(["cargo", "test", "--locked"], cwd=work, env=env, check=True)
        if lock.read_bytes() != original:
            raise RuntimeError("Application lockfile changed")


if __name__ == "__main__":
    main()
