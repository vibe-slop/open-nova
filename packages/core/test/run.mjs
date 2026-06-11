/**
 * Test runner: executes every *.test.mjs sequentially via tsx and aggregates
 * exit codes. (The suites are plain assertion scripts that exit non-zero on
 * failure, not node:test files.)
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

let failed = 0;
for (const f of files) {
  console.log(`\n━━ ${f} ━━`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed === 0 ? 0 : 1);
