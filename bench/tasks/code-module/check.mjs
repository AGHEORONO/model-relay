// Hidden acceptance tests: run against the workspace's src/duration.js.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ws = process.argv[2];
const fail = (m) => { console.log(`FAIL ${m}`); process.exit(1); };
if (!existsSync(path.join(ws, 'src/duration.js'))) fail('src/duration.js missing');
if (!existsSync(path.join(ws, 'test/duration.test.js'))) fail('test/duration.test.js missing');

const { parseDuration: p, formatDuration: f } = await import(pathToFileURL(path.join(ws, 'src/duration.js')));
const cases = [
  () => assert.equal(p('1h30m'), 5_400_000), () => assert.equal(p('1h 30m'), 5_400_000),
  () => assert.equal(p('2d 4h'), 187_200_000), () => assert.equal(p('500ms'), 500),
  () => assert.equal(p('1.5h'), 5_400_000), () => assert.equal(p('-2m'), -120_000),
  () => assert.equal(p('250'), 250), () => assert.equal(p('  1H '), 3_600_000),
  () => assert.equal(p('1w'), 604_800_000),
  ...['', '5x', '1h1h', '30m1h', 'abc'].map((s) => () => assert.throws(() => p(s), (e) => e instanceof TypeError && /^Invalid duration/.test(e.message))),
  () => assert.throws(() => p(42), TypeError),
  () => assert.equal(f(5_400_000), '1h 30m'), () => assert.equal(f(90_061_001), '1d 1h 1m 1s 1ms'),
  () => assert.equal(f(1_209_600_000), '2w'), () => assert.equal(f(0), '0ms'), () => assert.equal(f(-60_000), '-1m'),
  () => assert.equal(f(5_400_000, { long: true }), '1 hour 30 minutes'),
  () => assert.equal(f(1000, { long: true }), '1 second'), () => assert.equal(f(0, { long: true }), '0 milliseconds'),
  () => assert.throws(() => f(1.5), TypeError), () => assert.throws(() => f(Infinity), TypeError),
  () => { for (const x of [0, 1, 999, 61_000, 90_061_001, -3_600_001, 1_209_600_000]) assert.equal(p(f(x)), x); },
];
let passed = 0;
for (const c of cases) { try { c(); passed++; } catch { /* counted below */ } }
let ownTests = 'pass';
try { execSync('node --test', { cwd: ws, stdio: 'pipe' }); } catch { ownTests = 'fail'; }
const ok = passed === cases.length && ownTests === 'pass';
console.log(`${ok ? 'PASS' : 'FAIL'} hidden ${passed}/${cases.length}, own tests ${ownTests}`);
process.exit(ok ? 0 : 1);
