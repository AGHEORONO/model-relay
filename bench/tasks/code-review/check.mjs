import { readFileSync } from 'node:fs';
import path from 'node:path';
const ws = process.argv[2];
let r;
try { r = readFileSync(path.join(ws, 'REVIEW.md'), 'utf8'); } catch { console.log('FAIL REVIEW.md missing'); process.exit(1); }
const issues = {
  'SQL injection': /injection|parameteri[sz]|placeholder|prepared/i,
  'pagination offset off by one': /off[- ]by[- ]one|\(page\s*-\s*1\)|page - 1|skips the first page|first page/i,
  'float money': /float|floating|rounding|cents|integer|decimal/i,
  'unawaited sendReceipt': /await|unhandled|promise|fire[- ]and[- ]forget/i,
  'no ownership check on cancel': /authori[sz]|ownership|owner|any user|permission|belongs/i,
  'missing order (null) on cancel': /null|undefined|not found|missing order|does not exist/i,
};
const hit = Object.entries(issues).filter(([, re]) => re.test(r)).map(([k]) => k);
const ok = hit.length >= 5;
console.log(`${ok ? 'PASS' : 'FAIL'} found ${hit.length}/6: ${hit.join('; ')}`);
process.exit(ok ? 0 : 1);
