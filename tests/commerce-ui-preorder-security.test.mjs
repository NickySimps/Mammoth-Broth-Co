import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as ui from '../commerce-ui.mjs';

async function harness({ session = new Map(), response, failures = 0 } = {}) {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { style: {}, textContent: '', hidden: true, addEventListener() {} }); return nodes.get(id); };
  const local = new Map(); const calls = []; const errors = []; const alerts = [];
  const context = vm.createContext({ ...ui, crypto: webcrypto, console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) }, alert: message => alerts.push(message), document: { getElementById: node, querySelector: () => null }, window: { addEventListener() {} },
    sessionStorage: { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key) },
    localStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value) },
    createPreorder: async data => { calls.push(data); if (calls.length <= failures) throw new Error('Provider error ' + data.receiptToken); return response ? response(data) : { data: { orderId: 'order-1', orderName: 'Mammoth-server-hash', receiptToken: data.receiptToken, totalAmount: 2000, emailState: 'pending' } }; }, openDialog() {}, closeDialog() {}
  });
  vm.runInContext((await readFile(new URL('../checkout.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
  return { context, node, session, local, calls, errors, alerts };
}
const order = { cart: { beef: 1 }, customerName: 'Alex', customerEmail: 'a@example.com', fulfillmentMethod: 'market_pickup', paymentMethod: 'pickup' };

test('pickup client proof is isolated from cached orders even when supplied in input', async () => {
  const h = await harness();
  const result = await h.context.checkout({ ...order, receiptToken: 'injected-proof', token: 'injected-proof', clientSecret: 'injected-secret' });
  assert.ok(result);
  assert.match(h.calls[0].receiptToken || '', /^[a-f0-9]{64}$/);
  assert.equal(h.node('confirmation-receipt').href, './receipt.html#order=order-1&token=' + h.calls[0].receiptToken);
  assert.doesNotMatch(JSON.stringify([...h.local.values()]), /injected-proof|injected-secret|receiptToken|clientSecret/);
  assert.ok([...h.local.values()].every(value => !value.includes(h.calls[0].receiptToken)));
});

test('pickup provider failure and reload reuse persisted request proof without logging it', async () => {
  const session = new Map();
  const first = await harness({ session, failures: 1 });
  assert.equal(await first.context.checkout(order), null);
  const request = first.calls[0];
  assert.match(request.receiptToken || '', /^[a-f0-9]{64}$/);
  assert.ok([...session.entries()].some(([key, value]) => key.includes(request.requestId) && value.includes(request.receiptToken)));
  assert.equal(JSON.stringify([first.errors, first.alerts]).includes(request.receiptToken), false);
  const retry = await harness({ session });
  assert.ok(await retry.context.checkout(order));
  assert.equal(JSON.stringify(retry.calls[0]), JSON.stringify(request));
  assert.equal(JSON.parse(session.get('mammothGuestReceipt')).token, request.receiptToken);
});

test('pickup never reports saved success or caches an order when response proof is absent or mismatched', async () => {
  for (const proof of [undefined, 'cd'.repeat(32)]) {
    const h = await harness({ response: () => ({ data: { orderId: 'order-1', receiptToken: proof, totalAmount: 2000 } }) });
    assert.equal(await h.context.checkout(order), null);
    assert.equal(h.local.has('mammothOrders'), false);
    assert.equal(h.node('confirmation-receipt').hidden, true);
  }
});
