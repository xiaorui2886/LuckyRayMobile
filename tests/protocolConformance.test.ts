// Protocol V1 conformance guardrails. These tests are intentionally local and
// deterministic so they can run in CI without a Gateway, Android device, or
// pairing secret.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_PROTOCOL_ERROR_ALIASES,
  PROTOCOL_ERROR_CODES,
  canonicalProtocolErrorCode,
} from "../shared/protocol-v1/typescript/index.ts";

const PROTOCOL_ROOT = join(import.meta.dirname, "..", "shared", "protocol-v1");

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(join(PROTOCOL_ROOT, relativePath), "utf8"));
}

function assertMatchesSchema(value: any, schema: any, label: string): void {
  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${label} must be one of ${schema.enum.join(", ")}`);
  }
  if (schema.type === "string") {
    assert.equal(typeof value, "string", `${label} must be a string`);
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${label} is too short`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${label} does not match ${schema.pattern}`);
    if (schema.format === "date-time") assert.ok(!Number.isNaN(Date.parse(value)), `${label} must be an ISO date-time`);
    if (schema.format === "uuid") assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, `${label} must be a UUID`);
  }
  if (schema.type === "integer") {
    assert.ok(Number.isInteger(value), `${label} must be an integer`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${label} must be >= ${schema.minimum}`);
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${label} must be an array`);
    for (const [index, item] of value.entries()) assertMatchesSchema(item, schema.items ?? {}, `${label}[${index}]`);
  }
  if (schema.type === "object") {
    assert.equal(typeof value, "object", `${label} must be an object`);
    assert.notEqual(value, null, `${label} must not be null`);
    for (const required of schema.required ?? []) assert.ok(required in value, `${label}.${required} is required`);
    for (const [property, propertySchema] of Object.entries<any>(schema.properties ?? {})) {
      if (property in value) assertMatchesSchema(value[property], propertySchema, `${label}.${property}`);
    }
  }
}

test("legacy recovery aliases normalize to the canonical Protocol V1 wire codes", () => {
  assert.equal(PROTOCOL_ERROR_CODES.REVISION_CONFLICT, "REVISION_CONFLICT");
  assert.equal(PROTOCOL_ERROR_CODES.CURSOR_TOO_OLD, "CURSOR_TOO_OLD");
  assert.deepEqual(LEGACY_PROTOCOL_ERROR_ALIASES, {
    NOTE_REVISION_CONFLICT: "REVISION_CONFLICT",
    RESYNC_REQUIRED: "CURSOR_TOO_OLD",
  });
  assert.equal(canonicalProtocolErrorCode("NOTE_REVISION_CONFLICT"), "REVISION_CONFLICT");
  assert.equal(canonicalProtocolErrorCode("RESYNC_REQUIRED"), "CURSOR_TOO_OLD");
  assert.equal(canonicalProtocolErrorCode("UNKNOWN_ERROR"), undefined);
});

test("recovery fixtures and frozen documentation publish one canonical code per condition", () => {
  const recovery = readJson("fixtures/recovery-errors.json");
  const aliases = readJson("fixtures/error-code-compatibility.json");
  const canonicalCodes = Object.values(PROTOCOL_ERROR_CODES).sort();

  assert.deepEqual(Object.keys(recovery).sort(), canonicalCodes);
  assert.equal(recovery.REVISION_CONFLICT.code, PROTOCOL_ERROR_CODES.REVISION_CONFLICT);
  assert.equal(recovery.CURSOR_TOO_OLD.code, PROTOCOL_ERROR_CODES.CURSOR_TOO_OLD);
  assert.equal(recovery.CURSOR_TOO_OLD.resync, true);
  assert.deepEqual(aliases, LEGACY_PROTOCOL_ERROR_ALIASES);

  const readme = readFileSync(join(PROTOCOL_ROOT, "README.md"), "utf8");
  const adr = readFileSync(join(PROTOCOL_ROOT, "ADR-0001-recovery-semantics.md"), "utf8");
  assert.match(readme, /`REVISION_CONFLICT`/);
  assert.match(adr, /M2\.4 compatibility clarification/);
});

test("mobile runtime consumes the shared canonical recovery-code contract", () => {
  const noteEditor = readFileSync(join(import.meta.dirname, "..", "src", "screens", "NoteEditor.tsx"), "utf8");
  const gateway = readFileSync(join(import.meta.dirname, "..", "src-tauri", "src", "gateway.rs"), "utf8");
  const core = readFileSync(join(import.meta.dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");

  assert.match(noteEditor, /isRevisionConflictError/);
  assert.doesNotMatch(noteEditor, /const ERROR_REVISION_CONFLICT/);
  assert.match(gateway, /pub const ERROR_CURSOR_TOO_OLD: &str = "CURSOR_TOO_OLD"/);
  assert.match(gateway, /response_protocol_error_code/);
  assert.match(core, /e\.contains\(gateway::ERROR_CURSOR_TOO_OLD\)/);
});

test("schemas, TypeScript contract, and fixtures agree on every Protocol V1 model", () => {
  const cases = [
    ["desktop-identity", readJson("fixtures/desktop-identity.json")],
    ["asset-summary", readJson("fixtures/asset-summary.json")],
    ["note-document", readJson("fixtures/note-document.json")],
    ["capture-operation", readJson("fixtures/capture-operation.json")],
    ["ai-run", readJson("fixtures/ai-run.json")],
  ] as const;
  const syncSchema = readJson("schemas/sync-change.schema.json");
  const syncPage = readJson("fixtures/sync-changes-page.json");
  const typescriptContract = readFileSync(join(PROTOCOL_ROOT, "typescript", "index.ts"), "utf8");

  for (const [name, fixture] of cases) {
    const schema = readJson(`schemas/${name}.schema.json`);
    assertMatchesSchema(fixture, schema, name);
    for (const required of schema.required ?? []) {
      assert.match(typescriptContract, new RegExp(`\\b${required}\\??\\s*:`), `${name}.${required} must remain in the TypeScript contract`);
    }
  }
  for (const [index, change] of syncPage.changes.entries()) {
    assertMatchesSchema(change, syncSchema, `sync-changes-page.changes[${index}]`);
  }
  for (const required of syncSchema.required ?? []) {
    assert.match(typescriptContract, new RegExp(`\\b${required}\\??\\s*:`), `SyncChange.${required} must remain in the TypeScript contract`);
  }
});
