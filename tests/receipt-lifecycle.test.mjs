import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as ui from '../commerce-ui.mjs';
import * as orderQr from '../receipt-order-qr.mjs';

async function renderReceipt(order) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false, href: '', removeAttribute(name) { delete this[name]; }, children: [], append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, addEventListener(type, callback) { this[type] = callback; } });
    return nodes.get(id);
  };
  const storage = new Map();
  const context = vm.createContext({ ...ui, ...orderQr, URL, URLSearchParams,
    location: { hash: '#order=fixture-order&token=fixture-proof', pathname: '/receipt.html' },
    history: { replaceState() {} },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: { getElementById: node, createElement: () => ({ textContent: '' }), createElementNS: () => ({ setAttribute() {}, append() {} }) },
    fetch: async () => ({ ok: true, json: async () => ({ result: { orderId: 'fixture-order', items: [], totalAmount: 2500, ...order } }) })
  });
  vm.runInContext((await readFile(new URL('../receipt.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, ''), context);
  await new Promise(setImmediate);
  return { node, text: node('receipt-status').textContent, details: node('receipt-details').children.map(child => child.textContent).join('\n') };
}

test('terminal and unknown pickup receipts never demand another pickup payment', async () => {
  for (const [status, expected] of [['cancelled', /cancelled/i], ['refunded', /refunded/i], ['completed', /completed/i], ['unknown-state', /contact/i]]) {
    const receipt = await renderReceipt({ status, paymentMethod: 'pickup', marketName: 'Market', pickupDate: '2026-10-25' });
    assert.match(receipt.text, expected);
    assert.doesNotMatch(receipt.text, /payment is due at|pay at.*pickup|preorder is recorded/i);
    assert.equal(receipt.node('receipt-payment').hidden, true);
  }
});

test('ordinary card orders awaiting payment never claim special-order approval', async () => {
  for (const fulfillmentMethod of ['market_pickup', 'local_delivery']) {
    const receipt = await renderReceipt({ status: 'awaiting_payment', fulfillmentMethod, paymentMethod: 'stripe' });
    assert.match(receipt.text, /awaiting payment/i);
    assert.doesNotMatch(receipt.text, /special.order|approved|approved terms/i);
    assert.match(receipt.text, /existing checkout|interrupted|contact/i);
    assert.equal(receipt.node('receipt-payment').hidden, true);
  }
  const special = await renderReceipt({ status: 'awaiting_payment', fulfillmentMethod: 'special_order', checkoutUrl: 'https://checkout.stripe.com/pay/fixture' });
  assert.match(special.text, /special.order.*approved/i);
  assert.equal(special.node('receipt-payment').hidden, false);
});

test('terminal and unknown receipts do not present an active pickup or delivery promise', async () => {
  for (const status of ['cancelled', 'refunded', 'completed', 'declined', 'unknown-state']) {
    const receipt = await renderReceipt({ status, paymentMethod: 'pickup', marketName: 'Market', pickupDate: '2026-10-25', deliveryDate: '2026-10-26' });
    assert.doesNotMatch(receipt.details, /Pickup:|Monday delivery:/);
    assert.match(receipt.details, /Reference:|Total:/);
  }
});
