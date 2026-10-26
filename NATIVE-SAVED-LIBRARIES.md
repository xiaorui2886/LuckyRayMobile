# Native saved-library scoping candidate

Base: installed mobile revision `f1e60f714b68d38713dafc22d21cf9adde0ee21e` (exact source overlays tracked in the package manifest). This is a source candidate, not an APK or a deployed change.

## Routing and isolation

- Every material list/detail/navigation/organization/thumb/original/media/download invoke accepts an optional immutable `library` identifier. Services requests accept immutable `library` and `vault` identifiers. The pinned GatewayClient supplies selection headers; no Desktop UI selection is changed.
- Selection invalidates a captured per-Desktop, per-domain epoch. Downloads and previews fence their captured epoch; cached and streaming media leases do the same. Local-owned media and LSH are not retired by library selection. Hint sockets carry frozen scopes and restart generations; mismatched scoped hints cannot wake another library.
- Material SQLite/cache filenames use a SHA-256 namespace derived from the Desktop and library. The old no-selection namespace remains readable as the legacy default only; no material cache is relabeled into a selected library. Complete resources, resumable downloads and derived previews share the same scope identity.
- Knowledge commands, replica/preparation, resources, attachment uploads and local-note upload targets retain their explicit Desktop/vault. Queued operations retain original opId, route and serialized target/payload. Switching libraries does not rewrite or migrate them.

## Compatibility

Catalog negotiation is unscoped and pinned. Version 1 enables selection. Endpoint 404 or the explicit `{scopeSelectionVersion:0, mode:"legacyDefaultOnly", authorizationMode:"legacy"}` response means default-only compatibility. Auth failures, unavailable services, a version-1 empty/denied catalog, and arbitrary malformed replies never fall back.

An old mandatory knowledge `vault` argument is not itself an explicit selection permission. Native verifies that it equals the legacy current vault, suppresses the new knowledge-selection header for that captured request, and preserves existing vault query/body routing. An explicit material library never falls back. Successful protocol negotiation is cached only for the lifetime of the captured operation, not globally or across pairing/catalog changes.

## Schema 14 and pairing replacement

Schema 14 transactionally widens `note_cache` identity from `(desktop_instance_id,note_id)` to `(desktop_instance_id,vault_id,note_id)`. Every one of its 19 persisted columns is copied unchanged. Pending operations, attachments, audit tables and phone-owned notes/assets are untouched. Legacy foundation note methods are restricted to the empty-vault namespace. Matching note IDs in two saved vaults are independent.

Pair replacement/forget rotates a durable resource-authority generation and clears response-cache authority. Downloaded complete files and local originals are not erased; old downloaded metadata cannot authorize bytes under a replacement pairing. Partial staging bytes from an old authority are not resumed. Local attachment copies fence both lifecycle and authority before publishing.

Previously dirty note rows are marked for review across credential replacement, without changing their stored operation. Only those rows are excluded from automatic push/attachment publication. Safe pulls and unrelated new note pushes continue. Sync returns `pairingReviewRequired` / `CONTENT_PAIRING_REVIEW_REQUIRED` as nonfatal attention. Ordinary reconnect, library switching and trust toggling do not create this marker.

Known limitation: no new recovery UI for these re-pair review markers is included. Do not describe old pending writes as uploaded or lost, and do not silently unpark them. Explicit review/recovery remains necessary.

## Validation and limits

Executed locally:
- Focused native-wiring/Services contract tests: 180 passed.
- Actual extracted application SQLite SQL: 5 passed via `python scripts/test-saved-library-migration.py`. Coverage includes all-column preservation, operation/attachment/audit preservation, FK/integrity/index checks, equal note IDs across vaults, injected transactional failure/rollback/retry, startup rerun, authority rotation, and parked-old versus unrelated-new queue eligibility.
- Full CI Lite-equivalent passed at the recorded checkpoint (1,699 tests plus TypeScript); later consolidated package reports supersede that count.

Added Rust regression tests cover cache namespace collisions, separate owner/domain epochs, exact legacy fallback, immutable operation targets, and routing header validation. They are NOT RUN here: no Rust/Cargo toolchain is present. No native compile, Android build, device test, real server revocation test, deployment, publication, runner execution, live permission change, or phone installation was performed. Source-pattern tests and SQLite execution are not substitutes for native compilation or device validation.
