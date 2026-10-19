// M3-M1 Phase-A — deterministic red→green contracts for the 连接电脑 shell.
//
// The shell is ONE typed presentation/state layer that wraps INJECTED existing
// command ports (api.connState/connPair/connRevoke/wsStart/wsStop +
// QrScannerAdapter). It is not a store, not a second client, holds no
// persistence, and the only fake lives inside this test file — a source scan
// below proves no production fallback is wired.
//
// Run with `node --experimental-strip-types --test` (CI convention).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  derivePhase,
  createConnectionShellController,
  classifyPairFailure,
  shellErrorCopy,
  wsFailureCopy,
  type ShellSnapshot,
} from "../src/services/connectionShell.ts";

const ROOT = join(import.meta.dirname, "..");

// Unmistakably fake test fixtures — never real-looking credentials.
const FAKE_SECRET = "FAKE-SECRET-000-DO-NOT-USE";
const FAKE_FP = "a".repeat(64);
const FAKE_PAYLOAD = JSON.stringify({
  v: 1,
  name: "FAKE-DESK",
  instance: "fake-instance-000",
  ip: "192.0.2.1",
  port: 48180,
  secret: FAKE_SECRET,
  fp: FAKE_FP,
});

type FakeCalls = { pair: string[]; revoke: number; wsStart: number; wsStop: number; qrCancel: number };
type FakeSpec = {
  paired: boolean;
  wsState: string;
  identity?: { displayName: string; baseUrl: string; certificateFingerprint: string; instanceId: string };
  pairResult: "ok" | "fail";
  /** Message thrown by a failing connPair — mirrors the real Rust note
   *  (e.g. `pair http 409 [pairing-expired]`) so classification is exercised. */
  pairError?: string;
  revokeResult: "ok" | "fail";
  wsStartResult?: "ok" | "fail";
  /** Simulates the M2 hazard: the transition succeeds but the durable
   *  preference write failed. */
  wsStartPreferenceUnsaved?: boolean;
  wsStopPreferenceUnsaved?: boolean;
  connStateFails?: boolean;
};

function fakePorts(spec: FakeSpec) {
  const calls: FakeCalls = { pair: [], revoke: 0, wsStart: 0, wsStop: 0, qrCancel: 0 };
  // The fake authority is STATEFUL, mirroring how the real one behaves:
  // successful pair/revoke/ws transitions change what connState reports.
  const state = { paired: spec.paired, wsState: spec.wsState };
  const ports = {
    connState: async () => {
      if (spec.connStateFails) throw new Error("db busy (fake read failure)");
      return {
        paired: state.paired,
      identity: state.paired
        ? {
            instanceId: spec.identity?.instanceId ?? "fake-instance-000",
            displayName: spec.identity?.displayName ?? "FAKE-DESK",
            platform: "windows",
            appVersion: "0.0.0",
            protocolVersion: 1,
            certificateFingerprint: spec.identity?.certificateFingerprint ?? FAKE_FP,
            baseUrl: spec.identity?.baseUrl ?? "https://192.0.2.1:48180",
          }
        : null,
      stats: null,
      ws: { state: state.wsState, last_seq: 0, current: state.wsState },
      };
    },
    connPair: async (payload: string) => {
      calls.pair.push(payload);
      if (spec.pairResult === "fail") throw new Error(spec.pairError ?? "gateway unreachable");
      state.paired = true;
      if (state.wsState === "re_pair_required") state.wsState = "stopped";
      return {};
    },
    connRevoke: async () => {
      calls.revoke += 1;
      // Mirror the REAL authority (Phase-B R1 P1-3): local forget retires the
      // authenticated WSS session before/with credential clearing.
      calls.wsStop += 1;
      if (spec.revokeResult === "fail") throw new Error("keystore locked");
      state.paired = false;
      state.wsState = "stopped";
      return "ok";
    },
    wsStart: async () => {
      calls.wsStart += 1;
      if (spec.wsStartResult === "fail") throw new Error("lan unreachable");
      state.wsState = "connected";
      // Mirrors the real command: the transition result carries whether the
      // durable preference was written.
      return { status: "started", preferenceSaved: !spec.wsStartPreferenceUnsaved };
    },
    wsStop: async () => {
      calls.wsStop += 1;
      state.wsState = "stopped";
      return { status: "stopped", preferenceSaved: !spec.wsStopPreferenceUnsaved };
    },
    qrScan: async () => ({ ok: false as const, reason: "timeout" as const }),
    qrCancel: async () => {
      calls.qrCancel += 1;
    },
  };
  return { ports, calls };
}

function makeController(spec: FakeSpec, opts?: { revokedHoldMs?: number }) {
  const { ports, calls } = fakePorts(spec);
  const controller = createConnectionShellController(ports, { revokedHoldMs: opts?.revokedHoldMs ?? 10 });
  return { controller, calls };
}

// ---------------------------------------------------------------------------
// 1) typed presentation mapping — never claims realtime from metadata alone
// ---------------------------------------------------------------------------
test("derivePhase maps every required state truthfully", () => {
  assert.equal(derivePhase(false, "connected"), "unpaired");
  assert.equal(derivePhase(false, "stopped"), "unpaired");
  assert.equal(derivePhase(true, "connected"), "connected");
  assert.equal(derivePhase(true, "connecting"), "reconnecting");
  assert.equal(derivePhase(true, "reconnecting"), "reconnecting");
  assert.equal(derivePhase(true, "re_pair_required"), "re_pair_required");
  // paired + anything else must NOT be presented as connected/reconnecting.
  assert.equal(derivePhase(true, "stopped"), "paired_idle");
  assert.equal(derivePhase(true, "offline"), "paired_idle");
  assert.equal(derivePhase(true, "error"), "paired_idle");
});

test("AUTH_REVOKED authority requires re-pair and never offers same-bearer reconnect", async () => {
  const { controller } = makeController({ paired: true, wsState: "re_pair_required", pairResult: "ok" });
  await controller.refresh();
  assert.equal(controller.snapshot().phase, "re_pair_required");
  const page = readFileSync(join(ROOT, "src", "screens", "ConnectComputer.tsx"), "utf8");
  assert.match(page, /需要重新配对/, "typed terminal state has truthful copy");
  assert.match(page, /snap\.phase === "re_pair_required"/, "terminal state has a dedicated surface");
  const settings = readFileSync(join(ROOT, "src", "screens", "Settings.tsx"), "utf8");
  assert.match(
    settings,
    /ws\.state === "re_pair_required"[\s\S]*重新配对[\s\S]*api\.wsStart/,
    "Settings routes terminal auth to re-pair instead of same-bearer wsStart",
  );
});

test("re-pair submits a new credential then starts a fresh worker", async () => {
  const { controller, calls } = makeController({ paired: true, wsState: "re_pair_required", pairResult: "ok" });
  await controller.refresh();
  controller.openPaste();
  await controller.submitPaste(FAKE_PAYLOAD);
  assert.equal(calls.pair.length, 1, "new pair authority called once");
  assert.equal(calls.wsStart, 1, "fresh credential starts one new worker");
  assert.equal(controller.snapshot().phase, "connected");
});

test("successful first pairing and re-pair remain paired when the worker cannot connect", async () => {
  for (const paired of [false, true]) {
    const { controller, calls } = makeController({
      paired,
      wsState: paired ? "re_pair_required" : "stopped",
      pairResult: "ok",
      wsStartResult: "fail",
    });
    await controller.refresh();
    controller.openPaste();
    await controller.submitPaste(FAKE_PAYLOAD);
    assert.equal(calls.pair.length, 1);
    assert.equal(calls.wsStart, 1);
    assert.equal(controller.snapshot().phase, "paired_idle", "new credential remains authoritative");
    assert.equal(controller.snapshot().identity?.displayName, "FAKE-DESK");
    assert.equal(controller.snapshot().error, undefined, "transport failure is not mislabeled pair_failed");
  }
});

test("re-pair scan denial and scanner exception preserve terminal authority", async () => {
  for (const result of ["denied", "throws"] as const) {
    const fake = fakePorts({ paired: true, wsState: "re_pair_required", pairResult: "ok" });
    fake.ports.qrScan = async () => {
      if (result === "throws") throw new Error("camera fixture");
      return { ok: false as const, reason: "denied" as const };
    };
    const controller = createConnectionShellController(fake.ports, { revokedHoldMs: 10 });
    await controller.refresh();
    await controller.openScan();
    assert.equal(controller.snapshot().phase, "re_pair_required", `${result} keeps re-pair required`);
    // A denied camera is its own typed cause; a bridge exception stays generic.
    assert.equal(
      controller.snapshot().error?.code,
      result === "denied" ? "scan_denied" : "scan_failed"
    );
  }
});

test("unmount during re-pair scan preserves terminal authority", async () => {
  let release: (() => void) | null = null;
  const fake = fakePorts({ paired: true, wsState: "re_pair_required", pairResult: "ok" });
  fake.ports.qrScan = async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { ok: false as const, reason: "timeout" as const };
  };
  const controller = createConnectionShellController(fake.ports, { revokedHoldMs: 10 });
  await controller.refresh();
  const scanning = controller.openScan();
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.cancelIfScanning();
  assert.equal(controller.snapshot().phase, "re_pair_required");
  release?.();
  await scanning;
  assert.equal(controller.snapshot().phase, "re_pair_required", "stale scanner completion cannot falsify authority");
});

test("snapshot phase follows refreshed authority, not metadata alone", async () => {
  const { controller } = makeController({ paired: true, wsState: "connected" });
  await controller.refresh();
  assert.equal(controller.snapshot().phase, "connected");
});

// ---------------------------------------------------------------------------
// 2) pairing flow: bounded busy, no double-submit
// ---------------------------------------------------------------------------
test("submitPaste enters pairing exactly once and rejects double-submit", async () => {
  const { controller, calls } = makeController(
    { paired: false, wsState: "stopped", pairResult: "ok" },
    { revokedHoldMs: 10 }
  );
  await controller.openPaste();
  assert.equal(controller.snapshot().mode, "paste");
  const first = controller.submitPaste(FAKE_PAYLOAD);
  assert.equal(controller.snapshot().phase, "pairing", "bounded busy while pairing");
  await assert.rejects(() => controller.submitPaste(FAKE_PAYLOAD), /busy/);
  assert.equal(calls.pair.length, 1, "exactly one connPair call");
  await first;
  assert.equal(calls.pair[0], FAKE_PAYLOAD, "raw payload forwarded to the existing parser seam");
  assert.equal(calls.wsStart, 1, "first pairing starts the existing worker exactly once");
  assert.equal(controller.snapshot().phase, "connected", "refreshed after the worker authority connects");
});

test("successful pairing reaches connected only via ws authority", async () => {
  const { ports, calls } = fakePorts({ paired: false, wsState: "stopped", pairResult: "ok" });
  ports.wsStart = async () => {
    calls.wsStart += 1;
    return "worker scheduled";
  };
  const shell = createConnectionShellController(ports, { revokedHoldMs: 10 });
  await shell.openPaste();
  await shell.submitPaste(FAKE_PAYLOAD);
  assert.equal(calls.pair.length, 1);
  assert.equal(calls.wsStart, 1);
  assert.equal(shell.snapshot().phase, "paired_idle", "starting a worker cannot manufacture a connected snapshot");
});

test("successful scan pairing also starts the existing worker once", async () => {
  const { ports, calls } = fakePorts({ paired: false, wsState: "stopped", pairResult: "ok" });
  const controller = createConnectionShellController({
    ...ports,
    qrScan: async () => ({ ok: true, content: FAKE_PAYLOAD }),
  });
  await controller.openScan();
  assert.deepEqual(calls.pair, [FAKE_PAYLOAD]);
  assert.equal(calls.wsStart, 1);
  assert.equal(controller.snapshot().phase, "connected");
});

test("pairing stays single-flight while its worker start is pending", async () => {
  const { ports, calls } = fakePorts({ paired: false, wsState: "stopped", pairResult: "ok" });
  let release!: () => void;
  const start = ports.wsStart;
  ports.wsStart = async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return start();
  };
  const controller = createConnectionShellController(ports);
  const first = controller.submitPaste(FAKE_PAYLOAD);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().phase, "pairing");
  await assert.rejects(() => controller.submitPaste(FAKE_PAYLOAD), /busy/);
  release();
  await first;
  assert.equal(calls.pair.length, 1);
  assert.equal(calls.wsStart, 1);
});

// ---------------------------------------------------------------------------
// 3) cancel / scan reasons return to a usable unpaired state
// ---------------------------------------------------------------------------
test("cancel returns from paste mode to unpaired", async () => {
  const { controller } = makeController({ paired: false, wsState: "stopped", pairResult: "ok" });
  await controller.openPaste();
  controller.cancel();
  assert.equal(controller.snapshot().phase, "unpaired");
  assert.equal(controller.snapshot().mode, null);
});

test("scan denied/timeout returns to usable unpaired with typed copy, no raw body", async () => {
  const denied = fakePorts({ paired: false, wsState: "stopped", pairResult: "ok" });
  denied.ports.qrScan = async () => ({ ok: false, reason: "denied" as const });
  denied.ports.qrCancel = async () => {};
  const controller = createConnectionShellController(denied.ports, { revokedHoldMs: 10 });
  await controller.openScan();
  assert.equal(controller.snapshot().phase, "unpaired", "usable state after denied scan");
  assert.equal(controller.snapshot().error?.code, "scan_denied", "camera denial is its own cause");
  const copy = shellErrorCopy(controller.snapshot().error!);
  assert.ok(copy.length > 0);
  assert.ok(!copy.includes("denied message"));
  // The copy names a real next step: system permission, or the other method.
  assert.ok(copy.includes("相机权限"));
  assert.ok(copy.includes("其他配对方式"));
});

// ---------------------------------------------------------------------------
// 4) pair error → typed error with retry/back; user-safe copy only
// ---------------------------------------------------------------------------
test("pair failure surfaces typed error with retry/back and no secret/payload/raw body", async () => {
  const { controller, calls } = makeController({ paired: false, wsState: "stopped", pairResult: "fail" });
  await controller.openPaste();
  await controller.submitPaste(FAKE_PAYLOAD); // resolves: failure becomes typed error
  assert.equal(calls.wsStart, 0, "a rejected pairing must never start realtime transport");
  const snap = controller.snapshot();
  assert.equal(snap.phase, "error");
  assert.equal(snap.error?.code, "pair_unreachable", "a transport failure is classified as unreachable");
  assert.ok(snap.error?.retryable);
  const copy = shellErrorCopy(snap.error!);
  assert.ok(!copy.includes(FAKE_SECRET), "copy must never contain the secret");
  assert.ok(!copy.includes(FAKE_PAYLOAD), "copy must never contain the payload content");
  assert.ok(!copy.includes("gateway unreachable"), "copy must not leak the raw error body");
  assert.ok(!copy.includes(FAKE_FP));
  // snapshot must not carry the payload/secret around either
  assert.equal(JSON.stringify(snap).includes(FAKE_SECRET), false, "snapshot must not persist the secret");
  assert.equal(JSON.stringify(snap).includes("gateway unreachable"), false, "snapshot must not persist the raw body");

  // retry: returns to the SAME surface the user came from (paste), not scan
  await controller.retry();
  assert.equal(controller.snapshot().phase, "scanning_or_paste");
  assert.equal(controller.snapshot().mode, "paste", "a paste failure retries through the paste field");
  // back: authority-derived — unpaired stays unpaired
  await controller.back();
  assert.equal(controller.snapshot().phase, "unpaired");
  void calls;
});

// ---------------------------------------------------------------------------
// 4b) M3-M1 R2: retry preserves the pairing SOURCE, and failure causes are
//     classified from the frozen Desktop codes instead of one generic message.
// ---------------------------------------------------------------------------
test("retry after a scan failure returns to the scanner, not the paste field", async () => {
  const fake = fakePorts({ paired: false, wsState: "stopped", pairResult: "ok" });
  let scans = 0;
  fake.ports.qrScan = async () => {
    scans += 1;
    // First scan fails; the retried scan succeeds and pairs.
    return scans === 1
      ? { ok: false as const, reason: "timeout" as const }
      : { ok: true as const, content: FAKE_PAYLOAD };
  };
  const controller = createConnectionShellController(fake.ports, { revokedHoldMs: 10 });
  await controller.openScan();
  assert.equal(controller.snapshot().error?.code, "scan_timeout");
  await controller.retry();
  assert.equal(scans, 2, "retry re-enters the scanner");
  assert.equal(controller.snapshot().mode, null, "successful retry left the input surface");
  assert.equal(fake.calls.pair.length, 1, "the retried scan paired exactly once");
});

test("retry after a scan failure that produces a bad payload keeps the scan source", async () => {
  const fake = fakePorts({ paired: false, wsState: "stopped", pairResult: "fail", pairError: "pair http 410 [pairing-expired]" });
  let scans = 0;
  fake.ports.qrScan = async () => {
    scans += 1;
    return { ok: true as const, content: FAKE_PAYLOAD };
  };
  const controller = createConnectionShellController(fake.ports, { revokedHoldMs: 10 });
  await controller.openScan();
  assert.equal(controller.snapshot().error?.code, "pair_expired", "the Desktop's expiry code drives the copy");
  const copy = shellErrorCopy(controller.snapshot().error!);
  assert.ok(copy.includes("重新生成"), "copy tells the user to regenerate on the Desktop");
  await controller.retry();
  assert.equal(scans, 2, "a scanned-but-expired code retries through the scanner again");
});

test("pair failure classification distinguishes expired from unreachable", () => {
  assert.equal(classifyPairFailure("pair http 409 [pairing-expired]"), "pair_expired");
  assert.equal(classifyPairFailure("pair http 409 [pairing-required]"), "pair_expired");
  assert.equal(classifyPairFailure("pair http 409 [pairing-replayed]"), "pair_expired");
  assert.equal(classifyPairFailure("hello: connect error: Connection refused"), "pair_unreachable");
  assert.equal(classifyPairFailure("pair: error trying to connect: tcp connect error: timed out"), "pair_unreachable");
  assert.equal(classifyPairFailure("json: expected value at line 1"), "pair_failed");
  // The classification never needs the payload/secret to decide.
  assert.equal(classifyPairFailure(""), "pair_failed");
});

// R2-REPAIR-R3: the remaining frozen Desktop codes each get a next step that
// matches the real capability, instead of one generic retry.
test("pair failure classification covers device limit, rate limit and bad code", () => {
  assert.equal(classifyPairFailure("pair http 409 [pairing-device-limit]"), "pair_device_limit");
  assert.equal(classifyPairFailure("pair http 429 [pairing-rate-limited]"), "pair_rate_limited");
  assert.equal(classifyPairFailure("pair http 429 [pairing-attempt-limit]"), "pair_rate_limited");
  assert.equal(classifyPairFailure("pair http 429 [AUTH_RATE_LIMITED]"), "pair_rate_limited");
  assert.equal(classifyPairFailure("pair http 401 [pairing-secret-invalid]"), "pair_bad_code");
  assert.equal(classifyPairFailure("pair http 410 [pairing-generation-retired]"), "pair_expired");
  assert.equal(classifyPairFailure("pair http 409 [pairing-already-active]"), "pair_expired");

  // Each copy names a next step that matches what the user can actually do.
  const deviceLimit = shellErrorCopy({ code: "pair_device_limit", retryable: true });
  assert.ok(deviceLimit.includes("撤销"), "device limit points at revoking a device");
  const rateLimited = shellErrorCopy({ code: "pair_rate_limited", retryable: true });
  assert.ok(rateLimited.includes("频繁"), "rate limit says it was too frequent");
  const badCode = shellErrorCopy({ code: "pair_bad_code", retryable: true });
  assert.ok(badCode.includes("重新生成"), "bad code points at regenerating");
  // None of the new copy leaks structural detail.
  for (const copy of [deviceLimit, rateLimited, badCode]) {
    assert.ok(!copy.includes("pairing-"), "copy never contains a raw error code");
    assert.ok(!copy.includes("http"));
    assert.ok(!/[{}\[\]]/.test(copy), "copy never contains JSON punctuation");
  }
});

// R2-REPAIR-R3 M2: a successful transition whose preference write failed must
// be reported as a caveat, never as a failed operation.
test("a stopped disconnect with an unsaved preference stays truthful", async () => {
  const { controller, calls } = makeController({
    paired: true,
    wsState: "connected",
    pairResult: "ok",
    wsStopPreferenceUnsaved: true,
  });
  await controller.refresh();
  assert.equal(controller.snapshot().phase, "connected");

  await controller.disconnect();
  const snap = controller.snapshot();
  // The worker IS stopped — that must not be reported as a failure…
  assert.notEqual(snap.phase, "error", "a saved-failed stop is not disconnect_failed");
  assert.equal(snap.error, undefined, "no typed error for a succeeded stop");
  assert.equal(snap.ws.state, "stopped", "the transport is genuinely stopped");
  // …but the durability caveat is visible.
  assert.equal(snap.notice, "preference_unsaved");
  assert.equal(calls.wsStop, 1);

  // A later clean transition clears the caveat.
  await controller.reconnect();
  assert.equal(controller.snapshot().notice, undefined, "a clean transition clears the notice");
});

test("a resumed reconnect with an unsaved preference is not a failure", async () => {
  const { controller } = makeController({
    paired: true,
    wsState: "stopped",
    pairResult: "ok",
    wsStartPreferenceUnsaved: true,
  });
  await controller.refresh();
  assert.equal(controller.snapshot().phase, "paired_idle");

  await controller.reconnect();
  const snap = controller.snapshot();
  assert.notEqual(snap.phase, "error", "the reconnect itself succeeded");
  assert.equal(snap.error, undefined);
  assert.equal(snap.ws.state, "connected", "the transport is genuinely connected");
  assert.equal(snap.notice, "preference_unsaved");
});

test("a clean disconnect carries no caveat", async () => {
  const { controller } = makeController({ paired: true, wsState: "connected", pairResult: "ok" });
  await controller.refresh();
  await controller.disconnect();
  assert.equal(controller.snapshot().notice, undefined, "no notice when the preference saved");
  assert.equal(controller.snapshot().error, undefined);
});

// ---------------------------------------------------------------------------
// 5) revoke/forget truthfulness + distinct disconnect
// ---------------------------------------------------------------------------
test("forget clears UI identity only after connRevoke succeeds; failure stays truthful", async () => {
  const ok = makeController({ paired: true, wsState: "connected", revokeResult: "ok" }, { revokedHoldMs: 10 });
  await ok.controller.refresh();
  assert.equal(ok.controller.snapshot().phase, "connected");
  await ok.controller.forget();
  // bounded revoked transition…
  assert.equal(ok.controller.snapshot().phase, "revoked");
  // …then truthful unpaired (authority refresh).
  await new Promise((r) => setTimeout(r, 30));
  await ok.controller.refresh();
  assert.equal(ok.controller.snapshot().phase, "unpaired");
  assert.equal(ok.calls.revoke, 1);
  // Phase-B R1 (P1-3): the FAKE mirrors the real authority — local forget
  // retires the WSS session (the fake bumps wsStop to mirror it). The shell
  // itself still only called connRevoke once; the fake's internal stop models
  // the Rust conn_revoke stopping the EventStream before credential clearing.
  assert.equal(ok.calls.revoke, 1, "exactly one revoke");

  const bad = makeController({ paired: true, wsState: "connected", revokeResult: "fail" });
  await bad.controller.refresh();
  await bad.controller.forget();
  const snap = bad.controller.snapshot();
  assert.equal(snap.phase, "error");
  assert.equal(snap.error?.code, "revoke_failed");
  const copy = shellErrorCopy(snap.error!);
  assert.ok(!copy.includes("keystore locked"), "raw body must not leak");
});

test("disconnect uses wsStop and stays paired; forget is a distinct operation", async () => {
  const { controller, calls } = makeController({ paired: true, wsState: "connected", revokeResult: "ok" });
  await controller.refresh();
  await controller.disconnect();
  assert.equal(calls.wsStop, 1);
  assert.equal(calls.revoke, 0, "disconnect must not revoke pairing");
  // ws stopped → authority-derived truthful idle (not connected).
  assert.equal(controller.snapshot().phase, "paired_idle");
});

// ---------------------------------------------------------------------------
// 6) secret-negative: no web storage writes in the shell surface
// ---------------------------------------------------------------------------
test("shell sources never log via console (payload/secret never reach logs)", () => {
  const files = [
    join(ROOT, "src", "services", "connectionShell.ts"),
    join(ROOT, "src", "screens", "ConnectComputer.tsx"),
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(src), `${f} must not log via console`);
  }
});

test("shell sources never touch localStorage/sessionStorage/IndexedDB/clipboard", () => {
  const files = [
    join(ROOT, "src", "services", "connectionShell.ts"),
    join(ROOT, "src", "screens", "ConnectComputer.tsx"),
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    for (const needle of ["localStorage", "sessionStorage", "indexedDB", "navigator.clipboard", "document.cookie"]) {
      assert.ok(!src.includes(needle), `${f} must not reference ${needle}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 7) the fake is test-only — no production fallback wiring
// ---------------------------------------------------------------------------
test("fake ports live only in tests; production imports wire real ports", () => {
  const shell = readFileSync(join(ROOT, "src", "services", "connectionShell.ts"), "utf-8");
  const page = readFileSync(join(ROOT, "src", "screens", "ConnectComputer.tsx"), "utf-8");
  for (const src of [shell, page]) {
    assert.ok(!src.includes("FakePorts"), "no fake type/impl in production sources");
    assert.ok(!src.includes("fakePorts"), "no fake factory in production sources");
    assert.ok(!src.includes("FAKE-SECRET"), "no fake secret constant in production sources");
  }
  // The page must wire the real existing authorities.
  assert.ok(page.includes("QrScannerAdapter"), "page uses the existing QR authority");
  // The shell itself is port-injected: type imports are fine, but it must
  // never call the api seam at runtime.
  assert.ok(!shell.includes("invoke("), "shell stays port-injected (no runtime api call)");
  const pageApi = readFileSync(join(ROOT, "src", "screens", "ConnectComputer.tsx"), "utf-8");
  assert.ok(pageApi.includes('from "../services/client"'), "page imports the existing api seam");
});

// ---------------------------------------------------------------------------
// 8) snapshot never embeds the raw payload even on success paths
// ---------------------------------------------------------------------------
test("snapshot keeps identity fields only (name/base/fp-summary), never secret fields", async () => {
  const { controller } = makeController({
    paired: true,
    wsState: "connected",
    identity: {
      displayName: "FAKE-DESK",
      baseUrl: "https://192.0.2.1:48180",
      certificateFingerprint: FAKE_FP,
      instanceId: "fake-instance-000",
    },
  });
  await controller.refresh();
  const snap = controller.snapshot() as unknown as Record<string, unknown>;
  const text = JSON.stringify(snap);
  assert.ok(text.includes("FAKE-DESK"), "desktop display name shown");
  assert.ok(text.includes("https://192.0.2.1:48180"), "LAN base url shown");
  assert.ok(!text.includes("secret"), "no secret field in snapshot");
  // fingerprint summary is short (not the full 64-hex)
  const summary = (controller.snapshot() as unknown as { identity?: { fingerprintSummary?: string } }).identity?.fingerprintSummary ?? "";
  assert.ok(summary.length > 0 && summary.length < 64, "fingerprint summary is short");
});


// ---------------------------------------------------------------------------
// 9) Review P0-1: error-phase navigation is authority-derived — a paired
//    device can never be shown an unpaired/pairing surface.
// ---------------------------------------------------------------------------
test("back() after revoke failure stays paired (never shows unpaired while paired)", async () => {
  const { controller } = makeController({ paired: true, wsState: "connected", revokeResult: "fail" });
  await controller.refresh();
  assert.equal(controller.snapshot().phase, "connected");
  await controller.forget();
  assert.equal(controller.snapshot().phase, "error");
  await controller.back(); // must refresh → derived phase, still paired
  assert.equal(controller.snapshot().phase, "connected", "paired device never sees an unpaired surface");
  assert.equal(controller.snapshot().error, undefined, "stale error cleared by the authority read");
});

test("retry after revoke failure re-runs the revoke operation", async () => {
  const { controller, calls } = makeController({ paired: true, wsState: "connected", revokeResult: "fail" });
  await controller.refresh();
  await controller.forget();
  assert.equal(controller.snapshot().error?.code, "revoke_failed");
  // Retry re-runs the failed operation (fake still fails → still revoke_failed).
  await controller.retry();
  assert.equal(calls.revoke, 2, "retry re-ran connRevoke");
  assert.equal(controller.snapshot().error?.code, "revoke_failed");
});

// ---------------------------------------------------------------------------
// 10) Review P1-2: reconnect failure names its own operation.
// ---------------------------------------------------------------------------
test("reconnect failure is typed as reconnect_failed with truthful copy", async () => {
  const { controller } = makeController({ paired: true, wsState: "stopped", wsStartResult: "fail" });
  await controller.refresh();
  assert.equal(controller.snapshot().phase, "paired_idle");
  await controller.reconnect();
  const snap = controller.snapshot();
  assert.equal(snap.error?.code, "reconnect_failed", "reconnect names its own operation");
  const copy = shellErrorCopy(snap.error!);
  assert.ok(copy.includes("重新连接失败"), "copy matches the operation");
  assert.ok(!copy.includes("断开连接失败"), "copy must not name disconnect");
  // back() stays paired (authority-derived).
  await controller.back();
  assert.equal(controller.snapshot().phase, "paired_idle");
});

// ---------------------------------------------------------------------------
// 11) Review P1-3: cancelling / leaving an active scan releases the camera.
// ---------------------------------------------------------------------------
test("cancel during an active scan releases the native scanner", async () => {
  let release: (() => void) | null = null;
  const held = fakePorts({ paired: false, wsState: "stopped", pairResult: "ok" });
  held.ports.qrScan = async () => {
    await new Promise<void>((r) => { release = r; });
    return { ok: false as const, reason: "timeout" as const };
  };
  const controller = createConnectionShellController(held.ports, { revokedHoldMs: 10 });
  await controller.refresh();
  const scanning = controller.openScan(); // qrScan held open
  await new Promise((r) => setTimeout(r, 5));
  controller.cancel();
  assert.ok(held.calls.qrCancel >= 1, "qrCancel invoked on cancel");
  assert.equal(controller.snapshot().phase, "unpaired");
  release?.();
  await scanning;
});

test("cancelIfScanning (screen unmount) releases the scanner too", async () => {
  let release: (() => void) | null = null;
  const held = fakePorts({ paired: false, wsState: "stopped", pairResult: "ok" });
  held.ports.qrScan = async () => {
    await new Promise<void>((r) => { release = r; });
    return { ok: false as const, reason: "timeout" as const };
  };
  const controller = createConnectionShellController(held.ports, { revokedHoldMs: 10 });
  await controller.refresh();
  const scanning = controller.openScan();
  await new Promise((r) => setTimeout(r, 5));
  controller.cancelIfScanning();
  assert.ok(held.calls.qrCancel >= 1, "qrCancel invoked on unmount cleanup");
  release?.();
  await scanning;
});

// ---------------------------------------------------------------------------
// 12) Review P2-6: a connState read failure is its own typed code.
// ---------------------------------------------------------------------------
test("connState read failure surfaces state_unavailable, not pair_failed", async () => {
  const { controller } = makeController({ paired: true, wsState: "connected", connStateFails: true });
  await controller.refresh();
  const snap = controller.snapshot();
  assert.equal(snap.phase, "error");
  assert.equal(snap.error?.code, "state_unavailable");
  const copy = shellErrorCopy(snap.error!);
  assert.ok(copy.includes("无法读取连接状态"), "copy names the read failure");
  assert.ok(!copy.includes("配对失败"), "copy must not name pairing");
  // Retry re-reads the authority; the fake still fails, so the typed error
  // persists truthfully (never a silent recovery).
  await controller.retry();
  assert.equal(controller.snapshot().phase, "error");
  assert.equal(controller.snapshot().error?.code, "state_unavailable");
});

// ---------------------------------------------------------------------------
// 13) Review NEW-1: stale scan continuation after cancel must not write state.
// ---------------------------------------------------------------------------
test("stale scan continuation after cancel emits no error and preserves later state", async () => {
  let release: (() => void) | null = null;
  const held = fakePorts({ paired: false, wsState: "stopped", pairResult: "ok" });
  held.ports.qrScan = async () => {
    await new Promise<void>((r) => { release = r; });
    return { ok: false as const, reason: "timeout" as const };
  };
  const controller = createConnectionShellController(held.ports, { revokedHoldMs: 10 });
  await controller.refresh();
  const scanning = controller.openScan(); // held open
  await new Promise((r) => setTimeout(r, 5));
  controller.cancel(); // user cancels: clean unpaired, generation bumped
  assert.equal(controller.snapshot().phase, "unpaired");
  assert.equal(controller.snapshot().error, undefined, "no error right after cancel");
  // User opens the paste form…
  controller.openPaste();
  assert.equal(controller.snapshot().mode, "paste");
  // …then the stale scan continuation resolves (native timeout up to 30s).
  release?.();
  await scanning;
  // The stale continuation must NOT clobber the user's paste mode or emit a
  // ghost scan_failed.
  assert.equal(controller.snapshot().mode, "paste", "paste mode preserved");
  assert.equal(controller.snapshot().error, undefined, "no ghost scan_failed");
  assert.equal(controller.snapshot().phase, "scanning_or_paste");
});

// ---------------------------------------------------------------------------
// Phase-B R1 (P1-3): after local forget, NO authenticated channel survives —
// the mirrored authority proves wsState is stopped and pairing is cleared.
// ---------------------------------------------------------------------------
test("forget retires the WSS session with the credential (no channel survives)", async () => {
  const { controller, calls } = makeController({ paired: true, wsState: "connected", revokeResult: "ok" });
  await controller.refresh();
  assert.equal(controller.snapshot().phase, "connected");
  await controller.forget();
  await new Promise((r) => setTimeout(r, 30));
  await controller.refresh();
  const snap = controller.snapshot();
  assert.equal(snap.phase, "unpaired");
  assert.equal(snap.identity, undefined, "identity cleared");
  assert.equal(snap.ws.state, "stopped", "no authenticated channel survives");
  assert.equal(calls.revoke, 1, "exactly one conn_revoke (it retires WSS internally)");
});

// ---------------------------------------------------------------------------
// Phase-B R1 (P1-1): the shell layer can never invoke a sync/business route —
// its ports carry no such capability (type-level containment, source-checked).
// ---------------------------------------------------------------------------
test("shell ports carry no business-route capability (route containment)", () => {
  const shell = readFileSync(join(ROOT, "src", "services", "connectionShell.ts"), "utf-8");
  const page = readFileSync(join(ROOT, "src", "screens", "ConnectComputer.tsx"), "utf-8");
  for (const [name, src] of [["connectionShell.ts", shell], ["ConnectComputer.tsx", page]] as const) {
    for (const banned of ["syncRun", "sync_changes", "assets", "notes(", "capture", "agent"]) {
      assert.ok(!src.includes(banned), `${name} must not reference business route ${banned}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 12) Reconnect-stuck R1: bounded waits, typed timeout feedback, stale-attempt
//     guards, manual-retry cleanup. The phone occasionally wedged on
//     “重新连接” — a dial with no deadline, a ws_start that returned
//     AlreadyRunning onto a wedged loop, and late completions overwriting
//     newer state. These contracts pin the fixed behavior.
// ---------------------------------------------------------------------------

/** Bespoke ports for wedged/deferred device operations — the stateful fake
 *  above cannot express a ws_start that never settles or settles late. */
function reconnectProbePorts(spec: { mode: "wedged-first" | "deferred"; wsState?: string }) {
  const state = { paired: true, wsState: spec.wsState ?? "stopped" };
  const calls = { wsStart: 0, wsStop: 0, revoke: 0 };
  let settleRes: ((v: unknown) => void) | null = null;
  let settleRej: ((e?: unknown) => void) | null = null;
  const ports = {
    connState: async () => ({
      paired: state.paired,
      identity: state.paired
        ? {
            instanceId: "fake-instance-000",
            displayName: "FAKE-DESK",
            platform: "windows",
            appVersion: "0.0.0",
            protocolVersion: 1,
            certificateFingerprint: FAKE_FP,
            baseUrl: "https://192.0.2.1:48180",
          }
        : null,
      stats: null,
      ws: { state: state.wsState, last_seq: 0, current: state.wsState },
    }),
    connPair: async () => ({}),
    connRevoke: async () => {
      calls.revoke += 1;
      state.paired = false;
      state.wsState = "stopped";
      return "ok";
    },
    wsStart: () => {
      calls.wsStart += 1;
      if (spec.mode === "deferred") {
        return new Promise<unknown>((r, j) => {
          settleRes = r;
          settleRej = j;
        });
      }
      if (calls.wsStart === 1) return new Promise<never>(() => {}); // wedged first attempt
      state.wsState = "connected";
      return Promise.resolve({ status: "started", preferenceSaved: true });
    },
    wsStop: async () => {
      calls.wsStop += 1;
      state.wsState = "stopped";
      return { status: "stopped", preferenceSaved: true };
    },
    qrScan: async () => ({ ok: false as const, reason: "timeout" as const }),
    qrCancel: async () => {},
  };
  return {
    ports,
    calls,
    settle: {
      ok: (v: unknown) => settleRes?.(v),
      fail: (e?: unknown) => settleRej?.(e),
    },
  };
}

test("a wedged ws_start surfaces typed reconnect_timeout and never touches pairing", async () => {
  const probe = reconnectProbePorts({ mode: "wedged-first" });
  const controller = createConnectionShellController(probe.ports, { revokedHoldMs: 10, opTimeoutMs: 15 });
  await controller.refresh();
  await controller.reconnect();
  const snap = controller.snapshot();
  assert.equal(snap.phase, "error", "the bounded wait fails visibly instead of spinning forever");
  assert.equal(snap.error?.code, "reconnect_timeout", "a timed-out wait is its own typed code");
  assert.equal(snap.error?.retryable, true);
  // IPC timeout copy names the phone's own hung command — it must NOT claim
  // anything about the desktop's network state (dial failures surface
  // separately through ws last_failure / wsFailureCopy).
  const timeoutCopy = shellErrorCopy(snap.error!);
  assert.ok(timeoutCopy.includes("没有返回结果"), "copy names the hung command");
  assert.ok(!timeoutCopy.includes("同一局域网"), "IPC timeout must not pose as a network verdict");
  assert.equal(probe.calls.revoke, 0, "a transport timeout never revokes the credential");
  assert.notEqual(snap.phase, "unpaired");
  assert.notEqual(snap.phase, "re_pair_required");
});

test("retry after reconnect_timeout re-runs the reconnect cleanly", async () => {
  const probe = reconnectProbePorts({ mode: "wedged-first" });
  const controller = createConnectionShellController(probe.ports, { revokedHoldMs: 10, opTimeoutMs: 15 });
  await controller.refresh();
  await controller.reconnect();
  assert.equal(controller.snapshot().error?.code, "reconnect_timeout");
  await controller.retry();
  assert.equal(probe.calls.wsStart, 2, "the retry dials fresh");
  const snap = controller.snapshot();
  assert.notEqual(snap.phase, "error", "the fresh attempt succeeds and clears the error");
  assert.equal(snap.ws.state, "connected", "the authority read reflects the fresh start");
});

test("a late-settling reconnect attempt never overwrites newer state", async () => {
  const probe = reconnectProbePorts({ mode: "deferred" });
  const controller = createConnectionShellController(probe.ports, { revokedHoldMs: 10, opTimeoutMs: 5000 });
  await controller.refresh();
  const pending = controller.reconnect();
  await controller.back(); // the user navigates away while the attempt is pending
  assert.equal(controller.snapshot().phase, "paired_idle", "the newer authority state stands");
  probe.settle.fail(new Error("lan unreachable")); // the stale attempt fails late
  await pending;
  const snap = controller.snapshot();
  assert.equal(snap.phase, "paired_idle", "a stale failure cannot resurrect an error surface");
  assert.ok(!snap.error, "a stale task never writes over the newer state");
});

test("ws_start retires the previous worker before dialing (manual reconnect cleanup)", () => {
  // Cross-language source contract, house style: the Rust command that the
  // reconnect button calls must stop any previous eventstream worker BEFORE
  // starting a fresh one — es.start alone would return AlreadyRunning and
  // leave a wedged retry loop un-interruptible by the user.
  const src = readFileSync(join(ROOT, "src-tauri", "src", "lib.rs"), "utf-8");
  const at = src.indexOf("async fn ws_start(");
  assert.ok(at > 0, "ws_start exists");
  const body = src.slice(at, src.indexOf("#[tauri::command]", at + 10));
  const stopAt = body.indexOf("es.stop().await;");
  const startAt = body.indexOf("es.start(");
  assert.ok(stopAt > 0 && startAt > stopAt, "ws_start stops the previous eventstream worker before es.start");
});

test("the reconnect button stays reachable while the shell reports reconnecting", () => {
  // The stuck-UX trap: the button used to appear only in paired_idle, so a
  // wedged 重新连接 loop left 断开连接 (which vetoes auto-resume) as the only
  // escape. The button must also be offered during the reconnecting phase.
  const src = readFileSync(join(ROOT, "src", "still", "StillConnect.tsx"), "utf-8");
  const at = src.indexOf(">重新连接<");
  assert.ok(at > 0, "the reconnect button exists");
  const gate = src.slice(Math.max(0, at - 500), at);
  assert.ok(gate.includes('"reconnecting"'), "the button is offered during the reconnecting phase too");
});

// ---------------------------------------------------------------------------
// 13) Reconnect-stuck R2: stale SUCCESS callbacks, out-of-order reads, and
//     typed dial-failure copy. All driven with deferred promises (controllable
//     timing), not source-string scans.
// ---------------------------------------------------------------------------

function createDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: (v: T) => resolve(v), reject: (e: unknown) => reject(e) };
}

function deferredProbePorts() {
  const calls = { pair: 0, revoke: 0, wsStart: 0, wsStop: 0, connState: 0 };
  const state = { paired: true, wsState: "stopped", failure: null as string | null };
  const defers = {
    pair: createDeferred<{ ok: boolean }>(),
    revoke: createDeferred<"ok" | "fail">(),
  };
  const identity = {
    instanceId: "fake-instance-000",
    displayName: "FAKE-DESK",
    platform: "windows",
    appVersion: "0.0.0",
    protocolVersion: 1,
    certificateFingerprint: FAKE_FP,
    baseUrl: "https://192.0.2.1:48180",
  };
  const ports = {
    connState: async () => {
      calls.connState += 1;
      return {
        paired: state.paired,
        identity: state.paired ? identity : null,
        stats: null,
        ws: { state: state.wsState, last_seq: 0, current: state.wsState, last_failure: state.failure },
      };
    },
    connPair: async () => {
      calls.pair += 1;
      const r = await defers.pair.promise;
      if (r.ok) state.paired = true;
      return {};
    },
    connRevoke: async () => {
      calls.revoke += 1;
      const r = await defers.revoke.promise;
      if (r === "ok") {
        state.paired = false;
        state.wsState = "stopped";
      }
      return "ok";
    },
    wsStart: async () => {
      calls.wsStart += 1;
      state.wsState = "connected";
      return { status: "started", preferenceSaved: true };
    },
    wsStop: async () => {
      calls.wsStop += 1;
      state.wsState = "stopped";
      return { status: "stopped", preferenceSaved: true };
    },
    qrScan: async () => ({ ok: false as const, reason: "timeout" as const }),
    qrCancel: async () => {},
  };
  return { ports, calls, defers, state, identity };
}

test("a stale pairing SUCCESS never starts the worker or writes over newer state", async () => {
  const probe = deferredProbePorts();
  const controller = createConnectionShellController(probe.ports, { revokedHoldMs: 10, opTimeoutMs: 1000 });
  await controller.refresh();
  const pairing = controller.submitPaste(FAKE_PAYLOAD); // connPair held pending
  await controller.back(); // the user navigates away mid-pair (newer transition)
  assert.notEqual(controller.snapshot().phase, "pairing");
  probe.defers.pair.resolve({ ok: true }); // the stale pair succeeds LATE at the authority
  await pairing;
  assert.equal(probe.calls.wsStart, 0, "a stale pair success must not start the realtime worker");
  const snap = controller.snapshot();
  assert.notEqual(snap.phase, "pairing", "a stale pair success cannot re-enter pairing");
  assert.ok(!snap.error, "a stale pair success writes no error");
});

test("a stale forget SUCCESS cannot flash the revoked surface over newer state", async () => {
  const probe = deferredProbePorts();
  const controller = createConnectionShellController(probe.ports, { revokedHoldMs: 10_000, opTimeoutMs: 1000 });
  await controller.refresh();
  const forgetting = controller.forget(); // connRevoke held pending
  await controller.back(); // newer transition mid-forget
  probe.defers.revoke.resolve("ok"); // revoke succeeds LATE at the authority
  await forgetting;
  const snap = controller.snapshot();
  assert.notEqual(snap.phase, "revoked", "a stale forget success cannot force the revoked hold");
  assert.equal(probe.calls.revoke, 1, "the revoke itself did run at the authority");
});

test("out-of-order authority reads: only the newest read may write", async () => {
  const probe = deferredProbePorts();
  const reads: Array<(v: string) => void> = [];
  let readCount = 0;
  const origConnState = probe.ports.connState;
  probe.ports.connState = async () => {
    readCount += 1;
    const my = readCount;
    if (my <= 2) {
      await new Promise<void>((r) => {
        reads.push((v: string) => {
          probe.state.wsState = v;
          r();
        });
      });
    }
    return origConnState();
  };
  const controller = createConnectionShellController(probe.ports, { revokedHoldMs: 10, opTimeoutMs: 1000 });
  const r1 = controller.refresh(); // older read
  const r2 = controller.refresh(); // newer read
  reads[1]("connected"); // newer resolves first
  await r2;
  reads[0]("stopped"); // older resolves LAST with stale truth
  await r1;
  assert.equal(
    controller.snapshot().ws.state,
    "connected",
    "the stale older read is discarded; the newest truth stands"
  );
});

test("wsFailureCopy names network, TLS identity and generic retry precisely", () => {
  assert.ok(wsFailureCopy("network").includes("同一局域网"), "network names the LAN reachability step");
  assert.ok(wsFailureCopy("tls").includes("证书"), "tls names certificate verification");
  assert.ok(wsFailureCopy("tls").includes("不会跳过校验"), "tls copy keeps pinning non-negotiable");
  assert.ok(!wsFailureCopy("tls").includes("重新配对"), "tls failure must not demand re-pairing");
  assert.ok(wsFailureCopy("protocol").includes("自动重试"), "unknown kinds fall back to honest retry copy");
  assert.ok(wsFailureCopy(null).includes("自动重试"), "no failure class is honest about retrying");
});

test("a reconnecting worker projects its typed dial-failure class through the snapshot", async () => {
  const probe = deferredProbePorts();
  probe.state.wsState = "reconnecting";
  probe.state.failure = "network";
  const controller = createConnectionShellController(probe.ports, { revokedHoldMs: 10, opTimeoutMs: 1000 });
  await controller.refresh();
  const snap = controller.snapshot();
  assert.equal(snap.phase, "reconnecting");
  assert.equal(snap.ws.last_failure, "network", "the dial-failure class reaches the UI snapshot");
  assert.ok(wsFailureCopy(snap.ws.last_failure).includes("同一局域网"));
});
