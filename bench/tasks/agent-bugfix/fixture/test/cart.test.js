import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';

test('adding the same sku accumulates quantity', () => {
  const c = new Cart();
  c.add('pen', 1.5, 2);
  c.add('pen', 1.5, 3);
  assert.equal(c.items.get('pen').qty, 5);
  assert.equal(c.total(), 7.5);
});
test('remove part of a line', () => {
  const c = new Cart();
  c.add('cup', 4, 3);
  c.remove('cup', 1);
  assert.equal(c.total(), 8);
});
test('percent coupon and tax', () => {
  const c = new Cart(0.19);
  c.add('book', 20);
  c.applyCoupon('SAVE10');
  assert.equal(c.total(), 21.42);
});
test('flat coupon needs the minimum spend', () => {
  const small = new Cart();
  small.add('gum', 3);
  small.applyCoupon('FIVEOFF');
  assert.equal(small.total(), 3);
  const big = new Cart();
  big.add('lamp', 25);
  big.applyCoupon('FIVEOFF');
  assert.equal(big.total(), 20);
});
