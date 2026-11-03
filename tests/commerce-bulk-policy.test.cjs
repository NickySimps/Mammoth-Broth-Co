const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, base } = require('./commerce-fixture.cjs');

const { deliveryPolicy } = require('./delivery-policy-fixture.cjs');
const address = { street: '1 Main St', city: 'Jacksonville', state: 'FL', zip: '32204' };
function catalog() {
  const f = fixture();
  f.records.set('products/prod_beef', { name: 'Beef Broth', priceCents: 2500 });
  f.records.set('products/prod_chicken', { name: 'Chicken Broth', priceCents: 2500 });
  f.records.set('products/mushroom', { name: 'Mushroom Broth', priceCents: 4000 });
  f.records.delete('settings/promotions');
  return f;
}
test('delivery quotes enforce six canonical jars and tampered checkout is refused before writes', async () => {
  for (const cart of [{ prod_beef: 5 }, { prod_beef: 5, tea: 1 }]) {
    const f = catalog();
    f.records.set('products/tea', { name: 'Broth-flavored tea', priceCents: 900 });
    f.records.set('settings/delivery', deliveryPolicy());
    const before = structuredClone([...f.records]);
    await assert.rejects(f.api.getDeliveryQuote({ cart, address }), /minimum/i);
    await assert.rejects(f.api.createPaymentIntent({
      ...base, cart, fulfillmentMethod: 'local_delivery', deliveryAddress: address,
      minimumJars: 1, totalAmount: 1, deliveryFee: 0,
    }), { code: 'failed-precondition',
      message: 'Delivery requires subscription checkout, which is not available yet.' });
    assert.deepEqual([...f.records], before);
    assert.equal(f.payments.length, 0);
  }
});

test('obsolete single-fee and five-jar policies fail closed rather than lowering the delivery minimum', async () => {
  for (const policy of [
    { enabled: true, allowedZips: ['32204'], state: 'FL', feeCents: 500, minimumJars: 5, cutoffHours: 48 },
    { ...deliveryPolicy(), minimumJars: 5 },
  ]) {
    const f = catalog();
    f.records.set('settings/delivery', policy);
    const before = structuredClone([...f.records]);
    await assert.rejects(f.api.getDeliveryQuote({ cart: { prod_beef: 6 }, address }), {
      code: 'failed-precondition', message: 'Delivery policy is not configured.',
    });
    assert.deepEqual([...f.records], before);
    assert.equal(f.payments.length, 0);
  }
});

test('new pickup preorder bypass is refused before writes or provider work', async () => {
  const f = catalog();
  const before = structuredClone([...f.records]);
  await assert.rejects(f.api.createPreorder({
    ...base, paymentMethod: 'pickup', paymentStatus: 'paid', status: 'paid',
  }), e => e.code === 'failed-precondition' && /online.*card/i.test(e.message));
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 0);
  assert.equal(f.sessions.length, 0);
});

test('noncanonical broth names do not qualify and request prices/promotion cannot override catalog', async () => {
  const f = catalog();
  f.records.set('products/impostor', { name: 'Beef Chicken Mushroom Broth', priceCents: 8000 });
  const o = await order(f, { prod_beef: 5, impostor: 1 }, {
    subtotal: 1, discountAmount: 999999, totalAmount: 1,
    promotion: { bundleMinimum: 1, bundlePriceCents: 1 },
    items: [{ productId: 'prod_beef', price: 1, quantity: 6 }],
  });
  assert.equal(o.discountAmount, 0);
  assert.equal(o.totalAmount, 20500);
  const mixed = catalog();
  mixed.records.get('products/prod_beef').priceCents = 1500;
  const m = await order(mixed, { prod_beef: 1, prod_chicken: 1, mushroom: 4 });
  assert.equal(m.discountAmount, 500);
  assert.equal(m.totalAmount, 19500);
});

test('six mixed jars retain authoritative quote pricing, fee, geography and cutoff without enabling checkout', async () => {
  const f = catalog();
  f.records.set('settings/delivery', deliveryPolicy());
  const cart = { prod_beef: 2, prod_chicken: 1, mushroom: 3 };
  const before = structuredClone([...f.records]);
  const q = await f.api.getDeliveryQuote({ cart, address,
    deliveryFee: 0, deliveryDate: '2001-01-01', totalAmount: 1 });
  assert.deepEqual(q, { subtotal: 19500, discountAmount: 1500, totalAmount: 19000,
    deliveryFee: 1000, deliveryDate: '2026-10-26', currency: 'usd' });
  await assert.rejects(order(f, cart, { fulfillmentMethod: 'local_delivery', deliveryAddress: address,
    deliveryFee: 0, deliveryDate: '2001-01-01', totalAmount: 1 }), {
    code: 'failed-precondition',
    message: 'Delivery requires subscription checkout, which is not available yet.',
  });
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 0);
  assert.equal(f.sessions.length, 0);
  assert.equal(f.mails.length, 0);
  // The still-supported card path uses the same server-owned merchandise pricing.
  const o = await order(f, cart, { subtotal: 1, discountAmount: 999999, totalAmount: 1 });
  assert.equal(o.subtotal, q.subtotal);
  assert.equal(o.discountAmount, q.discountAmount);
  assert.equal(o.totalAmount + q.deliveryFee, q.totalAmount);
  assert.equal(f.payments[0].p.amount, o.totalAmount);
  await assert.rejects(f.api.getDeliveryQuote({ cart, address: { ...address, zip: '99999' } }), /area/i);
  f.records.get('settings/delivery').cutoffHours = 120;
  assert.equal((await f.api.getDeliveryQuote({ cart, address })).deliveryDate, '2026-11-02');
  f.records.get('settings/delivery').minimumJars = 7;
  await assert.rejects(f.api.getDeliveryQuote({ cart, address }), /minimum/i);
});

test('quotes price six through twelve jars of every canonical broth without enabling one-time delivery', async () => {
  for (const productId of ['prod_beef', 'prod_chicken', 'mushroom']) {
    const f = catalog();
    f.records.set('settings/delivery', deliveryPolicy());
    const before = structuredClone([...f.records]);
    for (let quantity = 6; quantity <= 12; quantity++) {
      const cart = { [productId]: quantity };
      const q = await f.api.getDeliveryQuote({ cart, address });
      const mushroom = productId === 'mushroom';
      assert.equal(q.subtotal, quantity * (mushroom ? 4000 : 2500));
      assert.equal(q.discountAmount, mushroom ? 0 : quantity * 500);
      assert.equal(q.deliveryFee, 1000);
      assert.equal(q.totalAmount, quantity * (mushroom ? 4000 : 2000) + 1000);
      await assert.rejects(order(f, cart, {
        fulfillmentMethod: 'local_delivery', deliveryAddress: address,
      }), { code: 'failed-precondition',
        message: 'Delivery requires subscription checkout, which is not available yet.' });
    }
    await assert.rejects(f.api.getDeliveryQuote({ cart: { [productId]: 13 }, address }),
      e => e.code === 'invalid-argument' && /maximum 12/i.test(e.message));
    assert.deepEqual([...f.records], before);
    assert.equal(f.payments.length, 0);
    assert.equal(f.sessions.length, 0);
    assert.equal(f.mails.length, 0);
  }
});

test('special orders remain awaiting approval without payment', async () => {
  const f = catalog();
  const r = await f.api.createPreorder({ ...base, fulfillmentMethod: 'special_order',
    paymentMethod: 'special_order', specialNotes: 'Please arrange a custom order.' });
  assert.equal(f.records.get(`orders/${r.orderId}`).status, 'awaiting_approval');
  assert.equal(f.payments.length, 0);
  assert.equal(f.sessions.length, 0);
});

test('historical pickup receipt and capability-protected retry remain available without new payment', async () => {
  const { createHash } = require('node:crypto');
  const f = catalog();
  const input = { requestId: base.requestId, cart: base.cart, customerName: base.customerName,
    customerEmail: base.customerEmail, customerUid: null, fulfillmentMethod: 'market_pickup',
    marketId: base.marketId, pickupDate: base.pickupDate, specialNotes: '', deliveryAddress: null,
    paymentMethod: 'pickup' };
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const orderId = hash(base.requestId);
  f.records.set(`orders/${orderId}`, { ...input, orderName: 'Historical pickup',
    fingerprint: hash(stable(input)), receiptTokenHash: hash(base.receiptToken),
    receiptExpiresAt: Date.parse('2026-11-20T12:00:00Z'), status: 'pending', totalAmount: 2500,
    emailState: 'pending', items: [{ productId: 'mushroom', name: 'Mushroom Broth', price: 2500,
      quantity: 1, itemTotal: 2500 }] });
  const before = structuredClone([...f.records]);
  const r = await f.api.createPreorder({ ...base, paymentMethod: 'pickup' });
  assert.equal(r.orderId, orderId);
  assert.equal((await f.api.getGuestReceipt({ orderId, token: base.receiptToken })).totalAmount, 2500);
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 0);
  await assert.rejects(f.api.createPreorder({ ...base, paymentMethod: 'pickup', receiptToken: 'b'.repeat(64) }),
    e => e.code === 'permission-denied');
});

async function order(f, cart, extra = {}) {
  const result = await f.api.createPaymentIntent({ ...base, cart, ...extra });
  return f.records.get(`orders/${result.orderId}`);
}

test('six total canonical jars trigger discounts on beef/chicken only, including renamed products', async () => {
  for (const [cart, subtotal, discount] of [
    [{ prod_beef: 5 }, 12500, 0],
    [{ prod_beef: 6 }, 15000, 3000],
    [{ prod_chicken: 6 }, 15000, 3000],
    [{ prod_beef: 2, prod_chicken: 1, mushroom: 3 }, 19500, 1500],
    [{ mushroom: 6 }, 24000, 0],
  ]) {
    const f = catalog();
    f.records.get('products/prod_beef').name = 'Renamed beef';
    const o = await order(f, cart);
    assert.equal(o.subtotal, subtotal);
    assert.equal(o.discountAmount, discount);
    assert.equal(o.totalAmount, subtotal - discount);
    assert.equal(f.payments[0].p.amount, o.totalAmount);
  }
});
