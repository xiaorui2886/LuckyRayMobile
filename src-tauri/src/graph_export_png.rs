//! User-initiated graph PNG export. No renderer-supplied path or filename.
//! Private bounded cache + existing narrow FileProvider/MediaStore bridge.
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
pub(crate) const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
const MAX_PIXELS: u64 = 8 * 1024 * 1024;
const MAX_SIDE: u32 = 4096;
const MAX_DECODE_BYTES: usize = 64 * 1024 * 1024;
const CACHE_BUDGET: u64 = 32 * 1024 * 1024;
const CACHE_MAX_FILES: usize = 32;
pub(crate) fn error() -> String {
    "GRAPH_PNG_INVALID_OR_TOO_LARGE".into()
}

/// Cheap bounds before the actual PNG decoder sees any ancillary data or allocation.
fn inspect_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 45 || bytes.len() > MAX_PNG_BYTES || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(error());
    }
    let mut at = 8usize;
    let mut count = 0usize;
    let mut idat = false;
    let mut ended = false;
    while at < bytes.len() {
        count += 1;
        if count > 4096 || bytes.len() - at < 12 {
            return Err(error());
        }
        let len = u32::from_be_bytes(bytes[at..at + 4].try_into().map_err(|_| error())?) as usize;
        let end = at
            .checked_add(12)
            .and_then(|v| v.checked_add(len))
            .ok_or_else(error)?;
        if end > bytes.len() {
            return Err(error());
        }
        let kind = &bytes[at + 4..at + 8];
        if count == 1 {
            if kind != b"IHDR" || len != 13 {
                return Err(error());
            }
            let w = u32::from_be_bytes(bytes[at + 8..at + 12].try_into().map_err(|_| error())?);
            let h = u32::from_be_bytes(bytes[at + 12..at + 16].try_into().map_err(|_| error())?);
            if w == 0
                || h == 0
                || w > MAX_SIDE
                || h > MAX_SIDE
                || (w as u64) * (h as u64) > MAX_PIXELS
            {
                return Err(error());
            }
        } else if kind == b"IHDR" {
            return Err(error());
        }
        if matches!(kind, b"acTL" | b"fcTL" | b"fdAT") {
            return Err(error());
        }
        if kind == b"IDAT" {
            idat = true;
        }
        if kind == b"IEND" {
            if len != 0 || end != bytes.len() || !idat {
                return Err(error());
            }
            ended = true;
        }
        at = end;
    }
    if !ended {
        return Err(error());
    }
    Ok(())
}

/// Fully decode with a fixed memory budget, then re-encode pixels without metadata.
pub(crate) fn canonical_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    inspect_png(bytes)?;
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(bytes),
        png::Limits {
            bytes: MAX_DECODE_BYTES,
        },
    );
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| error())?;
    if reader.info().animation_control.is_some() || reader.output_buffer_size() > MAX_DECODE_BYTES {
        return Err(error());
    }
    let mut pixels = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut pixels).map_err(|_| error())?;
    reader.finish().map_err(|_| error())?;
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, info.width, info.height);
        encoder.set_color(info.color_type);
        encoder.set_depth(info.bit_depth);
        let mut writer = encoder.write_header().map_err(|_| error())?;
        writer
            .write_image_data(&pixels[..info.buffer_size()])
            .map_err(|_| error())?;
        writer.finish().map_err(|_| error())?;
    }
    if output.len() > MAX_PNG_BYTES {
        return Err(error());
    }
    Ok(output)
}
fn owned_name(name: &str) -> bool {
    name.strip_prefix("graph-")
        .and_then(|s| s.strip_suffix(".png"))
        .map(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or(false)
}
pub(crate) fn private_root(cache: &Path) -> Result<PathBuf, String> {
    let base = cache
        .canonicalize()
        .map_err(|_| "GRAPH_CACHE_UNAVAILABLE")?;
    let mut root = base;
    for child in ["content-resources", "graph-exports"] {
        root.push(child);
        match fs::symlink_metadata(&root) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => return Err("GRAPH_CACHE_UNAVAILABLE".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&root).map_err(|_| "GRAPH_CACHE_UNAVAILABLE")?
            }
            Err(_) => return Err("GRAPH_CACHE_UNAVAILABLE".into()),
        }
    }
    root.canonicalize()
        .map_err(|_| "GRAPH_CACHE_UNAVAILABLE".into())
}
/// Exact generated direct-child file only. Existing generic export validation remains unchanged.
pub(crate) fn validate_cache_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "GRAPH_CACHE_UNAVAILABLE")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_PNG_BYTES as u64
    {
        return Err("GRAPH_CACHE_INVALID".into());
    }
    let canonical = path.canonicalize().map_err(|_| "GRAPH_CACHE_UNAVAILABLE")?;
    let trusted = root.canonicalize().map_err(|_| "GRAPH_CACHE_UNAVAILABLE")?;
    if canonical.parent() != Some(trusted.as_path())
        || !canonical
            .file_name()
            .and_then(|s| s.to_str())
            .map(owned_name)
            .unwrap_or(false)
    {
        return Err("GRAPH_CACHE_INVALID".into());
    }
    Ok(canonical)
}
fn reserve_cache(root: &Path, incoming: u64, now: SystemTime) -> Result<(), String> {
    let mut bytes = 0u64;
    let mut count = 0usize;
    for entry in fs::read_dir(root).map_err(|_| "GRAPH_CACHE_UNAVAILABLE")? {
        let entry = entry.map_err(|_| "GRAPH_CACHE_UNAVAILABLE")?;
        if !entry.file_name().to_str().map(owned_name).unwrap_or(false) {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path()).map_err(|_| "GRAPH_CACHE_UNAVAILABLE")?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d > Duration::from_secs(24 * 60 * 60))
            .unwrap_or(false);
        if old && fs::remove_file(entry.path()).is_ok() {
            continue;
        }
        bytes = bytes.saturating_add(meta.len());
        count += 1;
    }
    if count >= CACHE_MAX_FILES || bytes.saturating_add(incoming) > CACHE_BUDGET {
        return Err("GRAPH_EXPORT_CACHE_FULL_TRY_LATER".into());
    }
    Ok(())
}
pub(crate) fn write_cache(root: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    reserve_cache(root, bytes.len() as u64, SystemTime::now())?;
    let path = root.join(format!("graph-{}.png", uuid::Uuid::new_v4().simple()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "GRAPH_CACHE_WRITE_FAILED")?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|_| "GRAPH_CACHE_WRITE_FAILED")?;
        file.sync_all().map_err(|_| "GRAPH_CACHE_WRITE_FAILED")?;
        Ok::<(), &str>(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    validate_cache_file(root, &path)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn png() -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, 2, 2);
            e.set_color(png::ColorType::Rgba);
            e.set_depth(png::BitDepth::Eight);
            let mut w = e.write_header().unwrap();
            w.write_image_data(&[255; 16]).unwrap();
            w.finish().unwrap();
        }
        out
    }
    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join(format!("lr-graph-export-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        p
    }
    #[test]
    fn graph_png_valid_decode_and_reencode() {
        let result = canonical_png(&png()).unwrap();
        inspect_png(&result).unwrap();
    }
    #[test]
    fn graph_png_rejects_magic_size_truncation_crc_and_trailing() {
        let good = png();
        let mut bad = good.clone();
        bad[0] = 0;
        assert!(canonical_png(&bad).is_err());
        assert!(canonical_png(&vec![0; MAX_PNG_BYTES + 1]).is_err());
        assert!(canonical_png(&good[..good.len() - 1]).is_err());
        let mut bad = good.clone();
        bad[29] ^= 1;
        assert!(canonical_png(&bad).is_err());
        let mut bad = good;
        bad.push(0);
        assert!(canonical_png(&bad).is_err());
    }
    #[test]
    fn graph_png_rejects_bomb_dimensions() {
        let mut p = png();
        p[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(inspect_png(&p).is_err());
    }
    #[test]
    fn graph_cache_does_not_touch_foreign_files_or_accept_arbitrary_path() {
        let temp = fixture();
        let root = private_root(&temp).unwrap();
        let foreign = root.join("notes.md");
        fs::write(&foreign, b"KEEP").unwrap();
        let path = write_cache(&root, &png()).unwrap();
        assert!(validate_cache_file(&root, &path).is_ok());
        assert!(validate_cache_file(&root, &foreign).is_err());
        assert!(validate_cache_file(&temp, &path).is_err());
        reserve_cache(&root, 0, SystemTime::now() + Duration::from_secs(25 * 3600)).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read(&foreign).unwrap(), b"KEEP");
        fs::remove_dir_all(temp).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn graph_cache_rejects_symlinks() {
        use std::os::unix::fs::symlink;
        let temp = fixture();
        let root = private_root(&temp).unwrap();
        let other = temp.join("other");
        fs::write(&other, png()).unwrap();
        let link = root.join("graph-00000000000000000000000000000000.png");
        symlink(&other, &link).unwrap();
        assert!(validate_cache_file(&root, &link).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn graph_cache_enforces_count_and_byte_budget_without_deleting_fresh_files() {
        let temp = fixture();
        let root = private_root(&temp).unwrap();
        let path = write_cache(&root, &png()).unwrap();
        assert!(reserve_cache(&root, CACHE_BUDGET, SystemTime::now()).is_err());
        assert!(path.exists());
        for i in 0..CACHE_MAX_FILES {
            fs::write(root.join(format!("graph-{i:032x}.png")), b"x").unwrap();
        }
        assert!(reserve_cache(&root, 0, SystemTime::now()).is_err());
        assert!(path.exists());
        fs::remove_dir_all(temp).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn graph_cache_rejects_symlink_directory() {
        use std::os::unix::fs::symlink;
        let temp = fixture();
        let outside = fixture();
        symlink(&outside, temp.join("content-resources")).unwrap();
        assert!(private_root(&temp).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(temp).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
