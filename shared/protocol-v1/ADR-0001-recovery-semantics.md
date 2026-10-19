# ADR-0001 — Protocol V1 Recovery Semantics (frozen extension)

- Status: **ACCEPTED** (M2.1)
- Date: 2026-08-08
- Scope: clarifying error/recovery semantics of Protocol V1. **No existing field
  semantics are changed.** Recovery codes are additive.

## Motivation

Mobile must recover from: Desktop reinstall/instance change, TLS pin change,
durable journal compaction, revoked auth, and revision conflicts — without
silently trusting stale state.

## Error / recovery codes

| Condition | HTTP | code | Mobile action |
|---|---|---|---|
| Not paired / credential missing | 401 | `PAIRING_REQUIRED` | show pairing UI |
| Desktop reinstall / different instance detected | — | `DESKTOP_INSTANCE_CHANGED` | require re-pairing (never reuse old cache as authoritative) |
| TLS certificate fingerprint changed | handshake fail | — | require re-pairing (no silent pin rotation in V1) |
| Durable journal compacted / cursor expired | 410 | `CURSOR_TOO_OLD` | full resync from cursor 0; **Mobile outbox is never cleared** |
| Note update conflict | 409 | `REVISION_CONFLICT` | keep local draft, prompt refresh |
| Credential revoked by Desktop | 401 | `AUTH_REVOKED` | clear pairing, show pairing UI |
| Capability not supported by Desktop | 403 | `UNSUPPORTED_CAPABILITY` | hide/disable UI |

## Rules

1. `desktop_instance_id` change => re-pair. Old cache is kept on disk but never
   merged with the new instance namespace (cache keys are namespaced by
   `desktop_instance_id`).
2. TLS pin change => re-pair. Automatic silent pin rotation is deferred (V1.1).
3. `full resync` (CURSOR_TOO_OLD) resets only `sync_cursor`; it must not delete
   `capture_outbox` rows.
4. WS is a hint only; durable sync is authoritative.

## M2.4 compatibility clarification (2026-08-09)

This clarification reconciles accidental naming drift; it does not change any
recovery action or add a Protocol V1 capability.

1. The JSON error-body `code` is the canonical wire value. Note conflicts use
   `REVISION_CONFLICT`; expired durable cursors use `CURSOR_TOO_OLD`.
2. `NOTE_REVISION_CONFLICT` is a receive-only legacy alias for
   `REVISION_CONFLICT`. Mobile may normalize it from an already-deployed peer,
   but new Gateways must emit the canonical code.
3. `RESYNC_REQUIRED` is a receive-only legacy recovery hint from the M2 Mock
   Gateway's `X-LuckyRay-Code` header. It normalizes to `CURSOR_TOO_OLD`; it is
   not a second Protocol V1 error code and must not replace the JSON `code`.

## Fixtures

See `fixtures/recovery-errors.json` for machine-checkable examples.
