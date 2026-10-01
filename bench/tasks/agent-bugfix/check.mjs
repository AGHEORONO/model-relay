import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ws = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
const changed = ['money.test.js', 'cart.test.js'].filter(
  (f) => readFileSync(path.join(ws, 'test', f), 'utf8').replace(/\r/g, '') !== readFileSync(path.join(here, 'fixture/test', f), 'utf8').replace(/\r/g, '')
);
let suite = 'pass';
try { execSync('node --test', { cwd: ws, stdio: 'pipe' }); } catch { suite = 'fail'; }
const ok = suite === 'pass' && !changed.length;
console.log(`${ok ? 'PASS' : 'FAIL'} suite ${suite}, tests modified: ${changed.join(', ') || 'none'}`);
process.exit(ok ? 0 : 1);
