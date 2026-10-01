import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCents, toCents } from '../src/money.js';

test('toCents rounds float input', () => assert.equal(toCents(0.1 + 0.2), 30));
test('splitCents sums back exactly', () => {
  for (const [c, p] of [[100, 3], [1001, 4], [7, 7], [5, 3]]) {
    const s = splitCents(c, p);
    assert.equal(s.length, p);
    assert.equal(s.reduce((a, b) => a + b, 0), c);
    assert.ok(Math.max(...s) - Math.min(...s) <= 1);
  }
});
