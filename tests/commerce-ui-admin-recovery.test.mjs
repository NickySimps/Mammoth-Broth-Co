import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as ui from '../commerce-ui.mjs';

async function harness() {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', addEventListener(type, fn) { this[type] = fn; } }); return nodes.get(id); };
  const shell = { innerHTML: 'Dashboard' }; let watch;
  const items = [{ productId: 'beef', name: 'Approved broth', quantity: 2, price: 2100 }];
  const orders = [{ id: 'special-1', fulfillmentMethod: 'special_order', status: 'awaiting_payment', items, totalAmount: 4200, emailState: 'pending' }];
  const writes = [];
  const context = vm.createContext({ ...ui, URL, console, document: { querySelector: () => shell, getElementById: node }, watchUser: fn => { watch = fn; }, isAdmin: async user => user?.admin === true, getAllOrders: async () => orders,
    reviewSpecialOrder: async payload => { writes.push(JSON.parse(JSON.stringify(payload))); return { data: { orderId: 'special-1', status: 'awaiting_payment', checkoutUrl: 'https://checkout.stripe.com/c/recovered' } }; }
  });
  vm.runInContext((await readFile(new URL('../admin.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, ''), context);
  await watch({ admin: true });
  const status = { textContent: '' }; const link = { hidden: true };
  const form = { dataset: { reviewOrder: 'special-1' }, querySelectorAll: () => [], querySelector: selector => selector === '[data-review-status]' ? status : selector === '[data-checkout-link]' ? link : { value: '[{"productId":"tampered","name":"Changed","quantity":1,"price":1}]' } };
  return { context, node, watch, writes, form, status, link, orders };
}
test('approved order without checkout exposes resume and resubmits only frozen approved terms', async () => {
  const h = await harness();
  assert.match(h.node('special-order-review').innerHTML, /data-resume-payment/);
  assert.match(h.node('special-order-review').innerHTML, /Resume payment setup/);
  assert.match(h.node('special-order-review').innerHTML, /readonly/);
  await h.context.performReview(h.form, 'resume');
  assert.deepEqual(h.writes, [{ orderId: 'special-1', decision: 'approve', items: h.orders[0].items, totalAmount: 4200 }]);
  assert.equal(h.link.href, 'https://checkout.stripe.com/c/recovered');
  await h.watch(null);
  await h.context.performReview(h.form, 'resume');
  assert.equal(h.writes.length, 1);
});
test('failed Stripe setup reloads the approved snapshot and exposes recovery immediately', async () => {
  const h = await harness();
  h.orders[0].status = 'awaiting_approval';
  h.context.renderDashboard(h.orders);
  h.context.reviewSpecialOrder = async () => { h.orders[0].status = 'awaiting_payment'; throw new Error('Stripe unavailable'); };
  await h.context.performReview(h.form, 'approve');
  assert.match(h.node('special-order-review').innerHTML, /data-resume-payment/);
  assert.match(h.node('special-order-review').innerHTML, /readonly/);
});
test('queue displays durable email pending state without claiming delivery', async () => {
  const h = await harness();
  assert.match(h.node('special-order-review').innerHTML, /Email: pending[^<]*not (?:yet )?delivered/i);
});
