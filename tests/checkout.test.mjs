import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as commerce from '../commerce-ui.mjs';
import { webcrypto } from 'node:crypto';

async function loadCheckout({ response = request => ({ data: { orderId: 'test-order', receiptToken: request.receiptToken, totalAmount: 1800 } }), reject = false, failures = 0, history = '[]' } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, textContent: '', listeners: {}, attrs: {}, isConnected: true,
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(key, value) { this.attrs[key] = value; },
      hasAttribute(key) { return key in this.attrs; },
      querySelectorAll: () => [node('#confirmationModal .close-button')],
      getClientRects: () => [{}], closest: () => null,
      focus() { document.activeElement = this; }
    });
    return nodes.get(id);
  };
  const calls = [];
  const alerts = [];
  const requests = [];
  const storage = new Map([['mammothOrders', history]]);
  let requestSequence = 0;
  const document = { getElementById: node, querySelector: selector => node(selector), body: { style: { overflow: 'auto' } }, activeElement: node('submit') };
  const context = vm.createContext({
    ...commerce,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    console: { error() {}, info() {}, warn() {} },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    crypto: webcrypto,
    document,
    window: { addEventListener() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    alert: message => alerts.push(message),
    fetch: async (...args) => { requests.push(args); return { ok: true }; },
    createPreorder: async order => {
      calls.push(order);
      if (reject || calls.length <= failures) throw new Error('Unavailable');
      return typeof response === 'function' ? response(order) : response;
    }
  });
  vm.runInContext((await readFile(new URL('../dialog.mjs', import.meta.url), 'utf8')).replace(/^export /gm, ''), context);
  const source = (await readFile(new URL('../checkout.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace('export async function checkout', 'async function checkout');
  vm.runInContext(source, context);
  return { node, calls, alerts, requests, storage, document, checkout: context.checkout };
}

const order = {
  customerName: 'Alex', customerEmail: 'alex@example.com', cart: { beef: 1 },
  fulfillmentMethod: 'market_pickup', marketId: 'market_atlantic', pickupDate: '2026-10-25',
  paymentMethod: 'pickup', totalAmount: 2000
};
const successful = await loadCheckout();
const saved = await successful.checkout(order);
assert.equal(saved.firestoreId, 'test-order');
assert.equal(successful.calls.length, 1);
assert.equal(successful.node('confirmationModal').style.display, 'block');
assert.equal(successful.document.body.style.overflow, 'hidden', 'Confirmation must lock background scrolling');
assert.equal(saved.totalAmount, 1800, 'Use the server-authoritative total in the local receipt');
assert.equal(successful.requests.length, 0, 'Confirmation email belongs to the server order trigger, not a second browser endpoint');
assert.ok(successful.node('#confirmationModal .close-button').listeners.click, 'Bind confirmation close, not the earlier cart close button');
successful.node('#confirmationModal .close-button').listeners.click();
assert.equal(successful.node('confirmationModal').style.display, 'none');
assert.equal(successful.document.body.style.overflow, 'auto');
assert.equal(successful.document.activeElement, successful.node('submit'));

const rejected = await loadCheckout({ reject: true });
assert.equal(await rejected.checkout(order), null);
assert.equal(rejected.storage.get('mammothOrders'), '[]');
assert.notEqual(rejected.node('confirmationModal').style.display, 'block');

const malformed = await loadCheckout({ response: { data: {} } });
assert.equal(await malformed.checkout(order), null, 'Missing durable order ID is not success');

for (const history of ['not-json', '{}', 'null']) {
  const corrupted = await loadCheckout({ history });
  assert.ok(await corrupted.checkout(order), 'A saved order must not appear failed because local receipt history is corrupt');
  assert.equal(corrupted.alerts.length, 0);
  assert.equal(JSON.parse(corrupted.storage.get('mammothOrders')).length, 1);
}

const retry = await loadCheckout({ failures: 1 });
assert.equal(await retry.checkout(order), null);
assert.ok(await retry.checkout(order));
assert.equal(retry.calls[0].idempotencyKey, retry.calls[1].idempotencyKey, 'A retry of an unconfirmed request must retain its request reference');
assert.equal(retry.calls[0].orderName, retry.calls[1].orderName);
await retry.checkout(order);
assert.notEqual(retry.calls[1].idempotencyKey, retry.calls[2].idempotencyKey, 'Two intentional orders must not collide even if their human-readable names do');

const special = await loadCheckout();
await special.checkout({ ...order, fulfillmentMethod: 'special_order', paymentMethod: 'special_order', specialNotes: 'Please contact me about this request.' });
assert.match(special.node('confirmation-title').textContent, /request received/i);
assert.match(special.node('confirmation-details').textContent, /approval/i);
assert.doesNotMatch(special.node('confirmation-details').textContent, /reserved|paid/i);

console.log('checkout persistence regression tests passed');
