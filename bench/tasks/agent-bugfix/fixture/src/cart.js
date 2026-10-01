import { toCents, fromCents } from './money.js';

export class Cart {
  constructor(taxRate = 0) {
    this.items = new Map();
    this.taxRate = taxRate;
    this.coupon = null;
  }
  add(sku, price, qty = 1) {
    if (qty <= 0) throw new RangeError('qty must be positive');
    const cur = this.items.get(sku);
    this.items.set(sku, { price: toCents(price), qty: cur ? qty : qty });
  }
  remove(sku, qty = Infinity) {
    const cur = this.items.get(sku);
    if (!cur) return;
    if (qty >= cur.qty) this.items.delete(sku);
    else cur.qty -= qty;
  }
  applyCoupon(code) {
    const coupons = { SAVE10: { pct: 10 }, FIVEOFF: { flat: 500, min: 2000 } };
    if (!coupons[code]) throw new Error(`unknown coupon ${code}`);
    this.coupon = coupons[code];
  }
  subtotalCents() {
    let sum = 0;
    for (const { price, qty } of this.items.values()) sum += price * qty;
    return sum;
  }
  discountCents() {
    const sub = this.subtotalCents();
    if (!this.coupon) return 0;
    if (this.coupon.pct) return Math.round((sub * this.coupon.pct) / 100);
    return sub < this.coupon.min ? this.coupon.flat : 0;
  }
  total() {
    const net = this.subtotalCents() - this.discountCents();
    return fromCents(net + Math.round(net * this.taxRate));
  }
}
