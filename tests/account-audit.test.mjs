import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const base = { id: 'order-1', items: [], totalAmount: 2500, fulfillmentMethod: 'market_pickup', paymentMethod: 'stripe', marketName: 'Saturday market', pickupDate: '2026-10-24', deliveryDate: '2026-10-26' };
async function accountHtml(order) {
  const elements = new Map();
  const node = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { getElementById: node, querySelectorAll: () => [] }, window: {}, getUserOrders: async () => [order], watchUser() {} });
  vm.runInContext(readFileSync(new URL('../account.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
  await context.renderOrders({ uid: 'account-1' });
  return node('orders-list').innerHTML;
}

test('backend lifecycle states do not promise obsolete payment or fulfillment', async () => {
  const labels = { pending: 'Reserved', awaiting_approval: 'Awaiting approval', awaiting_payment: 'Awaiting payment', payment_processing: 'Payment processing', paid: 'Payment received', confirmed: 'Confirmed', ready_for_pickup: 'Ready for pickup', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled', refunded: 'Refunded', mystery: 'Status unavailable' };
  for (const [status, label] of Object.entries(labels)) {
    for (const fulfillmentMethod of ['market_pickup', 'local_delivery', 'special_order']) {
      for (const paymentMethod of ['stripe', 'pickup']) {
        const html = await accountHtml({ ...base, status, fulfillmentMethod, paymentMethod });
        assert.ok(html.includes(status === 'pending' && fulfillmentMethod === 'special_order' ? 'Awaiting approval' : label), `${status}/${fulfillmentMethod}: missing ${label}: ${html}`);
        if (['declined', 'cancelled', 'refunded', 'completed', 'mystery'].includes(status)) {
          assert.doesNotMatch(html, /Pay at pickup|Payment pending|terms after approval|not reserved|requires approval|<strong>Pickup<\/strong>|Saturday market|2026-10-24|2026-10-26|Delivery timing will be confirmed/);
        }
        if (status === 'awaiting_payment') {
          assert.match(html, /Payment pending/);
          assert.doesNotMatch(html, /terms after approval|requires approval|not reserved/);
        }
        if (['confirmed', 'ready_for_pickup'].includes(status) && fulfillmentMethod === 'special_order') assert.doesNotMatch(html, /terms after approval|requires approval|not reserved/);
      }
    }
  }
});

test('paid special orders show settled payment and no obsolete approval warning', async () => {
  const html = await accountHtml({ ...base, fulfillmentMethod: 'special_order', paymentMethod: 'special_order', status: 'paid' });
  assert.match(html, /Payment received/);
  assert.doesNotMatch(html, /Payment not confirmed|terms after approval|fulfillment requires approval|not reserved/);
  assert.match(html, /Contact.*owner.*fulfillment/i);
});

test('paid_requires_review acknowledges payment, requires owner contact and suppresses ordinary fulfillment', async () => {
  for (const fulfillmentMethod of ['market_pickup', 'local_delivery', 'special_order']) {
    const html = await accountHtml({ ...base, fulfillmentMethod, status: 'paid_requires_review', specialNotes: 'Old fulfillment note' });
    assert.match(html, /Payment received/i);
    assert.match(html, /fulfillment (?:is )?not confirmed/i);
    assert.match(html, /contact (?:the )?owner/i);
    assert.match(html, /do not pay again/i);
    assert.doesNotMatch(html, /Status unavailable|Payment pending|Payment not confirmed|Pay at pickup|<strong>Pickup<\/strong>|Saturday market|2026-10-24|2026-10-26|Old fulfillment note|Delivery timing will be confirmed/);
  }
});
