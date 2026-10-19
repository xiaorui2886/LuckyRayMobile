// Compare actual production-page captures, not a recreated visual mock.
import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
const root = resolve(process.argv[2]);
const baseline = resolve(root, "baseline-images-final"), candidate = resolve(root, "candidate-images-final");
const read = dir => JSON.parse(readFileSync(resolve(dir, "render-report.json"), "utf8"));
const original = read(baseline), current = read(candidate);
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
// Public runs require an explicit completed baseline, never a private receipt.
assert.equal(original.result, "PASS", "Baseline capture must explicitly report PASS");
assert.equal(current.result, "PASS");
assert.equal(original.errors.length, 0); assert.equal(current.errors.length, 0);
const fields = ["width", "overflow", "source", "rows", "count", "dock", "bodyMargin"];
const comparisons = original.cases.map(b => {
  const c = current.cases.find(c => c.name === b.name);
  assert.ok(c, `missing original-page counterpart: ${b.name}`);
  for (const field of fields) assert.deepEqual(c[field], b[field], `${b.name}: ${field}`);
  const baselineSha256 = hash(resolve(baseline, b.name + ".png")), candidateSha256 = hash(resolve(candidate, b.name + ".png"));
  return {name: b.name, metrics: "PASS", pixelIdentical: baselineSha256 === candidateSha256, baselineSha256, candidateSha256};
});
const result = {kind: "actual-browser-capture-baseline-a5-vs-S1-same-synthetic-data", result: "PASS", comparisons,
  baselineCases: original.cases.length, candidateCases: current.cases.length, interactions: current.interactions,
  baselineBundleSha256: hash(resolve(root, "baseline/bundle.js")), candidateBundleSha256: hash(resolve(root, "candidate/bundle.js")),
  sharedProductionBaseCssSha256: hash(resolve(root, "production-base.css")), syntheticIpcOnly: true, deviceUat: "NOT_RUN"};
writeFileSync(resolve(root, "comparison.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({result: result.result, geometryComparisons: comparisons.length, pixelIdentical: comparisons.filter(x => x.pixelIdentical).length, candidateCases: current.cases.length, interactions: current.interactions}));
