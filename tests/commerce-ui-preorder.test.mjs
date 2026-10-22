import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as ui from '../commerce-ui.mjs';
import { webcrypto } from 'node:crypto';

test('pickup confirmation preserves guest capability in session storage and exposes private receipt link', async () => {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { style: {}, textContent: '', hidden: true, addEventListener() {} }); return nodes.get(id); };
  const session = new Map(); const local = new Map(); const calls = [];
  const context = vm.createContext({ ...ui, crypto: webcrypto, console, document: { getElementById: node, querySelector: () => null }, window: { addEventListener() {} },
    sessionStorage: { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
    localStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value) },
    createPreorder: async data => { calls.push(data); return { data: { orderId: 'order-1', orderName: 'Mammoth-server-hash', receiptToken: data.receiptToken, totalAmount: 2000, emailState: 'pending' } }; }, openDialog() {}, closeDialog() {}
  });
  vm.runInContext((await readFile(new URL('../checkout.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
  const result = await context.checkout({ cart: { beef: 1 }, customerName: 'Alex', customerEmail: 'a@example.com', fulfillmentMethod: 'market_pickup', paymentMethod: 'pickup' });
  assert.ok(result);
  assert.equal(result.orderName, 'Mammoth-server-hash');
  assert.equal(node('orderNumber').textContent, 'Mammoth-server-hash');
  assert.equal(JSON.parse(local.get('mammothOrders'))[0].orderName, 'Mammoth-server-hash');
  assert.equal(calls[0].orderName, undefined, 'Never invent or submit a competing display reference');
  assert.match(calls[0].requestId || '', /^[\w-]{16,128}$/);
  assert.equal(node('confirmation-receipt').href, './receipt.html#order=order-1&token=' + calls[0].receiptToken);
  assert.equal(node('confirmation-receipt').hidden, false);
  assert.ok([...session.values()].some(value => value.includes(calls[0].receiptToken)));
  assert.ok([...local.values()].every(value => !value.includes(calls[0].receiptToken)));
  assert.match(node('confirmation-details').textContent, /email.*pending.*not (?:yet )?delivered/i);
  context.createPreorder = async request => ({ data: { orderId: 'fallback-id', receiptToken: request.receiptToken, totalAmount: 2000 } });
  const fallback = await context.checkout({ cart: { beef: 1 }, orderName: 'Invented-name', fulfillmentMethod: 'market_pickup', paymentMethod: 'pickup' });
  assert.equal(fallback.orderName, 'fallback-id');
  assert.equal(node('orderNumber').textContent, 'fallback-id');
  assert.equal(JSON.parse(local.get('mammothOrders'))[0].orderName, 'fallback-id');
});
