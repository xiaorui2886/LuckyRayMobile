# Native PNG safety tests (no Tauri/WebKit required)

Run `cargo test --locked --manifest-path tests/graph-export-native/Cargo.toml` from repository root.

This harness directly includes `src-tauri/src/graph_export_png.rs` with `#[path]`. It does not duplicate decoder, validation, or cache code. Exact direct dependencies are locked. Tests use generated 2×2 PNG pixels and isolated temporary directories only.

Covered: valid bounded decode/re-encode; invalid signature, oversized bytes, truncated PNG, corrupt IHDR CRC, trailing bytes, giant dimensions; exact managed basename/direct-child checks; rejection of file/directory symlinks; TTL cleanup leaves foreign files untouched; fresh cache byte/count limits never delete recent shared files.

Not covered by these host tests: Tauri command registration/marshalling, Android FileProvider chooser, MediaStore write, device screenshots. Those need Android compilation and device QA.
