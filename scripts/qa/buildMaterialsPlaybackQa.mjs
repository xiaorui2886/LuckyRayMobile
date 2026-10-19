// Production page bundle. Only the native IPC boundary is synthetic.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const outDir = resolve(process.argv[2] || "output/playwright/mobile-materials-r1/production");
const mode = process.argv[3] || "trial";
if (mode !== "trial" && mode !== "normal") throw new Error("Expected trial or normal QA build mode");
mkdirSync(outDir, {recursive: true});
writeFileSync(resolve(outDir, "..", "production-base.css"), readFileSync("src/design/tokens.css", "utf8") + "\n" + readFileSync("src/app.css", "utf8"));
const output = await build({configFile: false, logLevel: "warn", plugins: [react(), {
  name: "qa-node-only", enforce: "pre",
  resolveId(id) { return id.includes("companion-services-v1/fixture.mjs") ? "\0qa-fixture-stub" : null; },
  load(id) { return id === "\0qa-fixture-stub" ? "export function createFixture(){throw new Error('Node-only fixture')}" : null; },
}], define: {"process.env.NODE_ENV": JSON.stringify("production"), "import.meta.env.VITE_MATERIALS_NATIVE_PLAYER": JSON.stringify(mode === "trial" ? "trial" : "")}, build: {write: false, minify: false, lib: {entry: "scripts/qa/materialsPlayback.entry.tsx", formats: ["iife"], name: "MaterialsPlaybackQa"}}});
for (const item of output[0].output) writeFileSync(resolve(outDir, item.type === "chunk" ? "bundle.js" : item.fileName), item.type === "chunk" ? item.code : item.source);
console.log(JSON.stringify({outDir, mode, productionTree: "StillApp → StillLibrary → StillAsset", syntheticNativeBoundaryOnly: true}));
