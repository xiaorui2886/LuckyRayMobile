//! Atomic local snapshot -> existing scoped durable create queue.
use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Mask only unambiguous unindented top-level fenced code and matched inline code spans.
/// Keep byte offsets and newlines so a diagnostic points into the original note.
/// Nested/list/indented code is deliberately not guessed: unknown resource syntax
/// stays blocked rather than allowing a link whose dependency cannot be copied.
fn resource_scan_text(body: &str) -> String {
    // Bare CR changes Markdown block boundaries. Do not guess its normalization.
    if body.as_bytes().iter().enumerate().any(|(i, b)| *b == b'\r' && body.as_bytes().get(i + 1) != Some(&b'\n')) { return body.to_string(); }
    let mut masked = body.as_bytes().to_vec();
    let mut preserve_from = masked.len();
    let mut offset = 0;
    let mut fence: Option<(u8, usize)> = None;
    for line in body.split_inclusive('\n') {
        // Raw HTML can suppress Markdown fences until a context-dependent end.
        // Keep that region untouched rather than parsing it as ordinary Markdown.
        if fence.is_none() && line.contains('<') { preserve_from = offset; break; }
        let bytes = line.as_bytes();
        let indent = bytes.iter().take_while(|&&b| b == b' ').count();
        let start = indent.min(bytes.len());
        let marker = bytes.get(start).copied().unwrap_or(0);
        let run = if marker == b'`' || marker == b'~' { bytes[start..].iter().take_while(|&&b| b == marker).count() } else { 0 };
        let trailing = &line[start + run..];
        let opens = indent == 0 && (marker == b'`' || marker == b'~') && run >= 3
            && (marker != b'`' || !trailing.contains('`'));
        // An unparsed nested/indented opener may have a column-zero closer.
        // Do not later mistake that closer for a new fence hiding real resources.
        if fence.is_none() && !opens && (line.contains("```") || line.contains("~~~")) {
            preserve_from = offset; break;
        }
        let inside = fence.is_some();
        if let Some((kind, count)) = fence {
            if indent <= 3 && marker == kind && run >= count && trailing.bytes().all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n')) {
                fence = None;
            }
        } else if opens {
            fence = Some((marker, run));
        }
        if inside || fence.is_some() {
            for b in &mut masked[offset..offset + bytes.len()] { if *b != b'\n' { *b = b' '; } }
        }
        offset += bytes.len();
    }
    // A matched run closes only an equal-length run. A backslash-escaped opening
    // tick is text, not code. Restrict to one line to avoid crossing block syntax.
    let mut offset = 0;
    'lines: for line in body.split_inclusive('\n') {
        let end = offset + line.len();
        if offset >= preserve_from { break; }
        // URLs, link syntax and GFM table cells give backticks non-code meanings.
        let lower = line.to_ascii_lowercase();
        if line.len() > 16_384 || ["<", "](", "][", "]:", "://", "www.", "@", "|"].iter().any(|s| lower.contains(s)) {
            // Unparsed ticks could begin a multiline span; do not reinterpret
            // a later closing tick as a fresh opener around a real resource.
            if masked[offset..end].contains(&b'`') { break; }
            offset = end; continue;
        }
        let mut i = offset;
        while i < end {
            if masked[i] != b'`' { i += 1; continue; }
            let slashes = masked[offset..i].iter().rev().take_while(|&&b| b == b'\\').count();
            let begin = i;
            while i < end && masked[i] == b'`' { i += 1; }
            let count = i - begin;
            if slashes % 2 == 1 {
                if count > 1 { break 'lines; }
                continue;
            }
            let mut j = i;
            let mut matched = false;
            while j < end && masked[j] != b'\n' {
                if masked[j] != b'`' { j += 1; continue; }
                let close = j;
                while j < end && masked[j] == b'`' { j += 1; }
                if j - close == count {
                    masked[begin..j].fill(b' ');
                    i = j;
                    matched = true;
                    break;
                }
            }
            if !matched { break 'lines; }
        }
        offset = end;
    }
    // Only ASCII substitutions were made, preserving valid UTF-8 boundaries.
    String::from_utf8(masked).expect("resource scan preserves UTF-8")
}

pub(super) fn blocked_resource(body: &str) -> Option<(usize, String)> {
    let scan = resource_scan_text(body);
    for (index, line) in scan.lines().enumerate() {
        let lower = line.to_ascii_lowercase();
        // The label is deliberately only a short filename, never a complete URI,
        // query string or path. The UI renders it as text, not HTML or a link.
        let label = |target: &str| -> String {
            let name = target.split(['|', '#', '?', ']']).next().unwrap_or("")
                .trim().trim_matches(['<', '>', '\'', '"']);
            let name = name.rsplit(['/', '\\']).next().unwrap_or("");
            let clean: String = name.chars().filter(|c| !c.is_control() && !matches!(*c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')).take(64).collect();
            if clean.trim().is_empty() { "本机资源".into() } else { clean }
        };
        if let Some(pos) = lower.find("[[") {
            return Some((index + 1, label(&line[pos + 2..])));
        }
        for marker in ["lr-local:", "local-asset:", "local-inbox:", "content://", "file://", "asset://", "tauri://"] {
            if lower.contains(marker) { return Some((index + 1, "本机资源链接".into())); }
        }
        if ["<img", "<video", "<audio", "<source", "href=", "src="].iter().any(|s| lower.contains(s)) {
            return Some((index + 1, "HTML 资源引用".into()));
        }
        if lower.contains("][") || (lower.trim_start().starts_with('[') && lower.contains("]:")) {
            return Some((index + 1, "引用式链接".into()));
        }
        for (pos, _) in lower.match_indices("](") {
            let tail = &lower[pos + 2..];
            let target = tail.split(')').next().unwrap_or("").trim().trim_start_matches('<');
            if !(target.starts_with("https://") || target.starts_with("http://") || target.starts_with("mailto:") || target.starts_with('#')) {
                return Some((index + 1, label(line[pos + 2..].split(')').next().unwrap_or(""))));
            }
        }
    }
    None
}

#[cfg(test)]
fn portable_body(body: &str) -> bool { blocked_resource(body).is_none() }

impl Db {
    pub(crate) fn local_note_upload_stage(&self, instance: &str, vault: &str, note_id: &str, parent: &str) -> Result<Value, String> {
        let note = self.note_get(note_id)?.ok_or("LOCAL_NOTE_NOT_FOUND")?;
        if note.content.len() > 4 * 1024 * 1024 { return Err("LOCAL_NOTE_UPLOAD_TOO_LARGE".into()); }
        if let Some((line, reference)) = blocked_resource(&note.content) {
            return Err(format!("LOCAL_NOTE_UPLOAD_RESOURCES_UNSUPPORTED:{}", json!({"line":line,"reference":reference})));
        }
        if note.title.trim().is_empty() || note.title.len() > 200 { return Err("CONTENT_TITLE_INVALID".into()); }
        if !parent.is_empty() && !self.content_note_directories(instance, vault)?["directories"].as_array()
            .is_some_and(|dirs| dirs.iter().any(|dir| dir == parent)) { return Err("CONTENT_PATH_INVALID".into()); }
        self.content_sync_position(instance, vault)?;
        // Include transferred content/title and target, not second-granularity timestamps.
        let identity = json!([instance, vault, note_id, note.title, note.content, parent]).to_string();
        let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
        let key = format!("local-note-upload:{hash}");
        let tx = rusqlite::Transaction::new_unchecked(&self.conn, rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let existing: Option<String> = tx.query_row("SELECT value FROM app_meta WHERE key=?1", [&key], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        let reused = existing.is_some();
        let remote_id = existing.unwrap_or_else(|| format!("kn-{}", uuid::Uuid::new_v4().simple()));
        if !reused {
            self.content_create_in(instance, vault, &remote_id, note.title.trim(), &note.content, parent)?;
            tx.execute("INSERT INTO app_meta(key,value) VALUES(?1,?2)", params![key,remote_id]).map_err(|e| e.to_string())?;
        }
        // Ledger survives cache cleanup: repeating a committed snapshot never
        // silently creates another remote note even when its cache is absent.
        let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM note_cache WHERE desktop_instance_id=?1 AND vault_id=?2 AND note_id=?3 AND dirty=1)", params![instance,vault,remote_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        crate::managed_vault_sync::commit(tx,instance,vault)?;
        Ok(json!({"status":if reused && !pending {"alreadySubmitted"} else {"queued"},"noteId":remote_id,"localNoteId":note_id,"instanceId":instance,"vaultId":vault,"reused":reused,"localOriginalPreserved":true,"transferScope":"titleAndContent","localMetadataPreserved":true}))
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn resource_preflight_fails_closed() {
        assert!(portable_body("# text\n![web](https://example.com/a.png)"));
        for body in ["![local](lr-local://a)", "[a](../b.md)", "![[x]]", "![a][ref]", "[ref]: local.png", "<img src='relative.png'>", "[a](file:///a)"] { assert!(!portable_body(body), "{body}"); }
    }
    #[test] fn code_examples_do_not_require_resource_transfer() {
        for body in [
            "中文正文 `[[示例.html]]` 与 `C:\\example`。",
            "``[[demo.png]] ` example``",
            "```md\n![[example.png]]\n<img src='file:///example'>\n```\n普通正文",
            "~~~markdown\n[a](../example.md)\n~~~~\n[web](https://example.com)",
            "```\n[[unfinished fence is code]]",
        ] { assert!(portable_body(body), "{body}"); }
    }
    #[test] fn code_mask_preserves_real_resources_and_line_numbers() {
        let body = "标题\n```md\n[[example.html]]\n```\n`[[example.py]]`\n[[资料/原型.html|原型]]";
        assert_eq!(blocked_resource(body), Some((6, "原型.html".into())));
        for body in [
            "`example` [[real.py]]", "`unclosed [[real.py]]",
            r"\``start` ![[real.png]] `extra",
            r"\`[[real.py]]`", "```\nexample\n```\n![real](../a.png)",
            "````\nexample\n```\n````\n[[real.py]]",
            "```bad`info\n[[real.py]]", "[x](`../real.png`)",
            "  ```\ncode\n```\n![[real.png]]", "- ```\ncode\n```\n![[real.png]]", "> ```\ncode\n```\n![[real.png]]",
            "- item\n  ```\n  example\n\n![[real.png]]",
            "`start\nend` ![[real.png]] `extra", "https://example.com/`start\nend` ![[real.png]] `extra",
            "| ` | ![[real.png]] | ` |\n|---|---|---|", "https://example.com/` ![[real.png]] `",
            "<https://example.com/`> ![[real.png]] `", "[label](https://example.com/`) ![[real.png]] `",
            "<div>\n```\n</div>\n\n![[real.png]]", "`\r\r![[real.png]]\r\r`",
            "```\ncode\n```\u{00a0}\ntext\n```\n![[real.png]]",
            "```\ncode\n  ```\n![[real.png]]",
            "中文 [[real.py]]", "![中文](../真实图片.png)",
            "[label][reference]\n[reference]: ../real.png",
        ] { assert!(!portable_body(body), "{body}"); }
        assert_eq!(blocked_resource("[[C:\\private\\原型.py#section|别名]]"), Some((1, "原型.py".into())));
    }
    #[test] fn rejected_resources_do_not_stage_but_code_snapshot_is_unchanged() {
        let path = std::env::temp_dir().join(format!("note-upload-code-{}.db", uuid::Uuid::new_v4()));
        let mut db = Db::open(&path).unwrap();
        db.content_vault_remember("owner", "vault", "Vault").unwrap();
        db.note_insert("local", "Title", "[[real.html]]", &[], None).unwrap();
        let error = db.local_note_upload_stage("owner", "vault", "local", "").unwrap_err();
        assert!(error.starts_with("LOCAL_NOTE_UPLOAD_RESOURCES_UNSUPPORTED:"));
        let detail: Value = serde_json::from_str(error.split_once(':').unwrap().1).unwrap();
        assert_eq!(detail["line"], 1); assert_eq!(detail["reference"], "real.html");
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM note_cache", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.note_get("local").unwrap().unwrap().content, "[[real.html]]");
        let body = "中文 `[[示例.html]]`\n```md\n![例](file:///example)\n```";
        db.note_update("local", "Title", body, &[]).unwrap();
        let receipt = db.local_note_upload_stage("owner", "vault", "local", "").unwrap();
        assert_eq!(receipt["status"], "queued");
        assert_eq!(db.note_get("local").unwrap().unwrap().content, body);
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM note_cache", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        drop(db); let _ = std::fs::remove_file(path);
    }
    #[test] fn atomic_copy_is_scoped_idempotent_and_preserves_original() {
        let path = std::env::temp_dir().join(format!("note-upload-{}.db", uuid::Uuid::new_v4()));
        let mut db = Db::open(&path).unwrap();
        db.content_vault_remember("owner", "vault", "Vault").unwrap();
        db.content_vault_remember("other", "vault", "Vault").unwrap();
        db.note_insert("local", "Title", "Body", &[], None).unwrap();
        let first = db.local_note_upload_stage("owner", "vault", "local", "").unwrap();
        let second = db.local_note_upload_stage("owner", "vault", "local", "").unwrap();
        assert_eq!(first["noteId"], second["noteId"]); assert_eq!(second["reused"], true);
        assert_eq!(db.note_get("local").unwrap().unwrap().content, "Body");
        assert_ne!(first["noteId"], db.local_note_upload_stage("other", "vault", "local", "").unwrap()["noteId"]);
        db.note_update("local", "Title", "![bad](lr-local://x)", &[]).unwrap();
        assert!(db.local_note_upload_stage("owner", "vault", "local", "").is_err());
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM note_cache", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        drop(db); let _ = std::fs::remove_file(path);
    }
}
