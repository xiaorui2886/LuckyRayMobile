// MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R5 — VISUAL QA build only (never shipped).
// Bundles the QA-only entry (real product CollectionView + still.css) into a
// single IIFE the puppeteer shooter can inject at 360/392.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";

const out = await build({
  configFile: false,
  logLevel: "warn",
  plugins: [react()],
  // The QA bundle is injected as a raw <script> in a plain page, so the React
  // runtime's `process.env.NODE_ENV` reference must be substituted at build
  // time — without the app's config file nothing defines it.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    minify: false,
    lib: {
      entry: "scripts/qa/materialLibraryInstantVisual.entry.tsx",
      formats: ["iife"],
      name: "QaApp",
      fileName: () => "qa.js",
    },
  },
});
const chunks = Array.isArray(out) ? out[0].output : out.output;
const js = chunks.find((c) => c.fileName.endsWith(".js")).code;
writeFileSync("test-evidence/qa-bundle.js", js);
console.log("qa bundle bytes:", js.length);
