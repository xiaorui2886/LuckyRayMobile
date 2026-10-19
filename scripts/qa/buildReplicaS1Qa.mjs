import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const outDir = resolve(process.argv[2]);
mkdirSync(outDir, {recursive: true});
// Same unchanged production main-entry reset/tokens for BOTH saved a5 and S1.
writeFileSync(resolve(outDir, "..", "production-base.css"), readFileSync("src/design/tokens.css", "utf8") + "\n" + readFileSync("src/app.css", "utf8"));
const output = await build({configFile: false, logLevel: "warn", plugins: [react(), {name: "qa-node-only", enforce: "pre", resolveId(id) {return id.includes("companion-services-v1/fixture.mjs") ? "\0qa-fixture-stub" : null;}, load(id) {return id === "\0qa-fixture-stub" ? "export function createFixture(){throw new Error('Node-only fixture')}" : null;}}], define: {"process.env.NODE_ENV": JSON.stringify("production")}, build: {write: false, minify: false, lib: {entry: "scripts/qa/replicaS1.entry.tsx", formats: ["iife"], name: "ReplicaS1Qa"}}});
for (const item of output[0].output) writeFileSync(resolve(outDir, item.type === "chunk" ? "bundle.js" : item.fileName), item.type === "chunk" ? item.code : item.source);
console.log(JSON.stringify({outDir, productionTree: "StillApp → StillKnowledge → CollectionView/NoteSurface", syntheticIpcOnly: true}));
