#!/usr/bin/env python3
"""Run the actual pinning module's four tests without Tauri/GUI dependencies.

Requires Python 3.11+ and Rust/Cargo. The disposable crate is seeded from the
application lockfile. Cargo may prune unused packages, but every resolved
registry package/version/checksum must already occur in that lockfile.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent.parent


def identity(package):
    return tuple(package.get(key) for key in ("name", "version", "source", "checksum"))


def main():
    lock_path = ROOT / "src-tauri/Cargo.lock"
    original_lock = lock_path.read_bytes()
    packages = tomllib.loads(original_lock.decode())["package"]
    direct = {}
    for name in ("rustls", "sha2", "x509-parser", "rcgen"):
        matches = [p for p in packages if p["name"] == name]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one locked version of {name}")
        direct[name] = matches[0]["version"]
    allowed = {identity(p) for p in packages if "source" in p}
    source = ROOT / "src-tauri/src/pinning.rs"
    if source.read_text().count("#[test]") != 4:
        raise RuntimeError("Review this focused gate when the pinning test count changes")
    with tempfile.TemporaryDirectory(prefix="luckyray-pinning-") as temp:
        work = Path(temp)
        (work / "src").mkdir()
        shutil.copyfile(source, work / "src/lib.rs")
        (work / "Cargo.lock").write_bytes(original_lock)
        (work / "Cargo.toml").write_text('''[package]
name = "luckyray-pinning-check"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
rustls = { version = "=''' + direct["rustls"] + '''", default-features = false, features = ["ring", "std", "tls12"] }
sha2 = "=''' + direct["sha2"] + '''"
x509-parser = "=''' + direct["x509-parser"] + '''"

[dev-dependencies]
rcgen = "=''' + direct["rcgen"] + '''"
''')
        env = dict(os.environ, CARGO_TARGET_DIR=str(work / "target"))
        # The temporary root package differs, so a one-time lockfile prune is
        # necessary. No changed dependency is permitted through to compilation.
        subprocess.run(["cargo", "fetch"], cwd=work, env=env, check=True)
        resolved = tomllib.loads((work / "Cargo.lock").read_text())["package"]
        for package in resolved:
            if package["name"] == "luckyray-pinning-check" and "source" not in package:
                continue
            if identity(package) not in allowed:
                raise RuntimeError(f"Dependency differs from application lockfile: {package['name']} {package['version']}")
        if lock_path.read_bytes() != original_lock:
            raise RuntimeError("Application lockfile changed unexpectedly")
        print("All isolated dependency versions and checksums match the application lockfile.", flush=True)
        subprocess.run(["cargo", "test", "--lib", "--locked", "--offline"], cwd=work, env=env, check=True)


if __name__ == "__main__":
    main()
