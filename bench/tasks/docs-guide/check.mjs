import { readFileSync } from 'node:fs';
import path from 'node:path';
const ws = process.argv[2];
let doc;
try { doc = readFileSync(path.join(ws, 'docs/GUIDE.md'), 'utf8'); } catch { console.log('FAIL docs/GUIDE.md missing'); process.exit(1); }
const words = doc.split(/\s+/).filter(Boolean).length;
const must = ['jot add', 'jot list', 'jot search', 'jot rm', 'jot tag', 'jot export', '.jotrc', 'JOT_FILE', 'NO_COLOR', 'dateFormat', 'pageSize', 'csv', 'not valid JSON', '500'];
const missing = must.filter((m) => !doc.includes(m));
const ok = words >= 600 && missing.length <= 1;
console.log(`${ok ? 'PASS' : 'FAIL'} ${words} words, missing: ${missing.join(', ') || 'none'}`);
process.exit(ok ? 0 : 1);
