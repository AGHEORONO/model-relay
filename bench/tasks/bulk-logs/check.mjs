import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ws = process.argv[2];
const expected = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'expected.json'), 'utf8'));
let report;
try { report = readFileSync(path.join(ws, 'report.md'), 'utf8'); } catch { console.log('FAIL report.md missing'); process.exit(1); }
const rows = report.split('\n').filter((l) => l.trim().startsWith('|'));
let found = 0, right = 0;
for (const [file, kw] of expected) {
  const stem = file.replace(/\.log$/, '');
  const row = rows.find((r) => r.includes(stem));
  if (!row) continue;
  found++;
  if (new RegExp(kw, 'i').test(row)) right++;
}
const ok = found === expected.length && right >= expected.length - 1;
console.log(`${ok ? 'PASS' : 'FAIL'} rows ${found}/${expected.length}, correct root causes ${right}/${expected.length}`);
process.exit(ok ? 0 : 1);
