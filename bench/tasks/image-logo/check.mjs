import { readFileSync } from 'node:fs';
import path from 'node:path';
const ws = process.argv[2];
let b;
try { b = readFileSync(path.join(ws, 'assets/logo.png')); } catch { console.log('FAIL assets/logo.png missing'); process.exit(1); }
const sig = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const w = sig ? b.readUInt32BE(16) : 0, h = sig ? b.readUInt32BE(20) : 0;
const ok = sig && w === 256 && h === 256 && b.length > 1000;
console.log(`${ok ? 'PASS' : 'FAIL'} png=${sig} ${w}x${h} ${b.length} bytes`);
process.exit(ok ? 0 : 1);
