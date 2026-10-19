// CM6-EDITOR-R1 — VISUAL QA build only (never shipped).
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";

const out = await build({
  configFile: false,
  logLevel: "warn",
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    minify: false,
    lib: {
      entry: "scripts/qa/cm6EditorQa.entry.tsx",
      formats: ["iife"],
      name: "QaCm6",
      fileName: () => "qa-cm6.js",
    },
  },
});

const js = out[0].output.find(item => item.type === "chunk").code;
const css = out[0].output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.source).join("\n");
if (!css) throw new Error("Production stylesheet bundle missing");
writeFileSync(new URL("./qa-cm6-bundle.js", import.meta.url), js);
writeFileSync(new URL("./qa-cm6-bundle.css", import.meta.url), css);
console.log(`wrote QA JS (${Math.round(js.length / 1024)} kB) and production CSS (${Math.round(css.length / 1024)} kB)`);
