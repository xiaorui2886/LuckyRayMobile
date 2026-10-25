import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error The existing config TS project omits Node types; Vite runs it in Node.
import { createRequire } from "node:module";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// SERVICES-INTEGRATION-R2: the canonical fixture harness is Node-only
// (`node:crypto`, `node:fs`) and is never used by the app. The acceptance-only
// driver imports the production barrel (`createProductionServices`), which
// statically re-exports the fixture transport, so a browser build that includes
// the barrel needs this exact module to resolve to a browser-safe stub. The
// vendored file itself is frozen and never touched; nothing in the product
// graph imports it, so normal builds are unaffected either way.
const fixtureBrowserStub = (): Plugin => ({
  name: "fixture-browser-stub",
  enforce: "pre",
  resolveId(id) {
    return id.includes("companion-services-v1/fixture.mjs")
      ? "\0fixture-browser-stub"
      : null;
  },
  load(id) {
    if (id !== "\0fixture-browser-stub") return null;
    return (
      "export function createFixture() { " +
      "throw new Error('canonical fixture is Node-only and cannot run in a browser build'); }"
    );
  },
});

// Resolve through a declared direct dependency so pnpm's transitive package
// layout is respected, without a private store path or a dependency upgrade.
const markdownRequire = createRequire(createRequire(import.meta.url).resolve("micromark-util-decode-string"));
const safeDecoderEntry: string = markdownRequire.resolve("decode-named-character-reference");
const markdownSafeEntities = (): Plugin => ({
  name: "markdown-worker-safe-entities",
  enforce: "pre",
  async resolveId(source, importer) {
    if (source !== "decode-named-character-reference" || !importer) return null;
    const resolved = await this.resolve(source, importer, { skipSelf: true });
    return resolved ? { ...resolved, id: resolved.id.replace(/\/index\.dom\.js$/, "/index.js") } : null;
  },
});

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [react(), fixtureBrowserStub()],
  // Dev workers share the page's optimizer. An alias participates in both
  // prebundling and worker imports, unlike worker.plugins (build only).
  resolve: command === "serve" ? { alias: { "decode-named-character-reference": safeDecoderEntry } } : undefined,
  build: { target: "chrome83" },
  // Markdown's named-entity decoder has a DOM-only `browser` export. Workers
  // have no document: resolve its official `worker` export instead. This is
  // a worker-only dependency resolution, not a fake DOM or a handwritten decoder.
  worker: {
    format: "iife" as const,
    plugins: (): Plugin[] => [markdownSafeEntities()],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
