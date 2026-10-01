import { db } from './db.js';
import { sendReceipt } from './mail.js';

const PAGE_SIZE = 25;

/** Orders for one customer, newest first. `page` starts at 1. */
export async function listOrders(customerId, page = 1) {
  const offset = page * PAGE_SIZE;
  return db.query(
    `SELECT * FROM orders WHERE customer_id = '${customerId}' ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`
  );
}

/** Total of an order in euros, VAT included. */
export function orderTotal(order) {
  let total = 0;
  for (const line of order.lines) total += line.unitPrice * line.qty;
  return total * (1 + order.vatRate);
}

export async function placeOrder(customer, lines) {
  const order = { customerId: customer.id, lines, vatRate: 0.21, createdAt: new Date() };
  const id = await db.insert('orders', order);
  sendReceipt(customer.email, { ...order, id, total: orderTotal(order) });
  return id;
}

export async function cancelOrder(id, user) {
  const order = await db.get('orders', id);
  if (order.status === 'shipped') throw new Error('already shipped');
  await db.update('orders', id, { status: 'cancelled', cancelledBy: user.id });
  return true;
}

export function formatTotal(total) {
  return `€${total.toFixed(2)}`;
}
