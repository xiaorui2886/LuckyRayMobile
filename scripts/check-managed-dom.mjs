// Optional local-only managed note UI validation. Never downloads test tools.
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const location = process.env.LR_DOM_TEST_TOOLS;
if (!location) throw Error("DOM checks require LR_DOM_TEST_TOOLS pointing to an existing jsdom 26.1.0 node_modules directory. No DOM checks ran.");
const require = createRequire(join(resolve(location), "managed-check.cjs"));
if (require("jsdom/package.json").version !== "26.1.0") throw Error("DOM checks require pinned jsdom 26.1.0. No DOM checks ran.");
execFileSync(process.execPath, ["--test", "tests/managedNoteEditor.dom.test.mjs", "tests/managedImportBridge.dom.test.mjs", "tests/unifiedNotesView.dom.test.mjs", "tests/unifiedVaultIntegration.dom.test.mjs"], {
  cwd: root, stdio: "inherit", env: {...process.env, LR_TEST_TOOLS: resolve(location, "..")},
});
