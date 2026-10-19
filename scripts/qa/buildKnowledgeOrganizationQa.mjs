// KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.1 — VISUAL QA build only (never
// shipped). Bundles the QA-only ORG composition (directory mode, move
// sheets, selection bar, partial outcomes) into a single IIFE the puppeteer
// shooter can inject at 360/392.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";

// The vendored fixture.mjs is Node-only (the canonical golden harness). The
// app's vite config maps it to a throwing browser stub; this standalone QA
// build needs the same plugin or rollup tries to bundle the Node module.
function nodeOnlyStub() {
  const MARK = " org-qa-fixture-stub";
  return {
    name: "org-qa-node-only-stub",
    resolveId(id) {
      return id.includes("companion-services-v1/fixture.mjs") ? MARK : null;
    },
    load(id) {
      if (id !== MARK) return null;
      // Same shape as the app's stub: keep the named export the index re-exports.
      return "export function createFixture() { throw new Error('canonical fixture is Node-only'); }";
    },
  };
}

const out = await build({
  configFile: false,
  logLevel: "warn",
  plugins: [react(), nodeOnlyStub()],
  // The QA bundle is injected as a raw <script> in a plain page, so React's
  // `process.env.NODE_ENV` reference must be substituted at build time.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    minify: false,
    lib: {
      entry: "scripts/qa/knowledgeOrganizationQa.entry.tsx",
      formats: ["iife"],
      name: "QaOrg",
      fileName: () => "qa-org.js",
    },
  },
});

const js = out[0].output[0].code;
writeFileSync(new URL("./qa-org-bundle.js", import.meta.url), js);
console.log(`wrote scripts/qa/qa-org-bundle.js (${Math.round(js.length / 1024)} kB)`);
