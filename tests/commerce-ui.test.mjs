import test from 'node:test';
import assert from 'node:assert/strict';

const ui = await import('../commerce-ui.mjs').catch(() => ({}));
test('checkout revisions reject stale async results and reuse request IDs only for identical retries', () => {
  assert.equal(typeof ui.createCheckoutRevision, 'function');
  let count = 0;
  const state = ui.createCheckoutRevision(() => `request-${++count}`);
  const first = state.begin({ cart: { beef: 5 }, customerName: 'Alex' });
  assert.deepEqual(state.begin({ cart: { beef: 5 }, customerName: 'Alex' }), first);
  state.invalidate();
  assert.equal(state.isCurrent(first), false);
  const next = state.begin({ cart: { beef: 5 }, customerName: 'Other' });
  assert.notEqual(next.requestId, first.requestId);
  assert.equal(state.isCurrent(next), true);
});
test('checkout attempts persist a 32-byte client proof before any network, reuse after reload, and reject legacy attempts', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  let randomBytes = 0;
  const options = { storage, scope: 'card', crypto: { getRandomValues(bytes) { randomBytes++; assert.equal(bytes.length, 32); bytes.fill(171); return bytes; } } };
  const payload = { cart: { beef: 2 } };
  const first = ui.createCheckoutRevision(() => 'random-request-0001', options).begin(payload);
  assert.equal(first.receiptToken, 'ab'.repeat(32));
  assert.ok([...data.entries()].some(([key, value]) => key.includes(first.requestId) && value.includes(first.receiptToken)), 'Persist before returning the attempt');
  const restored = ui.createCheckoutRevision(() => 'must-not-replace', options).begin(payload);
  assert.equal(restored.requestId, first.requestId);
  assert.equal(restored.receiptToken, first.receiptToken);
  assert.equal(randomBytes, 1);
  const entry = [...data.entries()].find(([key]) => key.includes(first.requestId));
  const legacy = JSON.parse(entry[1]); delete legacy.receiptToken;
  storage.setItem(entry[0], JSON.stringify(legacy));
  assert.throws(() => ui.createCheckoutRevision(() => 'must-not-replace', options).begin(payload), /capability|proof/i);
});

test('creation responses must prove the exact issued receipt capability without replacing it', () => {
  const data = new Map(); const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const attempt = { receiptToken: 'ab'.repeat(32) };
  assert.equal(typeof ui.rememberAttemptReceipt, 'function');
  for (const proof of [null, undefined, 'cd'.repeat(32), 'invalid']) {
    assert.equal(ui.rememberAttemptReceipt({ orderId: 'order', receiptToken: proof }, attempt, storage), null);
    assert.equal(data.size, 0);
  }
  assert.deepEqual(ui.rememberAttemptReceipt({ orderId: 'order', receiptToken: attempt.receiptToken }, attempt, storage), { orderId: 'order', token: attempt.receiptToken });
  assert.equal(ui.rememberAttemptReceipt({ orderId: 'order', receiptToken: attempt.receiptToken }, {}, storage), null, 'Legacy attempts without own capability remain blocked');
});

test('delivery fails closed before quoting and exposes server fee, Monday date and cutoff', () => {
  assert.equal(typeof ui.deliveryEligibility, 'function');
  const policy = { enabled: true, allowedZips: ['32202'], state: 'FL', feeCents: 500, minimumJars: 5, cutoffHours: 48 };
  const address = { street: '1 Main', city: 'Jacksonville', state: 'FL', zip: '32202' };
  assert.match(ui.deliveryEligibility(null, 5, address), /not configured/i);
  assert.match(ui.deliveryEligibility({ ...policy, allowedZips: [] }, 5, address), /not configured/i);
  assert.match(ui.deliveryEligibility(policy, 4, address), /5 jars/);
  assert.match(ui.deliveryEligibility(policy, 5, { ...address, zip: '99999' }), /outside/i);
  assert.match(ui.deliveryEligibility(policy, 5, { ...address, street: '' }), /complete/i);
  assert.equal(ui.deliveryEligibility(policy, 5, address), '');
  assert.match(ui.deliveryQuoteText({ deliveryFee: 500, deliveryDate: '2026-10-26', totalAmount: 10500 }, policy), /\$5\.00.*2026-10-26.*\$105\.00.*48 hours.*UTC/);
  assert.throws(() => ui.deliveryQuoteText({ deliveryFee: 0 }, policy), /quote/i);
});
test('owner review requires an explicit admin claim and explicit final line prices', () => {
  assert.equal(typeof ui.buildSpecialReview, 'function');
  const items = [{ productId: 'beef', name: 'Beef broth', quantity: 2, price: 2100 }];
  assert.throws(() => ui.buildSpecialReview({ admin: false }, 'order', 'approve', items), /admin/i);
  assert.deepEqual(ui.buildSpecialReview({ admin: true }, 'order', 'approve', items), { orderId: 'order', decision: 'approve', items, totalAmount: 4200 });
  assert.deepEqual(ui.buildSpecialReview({ admin: true }, 'order', 'decline'), { orderId: 'order', decision: 'decline' });
  assert.throws(() => ui.buildSpecialReview({ admin: true }, 'order', 'approve', [{ ...items[0], price: -1 }]), /price/i);
  assert.throws(() => ui.buildSpecialReview({ admin: true }, 'order', 'approve', [{ ...items[0], quantity: 1.5 }]), /quantity/i);
  assert.throws(() => ui.buildSpecialReview({ admin: true }, 'order', 'approve', []), /item/i);
});
test('receipt capabilities survive redirect in session storage, never query strings', () => {
  assert.equal(typeof ui.rememberReceipt, 'function');
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  ui.rememberReceipt({ orderId: 'order-1', receiptToken: 'secret-1' }, storage);
  ui.rememberReceipt({ orderId: 'order-1', receiptToken: null }, storage);
  assert.deepEqual(ui.readReceipt('', storage), { orderId: 'order-1', token: 'secret-1' });
  assert.equal(ui.receiptHref({ orderId: 'order-1', token: 'secret-1' }), './receipt.html#order=order-1&token=secret-1');
  assert.deepEqual(ui.readReceipt('#order=other&token=cap', storage), { orderId: 'other', token: 'cap' });
  assert.equal(ui.readReceipt('#order=other', storage), null, 'An incomplete new link must not silently open a previous customer receipt');
  assert.deepEqual(ui.readReceipt('#order=order-1', storage), { orderId: 'order-1', token: 'secret-1' });
  for (const fragment of ['#order=order-1&token=', '#token=secret-1', '#order=order-1&token=a&token=b', '#order=order-1&order=other', '#order=order-1&token=+', '#order=order-1&token=%ZZ']) {
    assert.equal(ui.readReceipt(fragment, storage), null, `Malformed capability must fail closed: ${fragment}`);
  }
});
