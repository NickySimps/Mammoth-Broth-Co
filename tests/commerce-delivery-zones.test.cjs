const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, base } = require('./commerce-fixture.cjs');
const { createHash } = require('node:crypto');
const { deliveryPolicy: policy } = require('./delivery-policy-fixture.cjs');

// Pre-policy persisted input: historical recovery remains supported, but the
// disabled endpoint must never be used to manufacture a new delivery order.
function seedHistoricalDelivery(f, cart, deliveryAddress, fee) {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const input = {
    requestId: base.requestId, cart, customerName: base.customerName,
    customerEmail: base.customerEmail, customerUid: null, fulfillmentMethod: 'local_delivery',
    marketId: null, pickupDate: null, specialNotes: '', deliveryAddress, paymentMethod: 'stripe',
  };
  const stable = JSON.stringify(input, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const orderId = hash(base.requestId);
  f.records.set(`orders/${orderId}`, {
    ...input, fingerprint: hash(stable), orderName: 'Historical delivery', status: 'awaiting_payment',
    items: [{ productId: 'mushroom', name: 'Mushroom Broth', quantity: 6, price: 2500, itemTotal: 15000 }],
    subtotal: 15000, discountAmount: 0, deliveryFee: fee, totalAmount: 15000 + fee,
    currency: 'usd', deliveryDate: '2026-10-26', paymentBinding: 'historical-zone-binding',
    receiptTokenHash: hash(base.receiptToken), receiptRevoked: false,
    receiptExpiresAt: Date.parse('2026-11-21T12:00:00Z'),
    createdAt: Date.parse('2026-10-22T12:00:00Z'), paymentIntentId: null, clientSecret: null,
  });
  return orderId;
}
const address = zip => ({ street: '1 Main St', city: 'Customer supplied city', state: 'FL', zip });

test('approved ZIP quotes agree with UI and historical recovery amounts while new delivery is blocked', async () => {
  const ui = await import('../commerce-ui.mjs');
  for (const [zip, fee] of [['32204', 1000], ['32205', 1000], ['32233', 1500], ['32082', 1500]]) {
    const f = fixture();
    const configured = policy();
    f.records.set('settings/delivery', configured);
    const cart = { mushroom: 6 };
    const before = structuredClone([...f.records]);
    assert.equal(ui.deliveryEligibility(configured, 6, address(zip)), '');
    const quote = await f.api.getDeliveryQuote({ cart, address: address(zip), deliveryFee: 1, totalAmount: 1, zone: 'jacksonville' });
    assert.equal(quote.deliveryFee, fee);
    assert.equal(quote.totalAmount, 15000 + fee);
    assert.match(ui.deliveryQuoteText(quote, configured), new RegExp(`\\$${fee / 100}\\.00`));
    assert.deepEqual([...f.records], before, 'quotes are read-only');
    const payload = { ...base, cart, fulfillmentMethod: 'local_delivery', deliveryAddress: address(zip),
      deliveryFee: 1, totalAmount: 1, zone: 'jacksonville' };
    const runTransaction = f.db.runTransaction;
    f.db.runTransaction = callback => runTransaction(tx => callback({
      ...tx,
      get: ref => {
        assert.match(ref.path, /^orders\//, 'must reject before pricing or budget reads');
        return tx.get(ref);
      },
      set: () => assert.fail('must not schedule writes'),
      update: () => assert.fail('must not schedule updates'),
    }));
    await assert.rejects(f.api.createPaymentIntent(payload), {
      code: 'failed-precondition',
      message: 'Delivery requires subscription checkout, which is not available yet.',
    });
    assert.deepEqual([...f.records], before);
    assert.equal(f.payments.length, 0);
    assert.equal(f.sessions.length, 0);
    assert.equal(f.mails.length, 0);
    f.db.runTransaction = runTransaction;
    const historicalId = seedHistoricalDelivery(f, cart, address(zip), fee);
    const historical = structuredClone(f.records.get(`orders/${historicalId}`));
    await assert.rejects(f.api.createPaymentIntent({ ...payload, receiptToken: 'b'.repeat(64) }),
      { code: 'permission-denied' });
    assert.deepEqual(f.records.get(`orders/${historicalId}`), historical);
    assert.equal(f.payments.length, 0);
    const result = await f.api.createPaymentIntent(payload);
    assert.equal(result.orderId, historicalId);
    const order = f.records.get(`orders/${result.orderId}`);
    assert.equal(order.subtotal, quote.subtotal);
    assert.equal(order.discountAmount, quote.discountAmount);
    assert.equal(order.deliveryDate, quote.deliveryDate);
    assert.equal(order.deliveryFee, quote.deliveryFee);
    assert.equal(order.totalAmount, quote.totalAmount);
    assert.equal(f.payments.length, 1);
    assert.equal(f.payments[0].p.amount, quote.totalAmount);
    assert.equal(f.payments[0].p.currency, 'usd');
    assert.equal(f.payments[0].p.metadata.binding, 'historical-zone-binding');
    assert.equal(f.payments[0].o.idempotencyKey, `order-${historicalId}`);
    await f.api.createPaymentIntent(payload);
    assert.equal(f.payments.length, 1, 'retries reuse the recovered intent');
    const receipt = await f.api.getGuestReceipt({ orderId: result.orderId, token: base.receiptToken });
    assert.equal(receipt.deliveryFee, fee);
    assert.equal(receipt.totalAmount, quote.totalAmount);
    assert.equal(receipt.deliveryDate, quote.deliveryDate);
    await assert.rejects(f.api.getGuestReceipt({ orderId: result.orderId, token: 'b'.repeat(64) }),
      { code: 'permission-denied' });
  }
});
test('quote parser displays returned price rather than a local tier guess and rejects unsafe amounts', async () => {
  const { deliveryQuoteText } = await import('../commerce-ui.mjs');
  const quote = { deliveryFee: 1500, totalAmount: 16500, deliveryDate: '2026-10-26' };
  const stale = policy();
  stale.zones[1].feeCents = 1000;
  assert.match(deliveryQuoteText(quote, stale), /\$15\.00.*\$165\.00/);
  for (const broken of [
    { ...quote, deliveryFee: Number.MAX_SAFE_INTEGER + 1 },
    { ...quote, totalAmount: Number.MAX_SAFE_INTEGER + 1 },
    { ...quote, totalAmount: 1 },
    { ...quote, deliveryDate: '2026-02-30' },
  ]) assert.throws(() => deliveryQuoteText(broken, policy()), /quote/i);
});
