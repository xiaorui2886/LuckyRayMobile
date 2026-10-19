// Opt-in raw command logger for this bounded #99 source repair; no retries,
// signing, APK work, Desktop host, or device operation.
import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const [destination, command, ...args] = process.argv.slice(2);
if (!destination || !command) throw Error("usage: node runQa99Check.mjs log-path command ...args");
const path = resolve(destination);
mkdirSync(dirname(path), { recursive: true });
const stream = createWriteStream(path, { flags: "wx" });
const startedAt = new Date().toISOString();
const child = spawn(command, args, { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", chunk => { stream.write(chunk); process.stdout.write(chunk); });
child.stderr.on("data", chunk => { stream.write(chunk); process.stderr.write(chunk); });
child.on("error", error => { stream.write(String(error)); });
child.on("close", (code, signal) => {
  stream.end();
  writeFileSync(path + ".json", JSON.stringify({ command, args, cwd: process.cwd(), startedAt,
    finishedAt: new Date().toISOString(), exitCode: code, signal }, null, 2));
  process.exitCode = code ?? 1;
});
