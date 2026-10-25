#!/usr/bin/env python3
"""Run the actual SQLite module tests without Tauri/GUI dependencies.

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
    for name in ("rusqlite", "serde", "serde_json", "uuid", "sha2"):
        matches = [p for p in packages if p["name"] == name]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one locked version of {name}")
        direct[name] = matches[0]["version"]
    allowed = {identity(p) for p in packages if "source" in p}
    source = ROOT / "src-tauri/src/db.rs"
    with tempfile.TemporaryDirectory(prefix="luckyray-database-") as temp:
        work = Path(temp) / "crate"
        (work / "src").mkdir(parents=True)
        shutil.copytree(ROOT / "shared/companion-content-v1", Path(temp) / "shared/companion-content-v1")
        shutil.copyfile(source, work / "src/lib.rs")
        for module in ("content_db.rs", "content_offline_db.rs", "local_note_upload_db.rs"):
            shutil.copyfile(ROOT / "src-tauri/src" / module, work / "src" / module)
        (work / "Cargo.lock").write_bytes(original_lock)
        (work / "Cargo.toml").write_text('''[package]
name = "luckyray-database-check"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
rusqlite = { version = "=''' + direct["rusqlite"] + '''", features = ["bundled"] }
serde = { version = "=''' + direct["serde"] + '''", features = ["derive"] }
serde_json = "=''' + direct["serde_json"] + '''"
uuid = { version = "=''' + direct["uuid"] + '''", features = ["v4"] }
sha2 = "=''' + direct["sha2"] + '''"
''')
        env = dict(os.environ, CARGO_TARGET_DIR=str(work / "target"))
        # The temporary root package differs, so a one-time lockfile prune is
        # necessary. No changed dependency is permitted through to compilation.
        subprocess.run(["cargo", "fetch"], cwd=work, env=env, check=True)
        resolved = tomllib.loads((work / "Cargo.lock").read_text())["package"]
        for package in resolved:
            if package["name"] == "luckyray-database-check" and "source" not in package:
                continue
            if identity(package) not in allowed:
                raise RuntimeError(f"Dependency differs from application lockfile: {package['name']} {package['version']}")
        if lock_path.read_bytes() != original_lock:
            raise RuntimeError("Application lockfile changed unexpectedly")
        print("All isolated dependency versions and checksums match the application lockfile.", flush=True)
        subprocess.run(["cargo", "test", "--lib", "--locked", "--offline"], cwd=work, env=env, check=True)


if __name__ == "__main__":
    main()
