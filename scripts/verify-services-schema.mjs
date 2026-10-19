// Consumer layout adapter only: execute the byte-sealed verifier unchanged in
// its canonical sibling layout, referencing the existing frozen Content schema.
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const stage = mkdtempSync(join(tmpdir(), 'm92-services-schema-'));
cpSync(join(root, 'shared/companion-services-v1'), join(stage, 'services-v1'), { recursive: true });
cpSync(join(root, 'shared/companion-content-v1'), join(stage, 'content-v1'), { recursive: true });
const result = spawnSync(process.argv[2] ?? 'python', [join(stage, 'services-v1/verify-schema.py')], { stdio: 'inherit' });
if (result.error) throw result.error;
console.log(`Unmodified schema verifier staging: ${stage}`);
process.exitCode = result.status ?? 1;
