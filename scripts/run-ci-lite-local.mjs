// Run the same explicit, offline-safe frontend checks as public CI.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = readFileSync(join(appRoot, ".github", "workflows", "ci-lite.yml"), "utf8");

// Parse the exact test list out of the workflow so this can never drift from CI.
const runBlock = workflow.slice(workflow.indexOf("node --experimental-strip-types --test"));
const files = [...runBlock.matchAll(/^\s{10}(tests\/[^\s]+\.(?:ts|mjs))/gmu)].map((m) => m[1]);
if (files.length === 0) throw new Error("could not parse the CI test list");
console.log(`CI Lite file list: ${files.length} files`);

console.log("\n== 1. TypeScript typecheck ==");
execFileSync("node", ["node_modules/typescript/bin/tsc", "--noEmit"], { cwd: appRoot, stdio: "inherit" });
console.log("tsc: OK");

console.log("\n== 2. Contract tests ==");
execFileSync(process.execPath, ["--experimental-strip-types", "--test", ...files], {
  cwd: appRoot, stdio: "inherit",
});
console.log("\nCI Lite equivalent: PASS");


// DOM checks need an existing pinned jsdom test-tools installation; they are
// not part of the public workflow and this script never installs packages.
if (process.argv.includes("--with-managed-dom")) {
  execFileSync(process.execPath, ["scripts/check-managed-dom.mjs"], { cwd: appRoot, stdio: "inherit" });
} else {
  console.log("Managed React DOM suites NOT_RUN. Run with --with-managed-dom and LR_DOM_TEST_TOOLS pointing to a pinned jsdom 26.1.0 node_modules directory.");
}
