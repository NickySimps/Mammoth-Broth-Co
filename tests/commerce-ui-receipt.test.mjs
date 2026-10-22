import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as ui from '../commerce-ui.mjs';

test('guest receipt strips redirect queries and fragment before POST; renders server status without third party assets', async () => {
  const source = await readFile(new URL('../receipt.mjs', import.meta.url), 'utf8').catch(() => '');
  assert.ok(source, 'Secure receipt controller must exist');
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false, href: '', children: [], append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, addEventListener(type, fn) { this[type] = fn; } }); return nodes.get(id); };
  const stored = new Map(); const requests = []; const history = [];
  const context = vm.createContext({ ...ui, URL, URLSearchParams, sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    location: { hash: '#order=order-1&token=private-cap', pathname: '/thank-you.html', search: '?payment_intent_client_secret=stripe-secret' },
    history: { replaceState: (...args) => history.push(args) },
    document: { getElementById: node, createElement: () => ({ textContent: '' }) },
    fetch: async (url, request) => { requests.push({ url, request }); return { ok: true, json: async () => ({ result: { orderId: 'order-1', status: 'pending_payment', items: [], totalAmount: 2500, paymentMethod: 'stripe' } }) }; }
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, ''), context);
  await new Promise(setImmediate);
  assert.equal(history[0][2], '/thank-you.html');
  assert.deepEqual(JSON.parse(requests[0].request.body), { data: { orderId: 'order-1', token: 'private-cap' } });
  assert.doesNotMatch(requests[0].url, /private-cap|stripe-secret/);
  assert.equal(requests[0].request.referrerPolicy, 'no-referrer');
  assert.match(node('receipt-status').textContent, /awaiting.*signed.*confirmation/i);
  assert.equal(node('receipt-refresh').hidden, false);
  context.fetch = async () => ({ ok: true, json: async () => ({ result: { orderId: 'order-1', status: 'awaiting_payment', fulfillmentMethod: 'special_order', items: [], totalAmount: 2500 } }) });
  await node('receipt-refresh').click();
  assert.match(node('receipt-status').textContent, /payment setup.*owner/i);
  assert.equal(node('receipt-payment').hidden, true);
  context.fetch = async () => ({ ok: true, json: async () => ({ result: { orderId: 'order-1', status: 'paid_requires_review', items: [], totalAmount: 2500, marketName: 'Sunday market', pickupDate: '2026-10-25', deliveryDate: '2026-10-26', checkoutUrl: 'https://checkout.stripe.com/pay/old' } }) });
  await node('receipt-refresh').click();
  assert.match(node('receipt-status').textContent, /payment (received|confirmed)/i);
  assert.match(node('receipt-status').textContent, /fulfillment.*(not confirmed|unconfirmed)/i);
  assert.match(node('receipt-status').textContent, /refund/i);
  assert.match(node('receipt-status').textContent, /do not pay again/i);
  assert.equal(node('receipt-payment').hidden, true);
  assert.doesNotMatch(node('receipt-details').children.map(child => child.textContent).join('\n'), /Pickup:|Monday delivery:/);
  for (const page of ['receipt.html', 'thank-you.html']) {
    const html = await readFile(new URL('../' + page, import.meta.url), 'utf8');
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
    assert.doesNotMatch(html, /floating-buttons|account\.html|createPreorder|retrievePaymentIntent/);
  }
});
