import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), fixtureBrowserStub()],
  build: { target: "chrome83" },

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
