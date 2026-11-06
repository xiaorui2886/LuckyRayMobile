//! The one Content sync mutation dispatcher. Stored route/payload own every retry.
use crate::db::content_db::{NoteOperationRoute, PreparedNoteOperation};
use serde_json::Value;
use std::future::Future;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Ack,
    LegacyCreateCollision,
    NoteConflict,
    DesktopBusy,
    Refused(u16),
}

/// Display-only refusal context. Never copy untrusted strings from the request
/// or response: every component is a literal, and the operation stays immutable.
pub(super) fn refusal_error(status: u16, prepared: &PreparedNoteOperation, result: &Value) -> String {
    let code = match result["code"].as_str() {
        Some(code @ ("AUTH_REVOKED" | "PAIRING_REQUIRED" | "GRANT_REQUIRED" | "SCOPE_DENIED"
            | "SERVICE_UNAVAILABLE" | "VERSION_UNSUPPORTED" | "REVISION_CONFLICT" | "OP_ID_REUSED"
            | "RECEIPT_EXPIRED" | "CURSOR_TOO_OLD" | "ENTITY_NOT_FOUND" | "SOURCE_CHANGED"
            | "PAYLOAD_TOO_LARGE" | "NOTE_TOO_LARGE" | "RATE_LIMITED" | "DESKTOP_DRAFT_BUSY"
            | "UPLOAD_OFFSET_MISMATCH" | "UPLOAD_HASH_MISMATCH" | "UPLOAD_INCOMPLETE"
            | "JOB_NOT_OWNED" | "INPUT_INVALID" | "METHOD_NOT_ALLOWED" | "PRESENTATION_BUSY"
            | "NOTE_INPUT_INVALID" | "OP_ID_INVALID" | "INVALID_QUERY" | "VAULT_CHANGED"
            | "gateway-request-invalid" | "gateway-request-too-large")) => code,
        _ => "UNKNOWN",
    };
    let kind = match prepared.payload["kind"].as_str() {
        Some(kind @ ("create" | "update" | "rename" | "delete")) => kind,
        _ => "UNKNOWN",
    };
    let route = match prepared.route {
        NoteOperationRoute::Content => "content",
        NoteOperationRoute::KnowledgeCreateUnique => "knowledgeCreateUnique",
        NoteOperationRoute::KnowledgeImportPlanned => "knowledgeImportPlanned",
    };
    let mut message = format!("CONTENT_MUTATION_HTTP_{status} [{code}] kind={kind} route={route}");
    // Narrow observation of the actual refused immutable rename. This is NOT
    // admission, preparation, transport validation, or proof of remote identity.
    if status == 400 && code == "NOTE_INPUT_INVALID" && kind == "rename"
        && prepared.route == NoteOperationRoute::Content {
        message.push_str(&prepared_input_context(&prepared.payload));
    }
    message
}

fn diagnostic_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Facts about the captured endpoint and the catalog already fetched this round.
/// No extra request; no host, path, userinfo, credential, fingerprint or identity.
/// MATCH proves only paired-instance equality, never a build or process identity.
pub(super) fn receiver_context(base: &str, catalog: &Result<(u16, Value), String>, instance: &str) -> String {
    let endpoint = reqwest::Url::parse(base).ok();
    let https = match endpoint.as_ref() {
        Some(url) if url.scheme() == "https" => "YES", Some(_) => "NO", None => "UNKNOWN",
    };
    let port = endpoint.as_ref().and_then(|url| url.port_or_known_default()).filter(|port| *port > 0)
        .map(|port| port.to_string()).unwrap_or_else(|| "UNKNOWN".into());
    let identity = match catalog {
        Ok((200, value)) => match value["desktopInstanceId"].as_str().filter(|id| !id.is_empty()) {
            Some(id) if id == instance => "MATCH", Some(_) => "MISMATCH", None => "MISSING",
        },
        _ => "NOT_OBSERVED",
    };
    format!(" receiverV=1 https={https} port={port} catalog={identity}")
}

/// Display-only mirror of main807's strict Mutation and rename input predicates.
/// Keys are never copied. M/N/S/X describe fixed slots, not values or lengths.
fn prepared_input_context(payload: &Value) -> String {
    let Some(object) = payload.as_object() else {
        return " inputV=1 shape=NON_OBJECT extra=UNKNOWN required=UNKNOWN types=UNKNOWN bodyId=UNKNOWN routeId=UNKNOWN title=UNKNOWN checks=LOCAL_REJECT".into();
    };
    const FIELDS: [&str; 8] = ["opId", "noteId", "vaultId", "kind", "expectedRevision", "title", "content", "parentRelativePath"];
    let extra = object.keys().any(|key| !FIELDS.contains(&key.as_str()));
    let required = ["opId", "vaultId", "kind"].iter().all(|key| object.contains_key(*key));
    let types: String = FIELDS.iter().map(|key| match object.get(*key) {
        None => 'M', Some(Value::Null) => 'N', Some(Value::String(_)) => 'S', _ => 'X',
    }).collect();
    let types_valid = FIELDS.iter().all(|key| match object.get(*key) {
        Some(Value::String(_)) => true,
        None | Some(Value::Null) => !matches!(*key, "opId" | "vaultId" | "kind"),
        _ => false,
    });
    let body_id = match object.get("noteId") {
        None => "MISSING", Some(Value::Null) => "NULL",
        Some(Value::String(id)) if !diagnostic_identifier(id) => "IDENTIFIER_INVALID",
        Some(Value::String(id)) if !id.starts_with("kn-") => "PREFIX_INVALID",
        Some(Value::String(_)) => "VALID", _ => "TYPE_INVALID",
    };
    // dispatch derives the Content path from this exact noteId. Do not label
    // this an observed remote URL, or guess it if dispatch cannot derive it.
    let route_id = match object.get("noteId").and_then(Value::as_str) {
        Some(id) if diagnostic_identifier(id) => "VALID",
        Some(_) => "INVALID", None => "UNKNOWN",
    };
    let title = match object.get("title") {
        None => "MISSING", Some(Value::Null) => "NULL",
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() { "BLANK" }
            else if value == "." || value == ".." { "DOT" }
            else if value.contains('\0') { "NUL" }
            else if value.contains('/') || value.contains('\\') { "SEPARATOR" }
            else if value.contains(':') { "COLON" }
            else if value.eq_ignore_ascii_case(".luckyray") { "RESERVED" }
            // safe_relative_path maps this to a different 409 Knowledge error,
            // NOT the NOTE_INPUT_INVALID title branch being investigated.
            else if value.starts_with('~') { "OTHER_PATH_RULE" }
            else { "VALID" }
        },
        _ => "TYPE_INVALID",
    };
    let rejected = extra || !required || !types_valid
        || matches!(body_id, "IDENTIFIER_INVALID" | "PREFIX_INVALID")
        || route_id == "INVALID"
        || matches!(title, "MISSING" | "NULL" | "TYPE_INVALID" | "BLANK" | "DOT" | "NUL" | "SEPARATOR" | "COLON" | "RESERVED");
    let checks = if rejected { "LOCAL_REJECT" }
        else if route_id == "UNKNOWN" || title == "OTHER_PATH_RULE" { "UNKNOWN" }
        else { "KNOWN_CHECKS_PASS" };
    format!(" inputV=1 shape=OBJECT extra={} required={} types={types} bodyId={body_id} routeId={route_id} title={title} checks={checks}",
        if extra { "YES" } else { "NO" }, if required { "PRESENT" } else { "MISSING" })
}

pub(super) fn create_route_capability(
    status: u16,
    catalog: &Value,
    instance: &str,
) -> Option<bool> {
    if status == 404 || status == 405 {
        return Some(false);
    }
    if status != 200
        || catalog["catalogVersion"] != 1
        || catalog["desktopInstanceId"] != instance
        || catalog["services"]["knowledge"]["version"] != 1
    {
        return None;
    }
    match catalog["operations"]["knowledge.createUnique"]["state"].as_str() {
        Some("implemented") => Some(true),
        Some("unsupported") | None => Some(false),
        // Unavailable/denied/new states are not authority to freeze a new
        // create via another route, but cannot block existing stored ops.
        _ => None,
    }
}

pub(super) async fn dispatch<F, Fut>(
    prepared: &PreparedNoteOperation,
    send: F,
) -> Result<(Outcome, Value), String>
where
    F: FnOnce(String, reqwest::Method, Value) -> Fut,
    Fut: Future<Output = Result<(u16, Value), String>>,
{
    let payload = &prepared.payload;
    let kind = payload["kind"]
        .as_str()
        .ok_or("CONTENT_OPERATION_INVALID")?;
    let id = payload["noteId"]
        .as_str()
        .ok_or("CONTENT_OPERATION_INVALID")?;
    let unique = prepared.route == NoteOperationRoute::KnowledgeCreateUnique;
    let planned = prepared.route == NoteOperationRoute::KnowledgeImportPlanned;
    if (unique || planned) && kind != "create" {
        return Err("CONTENT_OPERATION_ROUTE_INVALID".into());
    }
    let (path, wire_payload) = if planned {
        crate::managed_vault_linked_import::planned_wire(payload)?
    } else { (if unique {
        "/v1/services/knowledge/notes".to_owned()
    } else if kind == "create" {
        "/v1/notes".to_owned()
    } else {
        format!("/v1/notes/{id}")
    }, payload.clone()) };
    let method = match kind {
        "create" => reqwest::Method::POST,
        "delete" => reqwest::Method::DELETE,
        "update" | "rename" => reqwest::Method::PATCH,
        _ => return Err("CONTENT_OPERATION_INVALID".into()),
    };
    // Exactly one attempt. An uncertain result never changes route or payload.
    let (status, result) = send(path, method, wire_payload).await?;
    let outcome = if status == 200 {
        if planned { crate::managed_vault_linked_import::validate_receipt(payload, &result)?; }
        if unique && !unique_receipt_valid(payload, &result) {
            return Err("CONTENT_ACK_INVALID".into());
        }
        Outcome::Ack
    } else if status == 409 && result["code"] == "REVISION_CONFLICT" {
        if kind == "create" {
            if unique || planned {
                Outcome::Refused(status)
            } else {
                Outcome::LegacyCreateCollision
            }
        } else {
            Outcome::NoteConflict
        }
    } else if status == 503 && result["code"] == "DESKTOP_DRAFT_BUSY" {
        Outcome::DesktopBusy
    } else {
        Outcome::Refused(status)
    };
    Ok((outcome, result))
}

fn unique_receipt_valid(payload: &Value, receipt: &Value) -> bool {
    let document = &receipt["document"];
    receipt["opId"] == payload["opId"]
        && document["noteId"] == payload["noteId"]
        && document["vaultId"] == payload["vaultId"]
        && document["deleted"] != true
        && document["revision"].as_str().is_some_and(|v| !v.is_empty())
        && document["title"].is_string()
        && document["relativePath"].is_string()
        && document["content"].is_string()
        && document["resources"].is_array()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn planned_operation() -> PreparedNoteOperation {
        use sha2::{Digest, Sha256};
        PreparedNoteOperation { route: NoteOperationRoute::KnowledgeImportPlanned,
            payload: json!({"opId":"li-test","noteId":"kn-target","vaultId":"vault",
                "kind":"create","expectedRevision":"","title":"T","content":"[[./B.md]]",
                "importPlan":{"version":1,"planId":"ip-test","mappingHash":"a".repeat(64),
                    "relativePath":"T.md","contentSha256":format!("{:x}",Sha256::digest(b"[[./B.md]]"))}}) }
    }

    #[tokio::test]
    async fn planned_dispatch_is_exact_single_attempt_and_never_legacy_fallback() {
        let operation = planned_operation();
        let before = operation.payload.clone();
        let (path, wire) = crate::managed_vault_linked_import::planned_wire(&before).unwrap();
        for (status, code) in [(409,"REVISION_CONFLICT"),(409,"IMPORT_PATH_CONFLICT"),
            (409,"IMPORT_NOTE_ID_CONFLICT"),(404,"ENTITY_NOT_FOUND"),(403,"SCOPE_DENIED")] {
            let mut sends = 0;
            let (outcome, _) = dispatch(&operation, |actual, method, payload| {
                sends += 1;
                assert_eq!(actual,path); assert_eq!(method,reqwest::Method::POST);
                assert_eq!(payload,wire); assert!(payload.get("importPlan").is_none());
                async move { Ok((status,json!({"code":code}))) }
            }).await.unwrap();
            assert_eq!(outcome,Outcome::Refused(status)); assert_eq!(sends,1);
            assert_eq!(operation.payload,before);
        }
        let mut sends=0;
        assert_eq!(dispatch(&operation, |_,_,_| { sends+=1; async {Err("CONTENT_OFFLINE".into())} }).await.unwrap_err(),"CONTENT_OFFLINE");
        assert_eq!(sends,1); assert_eq!(operation.payload,before);
        let mut invalid=operation; invalid.payload["kind"]=json!("update");
        assert!(dispatch(&invalid, |_,_,_| async { panic!("invalid planned update sent") }).await.is_err());
    }

    #[tokio::test]
    async fn planned_ack_checks_mapping_body_path_and_receipt_identity() {
        let operation=planned_operation(); let p=&operation.payload;
        let receipt=json!({"opId":p["opId"],"planId":p["importPlan"]["planId"],
            "mappingHash":p["importPlan"]["mappingHash"],"noteId":p["noteId"],"state":"committed",
            "document":{"noteId":p["noteId"],"vaultId":p["vaultId"],"revision":"r1",
                "title":"T","relativePath":"T.md","content":p["content"],"resources":[]}});
        assert_eq!(dispatch(&operation,|_,_,_| async {Ok((200,receipt.clone()))}).await.unwrap().0,Outcome::Ack);
        let mut wrong_title=receipt.clone();wrong_title["document"]["title"]=json!("Foreign title");
        assert_eq!(dispatch(&operation,|_,_,_| async {Ok((200,wrong_title))}).await.unwrap_err(),"CONTENT_ACK_INVALID");
        for field in ["opId","planId","mappingHash","noteId","state"] {
            let mut bad=receipt.clone();bad[field]=json!("wrong");
            assert_eq!(dispatch(&operation,|_,_,_| async {Ok((200,bad))}).await.unwrap_err(),"CONTENT_ACK_INVALID");
        }
        for field in ["noteId","vaultId","relativePath","content","revision","title","resources"] {
            let mut bad=receipt.clone();bad["document"].as_object_mut().unwrap().remove(field);
            assert_eq!(dispatch(&operation,|_,_,_| async {Ok((200,bad))}).await.unwrap_err(),"CONTENT_ACK_INVALID");
        }
    }

    #[test]
    fn receiver_facts_are_bounded_and_never_copy_endpoint_or_catalog_private_values() {
        let same = Ok((200, json!({"desktopInstanceId":"private-instance","token":"private-token"})));
        for (base, https, port) in [
            ("https://private-user:private-password@private-host:6845/private-path?token=private-token#private-fragment", "YES", "6845"),
            ("https://private-host", "YES", "443"), ("http://private-host:37418", "NO", "37418"),
            ("https://private-host:65535", "YES", "65535"), ("https://private-host:0", "YES", "UNKNOWN"),
            ("https://private-host:65536", "UNKNOWN", "UNKNOWN"), ("private malformed endpoint", "UNKNOWN", "UNKNOWN"),
        ] {
            let before = same.clone();
            assert_eq!(receiver_context(base, &same, "private-instance"),
                format!(" receiverV=1 https={https} port={port} catalog=MATCH"));
            assert_eq!(same, before);
        }
        for (catalog, class) in [
            (Ok((200, json!({"desktopInstanceId":"private-other"}))), "MISMATCH"),
            (Ok((200, json!({}))), "MISSING"), (Ok((200, json!({"desktopInstanceId":""}))), "MISSING"),
            (Ok((200, json!({"desktopInstanceId":{"private":"value"}}))), "MISSING"),
            (Ok((403, json!({"desktopInstanceId":"private-instance"}))), "NOT_OBSERVED"),
            (Err("private transport error".into()), "NOT_OBSERVED"),
        ] {
            let output = receiver_context("https://private-host:6845/private", &catalog, "private-instance");
            assert!(output.ends_with(&format!("catalog={class}")));
            assert!(!output.contains("private"));
        }
    }

    #[tokio::test]
    async fn actual_title_only_rename_exposes_local_facts_and_keeps_later_draft_and_prepared_bytes() {
        let mut db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        db.content_vault_remember("A", "v", "V").unwrap();
        db.content_apply_batch("A", "v", &[json!({"noteId":"kn-a","vaultId":"v",
            "revision":"r1","title":"Test","relativePath":"Test.md","content":"base","resources":[]})], 1, None).unwrap();
        let epoch = db.content_begin_edit("A", "v", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
        db.content_edit("A", "v", "kn-a", "中文标题.MD", "base", epoch, 1).unwrap();
        let operation = db.content_prepare_available_operations("A", "v", Some(true)).unwrap().pop().unwrap();
        assert_eq!(operation.payload["kind"], "rename");
        assert_eq!(operation.route, NoteOperationRoute::Content);
        let before = operation.payload.clone();
        // New input must not replace the operation already submitted/prepared.
        db.content_edit("A", "v", "kn-a", "Later title", "later body", epoch, 2).unwrap();
        let replay = db.content_prepare_available_operations("A", "v", Some(true)).unwrap().pop().unwrap();
        assert_eq!(replay.payload, before);
        assert_eq!(replay.route, operation.route);
        let mut attempts = 0;
        let (outcome, result) = dispatch(&replay, |path, method, payload| {
            attempts += 1;
            assert_eq!(path, "/v1/notes/kn-a");
            assert_eq!(method, reqwest::Method::PATCH);
            assert_eq!(payload, before);
            async { Ok((400, json!({"code":"NOTE_INPUT_INVALID","message":"private response"}))) }
        }).await.unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(outcome, Outcome::Refused(400));
        let output = refusal_error(400, &replay, &result);
        assert_eq!(output, "CONTENT_MUTATION_HTTP_400 [NOTE_INPUT_INVALID] kind=rename route=content inputV=1 shape=OBJECT extra=NO required=PRESENT types=SSSSSSSN bodyId=VALID routeId=VALID title=VALID checks=KNOWN_CHECKS_PASS");
        assert_eq!(replay.payload, before);
        let note = db.content_note("A", "v", "kn-a").unwrap();
        assert_eq!(note["title"], "Later title");
        assert_eq!(note["content"], "later body");
        assert_eq!(note["dirty"], true);
    }

    #[test]
    fn prepared_predicates_match_strict_optional_types_identifiers_and_title_rules_without_private_values() {
        let valid = json!({"opId":"private-op","noteId":"kn-private-note","vaultId":"private-vault","kind":"rename",
            "expectedRevision":"private-revision","title":"私有中文.MD","content":"private-body","parentRelativePath":null});
        for (value, class, checks) in [
            ("私有中文.MD", "VALID", "KNOWN_CHECKS_PASS"), ("\u{3000} \t", "BLANK", "LOCAL_REJECT"),
            (".", "DOT", "LOCAL_REJECT"), ("..", "DOT", "LOCAL_REJECT"),
            ("private/a", "SEPARATOR", "LOCAL_REJECT"), ("private\\a", "SEPARATOR", "LOCAL_REJECT"),
            ("private:a", "COLON", "LOCAL_REJECT"), ("private\0a", "NUL", "LOCAL_REJECT"),
            (".LUCKYRAY", "RESERVED", "LOCAL_REJECT"), ("~private", "OTHER_PATH_RULE", "UNKNOWN"),
        ] {
            let mut payload = valid.clone(); payload["title"] = json!(value);
            let before = payload.clone();
            let output = prepared_input_context(&payload);
            assert!(output.ends_with(&format!("title={class} checks={checks}")), "{class}");
            assert!(!output.contains("private") && !output.contains("私有"));
            assert_eq!(payload, before);
        }
        for key in ["noteId", "expectedRevision", "content", "parentRelativePath"] {
            for null in [false, true] {
                let mut payload = valid.clone();
                if null { payload[key] = Value::Null; } else { payload.as_object_mut().unwrap().remove(key); }
                let output = prepared_input_context(&payload);
                assert!(output.contains("required=PRESENT"));
                // Optional noteId parses, but no route can be derived locally.
                assert!(output.ends_with(if key == "noteId" { "checks=UNKNOWN" } else { "checks=KNOWN_CHECKS_PASS" }));
            }
        }
        for key in ["opId", "noteId", "vaultId", "kind", "expectedRevision", "title", "content", "parentRelativePath"] {
            let mut payload = valid.clone(); payload[key] = json!({"private-key":"private-value"});
            let output = prepared_input_context(&payload);
            assert!(output.ends_with("checks=LOCAL_REJECT"));
            assert!(!output.contains("private"));
        }
        for key in ["opId", "vaultId", "kind"] {
            let mut payload = valid.clone(); payload.as_object_mut().unwrap().remove(key);
            assert!(prepared_input_context(&payload).contains("required=MISSING"));
        }
        for (id, body, route) in [
            ("nonkn-private", "PREFIX_INVALID", "VALID"), ("kn-私有", "IDENTIFIER_INVALID", "INVALID"),
            ("kn-private/path", "IDENTIFIER_INVALID", "INVALID"), ("", "IDENTIFIER_INVALID", "INVALID"),
        ] {
            let mut payload = valid.clone(); payload["noteId"] = json!(id);
            let output = prepared_input_context(&payload);
            assert!(output.contains(&format!("bodyId={body} routeId={route}")));
            assert!(!output.contains("private") && !output.contains("私有"));
        }
        let mut long_id = valid.clone(); long_id["noteId"] = json!(format!("kn-{}", "a".repeat(158)));
        assert!(prepared_input_context(&long_id).contains("bodyId=IDENTIFIER_INVALID"));
        long_id["noteId"] = json!(format!("kn-{}", "a".repeat(157)));
        assert!(prepared_input_context(&long_id).contains("bodyId=VALID"));
        let mut extra = valid.clone(); extra["private-arbitrary-key"] = json!("private-value");
        assert!(prepared_input_context(&extra).contains("extra=YES"));
        assert!(!prepared_input_context(&extra).contains("private"));
        for value in [json!(null), json!([]), json!("private-value")] {
            assert_eq!(prepared_input_context(&value), " inputV=1 shape=NON_OBJECT extra=UNKNOWN required=UNKNOWN types=UNKNOWN bodyId=UNKNOWN routeId=UNKNOWN title=UNKNOWN checks=LOCAL_REJECT");
        }
        for (value, class) in [(Some(Value::Null), "NULL"), (None, "MISSING")] {
            let mut payload = valid.clone();
            if let Some(value) = value { payload["title"] = value; } else { payload.as_object_mut().unwrap().remove("title"); }
            assert!(prepared_input_context(&payload).ends_with(&format!("title={class} checks=LOCAL_REJECT")));
        }
    }

    #[tokio::test]
    async fn refused_diagnostic_keeps_fixed_kind_route_code_and_immutable_attempt() {
        for (route, kind, expected_path, expected_method, code) in [
            (NoteOperationRoute::KnowledgeCreateUnique, "create", "/v1/services/knowledge/notes", reqwest::Method::POST, "INPUT_INVALID"),
            (NoteOperationRoute::Content, "update", "/v1/notes/kn-a", reqwest::Method::PATCH, "NOTE_INPUT_INVALID"),
        ] {
            let mut db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
            db.content_vault_remember("A", "v", "V").unwrap();
            if kind == "create" {
                db.content_create_in("A", "v", "kn-a", "Test", "", "").unwrap();
            } else {
                db.content_apply_batch("A", "v", &[json!({"noteId":"kn-a","vaultId":"v",
                    "revision":"r1","title":"Test","relativePath":"Test.md","content":"base","resources":[]})], 1, None).unwrap();
            }
            let epoch = db.content_begin_edit("A", "v", "kn-a").unwrap()["editorEpoch"].as_i64().unwrap();
            db.content_edit("A", "v", "kn-a", "Test", "saved body", epoch, 1).unwrap();
            let operation = db.content_prepare_available_operations("A", "v", Some(true)).unwrap().pop().unwrap();
            assert_eq!(operation.route, route);
            assert_eq!(operation.payload["kind"], kind);
            let object = operation.payload.as_object().unwrap();
            assert_eq!(object.len(), 8);
            for field in ["opId", "noteId", "vaultId", "kind", "expectedRevision", "title", "content", "parentRelativePath"] {
                assert!(object.contains_key(field), "production DTO field: {field}");
            }
            assert!(operation.payload["opId"].as_str().unwrap().bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
            assert_eq!(operation.payload["noteId"], "kn-a");
            assert_eq!(operation.payload["content"], "saved body");
            assert_eq!(operation.payload["expectedRevision"], if kind == "create" { "" } else { "r1" });
            assert_eq!(operation.payload["parentRelativePath"], if kind == "create" { json!("") } else { Value::Null });
            let before_payload = operation.payload.clone();
            let before_route = operation.route;
            let mut attempts = 0;
            let (outcome, body) = dispatch(&operation, |path, method, payload| {
                attempts += 1;
                assert_eq!(path, expected_path);
                assert_eq!(method, expected_method);
                assert_eq!(payload, before_payload);
                async move { Ok((400, json!({"code":code,"message":"private-body-token"}))) }
            }).await.unwrap();
            assert_eq!(attempts, 1);
            assert_eq!(operation.payload, before_payload);
            assert_eq!(operation.route, before_route);
            assert_eq!(outcome, Outcome::Refused(400));
            assert_eq!(refusal_error(400, &operation, &body), format!(
                "CONTENT_MUTATION_HTTP_400 [{code}] kind={kind} route={}",
                if route == NoteOperationRoute::Content { "content" } else { "knowledgeCreateUnique" }));
        }
    }

    #[test]
    fn refused_diagnostic_never_copies_private_or_unknown_response_and_request_strings() {
        let mut operation = prepared(NoteOperationRoute::Content);
        operation.payload["kind"] = json!("update private/title token");
        for code in [json!("future-code"), json!("NOTE_INPUT_INVALID private/token"), json!(null),
            json!(123), json!({"token":"private"}), json!("NOTE_INPUT_INVALID]\nprivate")] {
            assert_eq!(refusal_error(400, &operation, &json!({"code":code,"message":"private-body"})),
                "CONTENT_MUTATION_HTTP_400 [UNKNOWN] kind=UNKNOWN route=content");
        }
        let official: Value = serde_json::from_str(include_str!("../../../../shared/companion-services-v1/errors.json")).unwrap();
        for (code, status) in official["codes"].as_object().unwrap() {
            let output = refusal_error(status.as_u64().unwrap() as u16, &operation, &json!({"code":code}));
            assert!(output.contains(&format!("[{code}]")), "official code must not drift: {code}");
        }
    }

    fn prepared(route: NoteOperationRoute) -> PreparedNoteOperation {
        PreparedNoteOperation {
            route,
            payload: json!({"opId":"op","noteId":"note","vaultId":"vault",
            "kind":"create","expectedRevision":"","title":"T","content":"body"}),
        }
    }

    #[tokio::test]
    async fn discovery_503_preserves_stored_content_and_unique_ops_defers_new_creates_without_starvation(
    ) {
        let mut db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        db.content_vault_remember("A", "v", "V").unwrap();
        db.content_create("A", "v", "stored-content", "C", "body")
            .unwrap();
        let stored = db
            .content_prepare_available_operations("A", "v", Some(false))
            .unwrap()
            .pop()
            .unwrap();
        db.content_create("A", "v", "stored-unique", "U", "body")
            .unwrap();
        db.content_prepare_available_operations("A", "v", Some(true))
            .unwrap();
        for index in 0..60 {
            db.content_create("A", "v", &format!("a-new-{index:02}"), "N", "saved body")
                .unwrap();
        }
        let capability =
            create_route_capability(503, &serde_json::json!({"code":"SERVICE_UNAVAILABLE"}), "A");
        assert_eq!(capability, None);
        let pending = db
            .content_prepare_available_operations("A", "v", capability)
            .unwrap();
        assert_eq!(
            pending.len(),
            2,
            "unprepared creates are excluded BEFORE limit50"
        );
        let replay = pending
            .iter()
            .find(|op| op.payload["noteId"] == "stored-content")
            .unwrap();
        assert_eq!(replay.route, stored.route);
        assert_eq!(replay.payload, stored.payload);
        for operation in &pending {
            let expected_path = if operation.route == NoteOperationRoute::Content {
                "/v1/notes"
            } else {
                "/v1/services/knowledge/notes"
            };
            let (outcome, _) = dispatch(operation, |path, _, payload| {
                assert_eq!(path, expected_path);
                assert_eq!(payload, operation.payload);
                async { Ok((503, serde_json::json!({"code":"DESKTOP_DRAFT_BUSY"}))) }
            })
            .await
            .unwrap();
            assert_eq!(outcome, Outcome::DesktopBusy);
        }
        let payload = &replay.payload;
        let receipt = serde_json::json!({"opId":payload["opId"],"document":{"noteId":"stored-content","vaultId":"v",
            "revision":"r","title":"C","relativePath":"C.md","content":"body","resources":[]}});
        assert_eq!(
            dispatch(replay, |_, _, _| async { Ok((200, receipt.clone())) })
                .await
                .unwrap()
                .0,
            Outcome::Ack,
            "Content still succeeds although Services discovery failed"
        );
        db.content_ack(
            "A",
            "v",
            "stored-content",
            payload["opId"].as_str().unwrap(),
            &receipt["document"],
        )
        .unwrap();
        let epoch = db.content_begin_edit("A", "v", "stored-content").unwrap()["editorEpoch"]
            .as_i64()
            .unwrap();
        db.content_edit("A", "v", "stored-content", "C", "new body", epoch, 1)
            .unwrap();
        let update = db
            .content_prepare_available_operations("A", "v", None)
            .unwrap()
            .into_iter()
            .find(|op| op.payload["noteId"] == "stored-content")
            .unwrap();
        assert_eq!(update.payload["kind"], "update");
        assert_eq!(update.route, NoteOperationRoute::Content);
        let unresolved = db.content_note("A", "v", "a-new-00").unwrap();
        assert_eq!(unresolved["dirty"], true);
        assert_eq!(unresolved["content"], "saved body");
    }

    #[tokio::test]
    async fn unique_refusals_and_uncertain_result_never_enter_legacy_collision_or_change_payload() {
        let operation = prepared(NoteOperationRoute::KnowledgeCreateUnique);
        for (status, code, expected) in [
            (409, "REVISION_CONFLICT", Outcome::Refused(409)),
            (503, "DESKTOP_DRAFT_BUSY", Outcome::DesktopBusy),
            (409, "OP_ID_REUSED", Outcome::Refused(409)),
        ] {
            let (outcome, _) = dispatch(&operation, |path, method, payload| {
                assert_eq!(path, "/v1/services/knowledge/notes");
                assert_eq!(method, reqwest::Method::POST);
                assert_eq!(payload, operation.payload);
                async move { Ok((status, json!({"code":code}))) }
            })
            .await
            .unwrap();
            assert_eq!(outcome, expected);
        }
        let mut sends = 0;
        assert_eq!(
            dispatch(&operation, |_, _, payload| {
                sends += 1;
                assert_eq!(payload["expectedRevision"], "");
                async { Err("CONTENT_OFFLINE".to_owned()) }
            })
            .await
            .unwrap_err(),
            "CONTENT_OFFLINE"
        );
        assert_eq!(sends, 1);
    }

    #[tokio::test]
    async fn legacy_create_keeps_collision_handler_and_noncreate_keeps_content_route() {
        let operation = prepared(NoteOperationRoute::Content);
        let (outcome, _) = dispatch(&operation, |path, _, _| {
            assert_eq!(path, "/v1/notes");
            async { Ok((409, json!({"code":"REVISION_CONFLICT"}))) }
        })
        .await
        .unwrap();
        assert_eq!(outcome, Outcome::LegacyCreateCollision);
        let mut update = prepared(NoteOperationRoute::Content);
        update.payload["kind"] = json!("update");
        let (outcome, _) = dispatch(&update, |path, method, _| {
            assert_eq!(path, "/v1/notes/note");
            assert_eq!(method, reqwest::Method::PATCH);
            async { Ok((409, json!({"code":"REVISION_CONFLICT"}))) }
        })
        .await
        .unwrap();
        assert_eq!(outcome, Outcome::NoteConflict);
    }

    #[tokio::test]
    async fn unique_ack_requires_full_matching_receipt_before_local_ack() {
        let operation = prepared(NoteOperationRoute::KnowledgeCreateUnique);
        let receipt = json!({"opId":"op","document":{"noteId":"note","vaultId":"vault","revision":"r",
            "title":"T（副本）","relativePath":"T（副本）.md","content":"body","resources":[]}});
        assert_eq!(
            dispatch(&operation, |_, _, _| async { Ok((200, receipt.clone())) })
                .await
                .unwrap()
                .0,
            Outcome::Ack
        );
        for field in [
            "noteId",
            "vaultId",
            "revision",
            "title",
            "relativePath",
            "content",
            "resources",
        ] {
            let mut invalid = receipt.clone();
            invalid["document"].as_object_mut().unwrap().remove(field);
            assert_eq!(
                dispatch(&operation, |_, _, _| async { Ok((200, invalid)) })
                    .await
                    .unwrap_err(),
                "CONTENT_ACK_INVALID"
            );
        }
    }

    #[test]
    fn discovery_requires_exact_instance_and_explicit_operation_not_domain_summary() {
        let catalog = json!({"catalogVersion":1,"desktopInstanceId":"A","services":{"knowledge":{"version":1}},"operations":{"knowledge.createUnique":{"state":"implemented"}}});
        assert_eq!(create_route_capability(200, &catalog, "A"), Some(true));
        assert_eq!(create_route_capability(200, &catalog, "B"), None);
        assert_eq!(create_route_capability(404, &catalog, "A"), Some(false));
        assert_eq!(create_route_capability(503, &catalog, "A"), None);
        assert_eq!(create_route_capability(426, &catalog, "A"), None);
        let mut higher = catalog.clone();
        higher["services"]["knowledge"]["version"] = json!(2);
        assert_eq!(create_route_capability(200, &higher, "A"), None);
        for state in [
            "notGranted",
            "temporarilyUnavailable",
            "unsupported",
            "unknown",
        ] {
            let mut changed = catalog.clone();
            changed["operations"]["knowledge.createUnique"]["state"] = json!(state);
            assert_eq!(
                create_route_capability(200, &changed, "A"),
                if state == "unsupported" {
                    Some(false)
                } else {
                    None
                }
            );
        }
    }
}
