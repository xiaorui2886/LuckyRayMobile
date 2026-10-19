import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SyncCoordinator } from "../src/services/syncCoordinator.ts";
import { contentSyncDiagnostic } from "../src/services/contentSyncDiagnostic.ts";

test("a completed round with local paused or invalid-title drafts explains attention without claiming HTTP or ACK", async () => {
  const c = new SyncCoordinator(async () => ({ instanceId:"A", vaultId:"v", attentionRequired:true }), {foundationBlocked:false,contentOnly:true});
  await c.run();
  assert.deepEqual(contentSyncDiagnostic(c.snapshot()), {status:"草稿已保存在手机 · 需处理",errorCode:"CONTENT_SYNC_REQUIRES_ATTENTION",httpStatus:null});
  c.dispose();
});

test("actual refusal snapshot projects only fixed local prepared-input facts, not remote validation", async () => {
  const coordinator = new SyncCoordinator(async () => {
    throw new Error("CONTENT_MUTATION_HTTP_400 [NOTE_INPUT_INVALID] kind=rename route=content inputV=1 shape=OBJECT extra=NO required=PRESENT types=SSSSSSSN bodyId=VALID routeId=VALID title=VALID checks=KNOWN_CHECKS_PASS");
  }, { foundationBlocked: false, contentOnly: true });
  try {
    await coordinator.run();
    assert.deepEqual(contentSyncDiagnostic(coordinator.snapshot()), {
      status: "同步未完成", errorCode: "CONTENT_MUTATION_HTTP_400", httpStatus: 400,
      refusalCode: "NOTE_INPUT_INVALID", operationKind: "rename", routeKind: "content",
      preparedShape: "OBJECT", preparedExtra: "NO", preparedRequired: "PRESENT",
      preparedTypes: "SSSSSSSN", preparedBodyId: "VALID", preparedRouteId: "VALID",
      preparedTitle: "VALID", preparedChecks: "KNOWN_CHECKS_PASS",
    });
  } finally { coordinator.dispose(); }
});

test("mutation refusal retains safe operation context through the actual coordinator snapshot", async () => {
  const coordinator = new SyncCoordinator(async () => {
    throw new Error("CONTENT_MUTATION_HTTP_400 [NOTE_INPUT_INVALID] kind=create route=knowledgeCreateUnique");
  }, { foundationBlocked: false, contentOnly: true });
  try {
    await coordinator.run();
    assert.deepEqual(contentSyncDiagnostic(coordinator.snapshot()), {
      status: "同步未完成", errorCode: "CONTENT_MUTATION_HTTP_400", httpStatus: 400,
      refusalCode: "NOTE_INPUT_INVALID", operationKind: "create", routeKind: "knowledgeCreateUnique",
    });
  } finally { coordinator.dispose(); }
});

test("same-round receiver facts show only endpoint scheme port and paired catalog match", async () => {
  const error = "CONTENT_MUTATION_HTTP_400 [NOTE_INPUT_INVALID] kind=rename route=content inputV=1 shape=OBJECT extra=NO required=PRESENT types=SSSSSSSN bodyId=VALID routeId=VALID title=COLON checks=LOCAL_REJECT receiverV=1 https=YES port=6845 catalog=MATCH";
  const coordinator = new SyncCoordinator(async () => { throw new Error(error); }, { foundationBlocked: false, contentOnly: true });
  try {
    await coordinator.run();
    const out = contentSyncDiagnostic(coordinator.snapshot());
    assert.equal(out.preparedTitle, "COLON");
    assert.equal(out.receiverHttps, "YES");
    assert.equal(out.receiverPort, "6845");
    assert.equal(out.receiverCatalog, "MATCH");
    assert.equal(out.errorCode, "CONTENT_MUTATION_HTTP_400");
  } finally { coordinator.dispose(); }
});

test("local checks cannot claim pass with a rejected predicate or copy private suffix facts", () => {
  const base = { status: "error", pendingOutbox: 0, desktopBusyNotes: [] } as const;
  const frame = "CONTENT_MUTATION_HTTP_400 [NOTE_INPUT_INVALID] kind=rename route=content inputV=1 shape=OBJECT extra=NO required=PRESENT types=SSSSSSSN bodyId=VALID routeId=VALID title=VALID checks=KNOWN_CHECKS_PASS";
  for (const error of [
    frame.replace("bodyId=VALID", "bodyId=PREFIX_INVALID"),
    frame.replace("title=VALID", "title=OTHER_PATH_RULE"),
    frame.replace("types=SSSSSSSN", "types=SSSSSXSX"),
    frame.replace("extra=NO", "extra=YES"),
    frame.replace("title=VALID", "title=private/title/token"),
    frame + " rawKey=private", frame + "\nprivate-body", frame.replace("inputV=1", "inputV=999"),
  ]) assert.deepEqual(contentSyncDiagnostic({ ...base, error }), { status: "同步未完成", errorCode: "UNKNOWN", httpStatus: null });
});

test("fixed predicate and receiver boundary facts remain readonly and unknown private facts stay hidden", () => {
  const base = { status: "error", pendingOutbox: 123, desktopBusyNotes: ["private-note"] } as const;
  const prefix = "CONTENT_MUTATION_HTTP_400 [NOTE_INPUT_INVALID] kind=rename route=content inputV=1 shape=OBJECT extra=NO required=PRESENT types=SSSSSSSN bodyId=VALID routeId=VALID";
  for (const title of ["BLANK", "DOT", "SEPARATOR", "COLON", "NUL", "RESERVED", "MISSING", "NULL", "TYPE_INVALID"]) {
    const input = { ...base, error: `${prefix} title=${title} checks=LOCAL_REJECT receiverV=1 https=YES port=65535 catalog=MISMATCH` };
    const before = JSON.stringify(input);
    const out = contentSyncDiagnostic(input);
    assert.equal(out.preparedTitle, title);
    assert.equal(out.preparedChecks, "LOCAL_REJECT");
    assert.equal(out.receiverPort, "65535");
    assert.equal(out.receiverCatalog, "MISMATCH");
    assert.equal(JSON.stringify(input), before);
    assert.ok(!JSON.stringify(out).includes("private"));
  }
  assert.equal(contentSyncDiagnostic({ ...base, error: `${prefix} title=OTHER_PATH_RULE checks=UNKNOWN` }).preparedChecks, "UNKNOWN");
  for (const [https, port, catalog] of [["YES", "443", "MATCH"], ["NO", "1", "MISSING"], ["UNKNOWN", "UNKNOWN", "NOT_OBSERVED"]]) {
    const out = contentSyncDiagnostic({ ...base, error: `CONTENT_MUTATION_HTTP_403 [SCOPE_DENIED] kind=update route=content receiverV=1 https=${https} port=${port} catalog=${catalog}` });
    assert.equal(out.receiverHttps, https); assert.equal(out.receiverPort, port); assert.equal(out.receiverCatalog, catalog);
    assert.equal(out.operationKind, "update");
  }
  const legacy = "CONTENT_MUTATION_HTTP_400 [NOTE_INPUT_INVALID] kind=rename route=content";
  for (const suffix of [
    " receiverV=1 https=YES port=0 catalog=MATCH", " receiverV=1 https=YES port=65536 catalog=MATCH",
    " receiverV=1 https=private://token port=6845 catalog=MATCH", " receiverV=1 https=YES port=private catalog=MATCH",
    " receiverV=1 https=YES port=6845 catalog=private-instance", " receiverV=2 https=YES port=6845 catalog=MATCH",
    " receiverV=1 https=YES port=6845 catalog=MATCH raw=private-host", " receiverV=1 https=YES port=6845 catalog=MATCH\nprivate",
    " receiverV=1 https=YES port=6845 catalog=MATCH receiverV=1 https=YES port=6845 catalog=MATCH",
  ]) assert.deepEqual(contentSyncDiagnostic({ ...base, error: legacy + suffix }), { status: "同步未完成", errorCode: "UNKNOWN", httpStatus: null });
});

test("strict mutation context distinguishes Content update and never copies unknown private codes", () => {
  const snapshot = { status: "error", error: "", pendingOutbox: 999, desktopBusyNotes: [] } as const;
  for (const code of ["NOTE_INPUT_INVALID", "OP_ID_INVALID", "INVALID_QUERY", "INPUT_INVALID", "gateway-request-invalid"]) {
    assert.deepEqual(contentSyncDiagnostic({ ...snapshot,
      error: `CONTENT_MUTATION_HTTP_400 [${code}] kind=update route=content` }), {
      status: "同步未完成", errorCode: "CONTENT_MUTATION_HTTP_400", httpStatus: 400,
      refusalCode: code, operationKind: "update", routeKind: "content",
    });
  }
  for (const code of ["future-code", "NOTE_INPUT_INVALID private/body/token", "{\"private\":\"body\"}", "UNKNOWN"]) {
    const input = { ...snapshot, error: `CONTENT_MUTATION_HTTP_400 [${code}] kind=delete route=content` };
    const before = JSON.stringify(input);
    assert.deepEqual(contentSyncDiagnostic(input), {
      status: "同步未完成", errorCode: "CONTENT_MUTATION_HTTP_400", httpStatus: 400,
      refusalCode: "UNKNOWN", operationKind: "delete", routeKind: "content",
    });
    assert.equal(JSON.stringify(input), before);
  }
  for (const error of [
    "CONTENT_MUTATION_HTTP_400 [INPUT_INVALID]\nprivate kind=update route=content",
    "CONTENT_MUTATION_HTTP_400 [INPUT_INVALID] kind=private-note-id route=content",
    "CONTENT_MUTATION_HTTP_400 [INPUT_INVALID] kind=update route=/private/note",
    "CONTENT_MUTATION_HTTP_400 [INPUT_INVALID] kind=update route=content extra=private",
    "CONTENT_MUTATION_HTTP_200 [INPUT_INVALID] kind=update route=content",
    "CONTENT_MUTATION_HTTP_400 [INPUT_INVALID] kind=update route=knowledgeCreateUnique",
  ]) assert.deepEqual(contentSyncDiagnostic({ ...snapshot, error }),
    { status: "同步未完成", errorCode: "UNKNOWN", httpStatus: null });
});

test("content-only failure is observable from the existing coordinator snapshot, without capture counts", async () => {
  const coordinator = new SyncCoordinator(async () => { throw new Error("CONTENT_MUTATION_HTTP_403"); },
    { foundationBlocked: false, contentOnly: true });
  try {
    await coordinator.run();
    assert.deepEqual(contentSyncDiagnostic(coordinator.snapshot()), {
      status: "同步未完成", errorCode: "CONTENT_MUTATION_HTTP_403", httpStatus: 403,
    });
  } finally { coordinator.dispose(); }
});

test("unknown raw diagnostics never expose body, paths, tokens or guessed HTTP codes", () => {
  for (const error of ["prepare: /private/notes/token-secret.db missing 503", "{\"token\":\"secret\",\"status\":403}",
    "CONTENT_OFFLINE private-note-body", "content http 403 [FORBIDDEN]\nprivate-body", null]) {
    assert.deepEqual(contentSyncDiagnostic({ status: "error", error, pendingOutbox: 0, desktopBusyNotes: [] }),
      { status: "同步未完成", errorCode: "UNKNOWN", httpStatus: null });
  }
});

test("idle is waiting, not a claim that pending Content notes all synchronized", async () => {
  const coordinator = new SyncCoordinator(async () => ({ applied: 0, pushed: 0 }),
    { foundationBlocked: false, contentOnly: true });
  try {
    await coordinator.run();
    assert.deepEqual(contentSyncDiagnostic(coordinator.snapshot()), { status: "等待下一轮", errorCode: null, httpStatus: null });
    assert.deepEqual(contentSyncDiagnostic({ ...coordinator.snapshot(), status: "syncing" }),
      { status: "正在同步", errorCode: null, httpStatus: null });
    assert.deepEqual(contentSyncDiagnostic({ ...coordinator.snapshot(), status: "offline", error: "CONTENT_OFFLINE" }),
      { status: "暂时离线", errorCode: "CONTENT_OFFLINE", httpStatus: null });
  } finally { coordinator.dispose(); }
});

test("gateway status and a known typed refusal stay observable, never arbitrary server code", () => {
  const base = { status: "error", error: "content http 403 [FORBIDDEN]", pendingOutbox: 99, desktopBusyNotes: [] } as const;
  assert.deepEqual(contentSyncDiagnostic(base), { status: "同步未完成", errorCode: "FORBIDDEN", httpStatus: 403 });
  assert.deepEqual(contentSyncDiagnostic({ ...base, error: "content http 403 [private-token-body]" }),
    { status: "同步未完成", errorCode: "UNKNOWN", httpStatus: 403 });
});

test("support display preserves official safe typed codes and remains a readonly projection", () => {
  const official = JSON.parse(readFileSync(new URL("../shared/companion-services-v1/errors.json", import.meta.url), "utf8"));
  for (const [code, http] of Object.entries(official.codes)) {
    const input = { status: "error", error: `content http ${http} [${code}]`, pendingOutbox: 123,
      desktopBusyNotes: ['["instance","vault","private-note-id"]'] } as const;
    const before = JSON.stringify(input);
    assert.deepEqual(contentSyncDiagnostic(input), { status: "同步未完成", errorCode: code, httpStatus: http });
    assert.equal(JSON.stringify(input), before);
  }
});

test("actual shell and diagnostics use these tested projections, never raw error or capture counts", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const shell = read("src/still/StillShell.tsx");
  assert.match(shell, /const scene = stillScene\(r, key\)/);
  const diagnostic = read("src/still/StillSettings.tsx").split("export function StillDiagnostics()")[1].split("export function StillRecoveryPage()")[0];
  assert.match(diagnostic, /syncCoordinator\.subscribe\(fn\)/);
  assert.match(diagnostic, /syncCoordinator\.snapshot\(\)/);
  assert.match(diagnostic, /contentSyncDiagnostic\(sync\)/);
  for (const field of ["refusalCode", "operationKind", "routeKind"]) assert.ok(diagnostic.includes(`contentSync.${field}`));
  for (const field of ["preparedShape", "preparedExtra", "preparedRequired", "preparedTypes", "preparedBodyId", "preparedRouteId", "preparedTitle", "preparedChecks"]) assert.ok(diagnostic.includes(`contentSync.${field}`));
  assert.ok(diagnostic.includes("本地检查通过不代表远端已校验通过"));
  const caller = read("src-tauri/src/content/notes.rs");
  assert.match(caller, /let mut error = mutation::refusal_error\(status, &prepared, &result\)/);
  assert.match(caller, /mutation::receiver_context\(source\.gateway\.base_url\(\), &catalog_result, &source\.instance\)/);
  for (const field of ["receiverHttps", "receiverPort", "receiverCatalog"]) assert.ok(diagnostic.includes(`contentSync.${field}`));
  assert.doesNotMatch(diagnostic, /sync\.error|pendingOutbox|api\.contentSync|syncCoordinator\.(run|trigger|wake)/);
  assert.match(read("src/still/StillNote.tsx"), /查看同步诊断.*open\("diagnostics"\)/);
  const ci = read(".github/workflows/ci-lite.yml");
  for (const file of ["stillScene.test.ts", "contentSyncDiagnostic.test.ts"]) assert.ok(ci.includes(`tests/${file}`));
});
