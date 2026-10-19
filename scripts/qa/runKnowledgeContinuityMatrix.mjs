// Formal browser matrix over the uninstrumented production React/CM fixture.
// Build runs in its own child; no Vite/native bundler is loaded in this driver.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

if (!process.env.LUCKYRAY_QA_BROWSER || !existsSync(process.env.LUCKYRAY_QA_BROWSER)) throw new Error("Set LUCKYRAY_QA_BROWSER to the verified browser executable");
const parent = resolve(process.argv[2] || "output/playwright/knowledge-final-matrix");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(resolve(parent, "run-")), bundle = resolve(root, "production");
const journal = openSync(resolve(root, "stages.jsonl"), "a");
const report = { root, kind: "formal-browser-synthetic-IPC-not-Android-UAT", outcome: "RUNNING", suites: [] };
const stage = (name, details = {}) => { const line = JSON.stringify({ at: new Date().toISOString(), stage: name, ...details }) + "\n"; writeSync(journal, line); fsyncSync(journal); writeSync(1, line); };
function run(name, args, env, timeout) {
  stage(name + ":start");
  const child = spawnSync(process.execPath, args, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout, windowsHide: true });
  writeFileSync(resolve(root, name + ".log"), (child.stdout || "") + (child.stderr || "") + `\nstatus=${child.status} signal=${child.signal} error=${child.error ? String(child.error) : ""}\n`);
  const result = { exitCode: child.status, signal: child.signal, error: child.error ? String(child.error) : undefined };
  stage(name + ":end", result); return result;
}
try {
  report.build = run("build", ["scripts/qa/buildReplicaS1Qa.mjs", bundle], process.env, 120000);
  if (report.build.exitCode !== 0 || report.build.signal || report.build.error) throw new Error("Build failed; browser matrix NOT_RUN");
  report.assets = [];
  for (const path of ["production/bundle.js", "production/luckyray-mobile.css", "production-base.css"]) {
    stage("asset-read-hash:start", { path });
    const bytes = readFileSync(resolve(root, path));
    report.assets.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    stage("asset-read-hash:end", report.assets.at(-1));
  }
  for (const motion of ["on", "off"]) for (const suite of [
    { name: "K1-K7", script: "knowledgeContinuity.test.mjs", report: "report.json", cases: 7 },
    { name: "CM11", script: "cm6EditorLifecycle.test.mjs", report: "lifecycle-report.json", cases: 16 },
  ]) {
    const name = `reduced-${motion}-${suite.name}`, out = resolve(root, name);
    const result = run(name, ["--test", "scripts/qa/" + suite.script], { ...process.env,
      LUCKYRAY_QA_REDUCED: motion, LUCKYRAY_QA_TRACE: "0", LUCKYRAY_QA_BUNDLE: bundle, LUCKYRAY_QA_OUT: out }, 180000);
    const entry = { name, ...result }; report.suites.push(entry);
    try { entry.report = JSON.parse(readFileSync(resolve(out, suite.report), "utf8")); }
    catch (error) { entry.reportError = String(error); }
    const records = entry.report?.cases || [], expected = motion === "on";
    entry.verified = result.exitCode === 0 && !result.signal && !result.error && !entry.reportError
      && entry.report?.reducedMotion === expected && entry.report?.errors?.length === 0 && records.length === suite.cases
      && records.every(record => record.outcome === "PASS" && record.evidence?.mode?.appReduced === expected
        && record.evidence.mode.mediaReduced === expected && record.evidence.mode.traceEnabled === false && record.evidence.mode.coordinateProbeEnabled === false);
    writeFileSync(resolve(root, "matrix-report.json"), JSON.stringify(report, null, 2));
    if (!entry.verified) throw new Error(`${name} failed or lacks complete uninstrumented evidence; remaining suites NOT_RUN`);
  }
  report.outcome = "PASS";
} catch (error) { report.outcome = "FAIL"; report.error = String(error); stage("matrix-error", { error: report.error }); process.exitCode = 1; }
finally {
  writeFileSync(resolve(root, "matrix-report.json"), JSON.stringify(report, null, 2));
  stage("matrix-finished", { outcome: report.outcome, completedSuites: report.suites.length }); closeSync(journal);
}
console.log(JSON.stringify({ outcome: report.outcome, root, suites: report.suites.map(({ name, exitCode, verified }) => ({ name, exitCode, verified })), error: report.error }, null, 2));
