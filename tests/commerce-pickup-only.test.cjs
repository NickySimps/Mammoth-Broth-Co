const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fixture, base, admin } = require('./commerce-fixture.cjs');
const digest = x => createHash('sha256').update(x).digest('hex');
function setup() {
  const f = fixture();
  f.records.set('products/prod_beef', { name: 'Beef', priceCents: 2500 });
  f.records.set('products/prod_chicken', { name: 'Chicken', priceCents: 2500 });
  f.records.set('products/mushroom', { name: 'Mushroom Broth', priceCents: 4000 });
  return f;
}
const orderCount = f => [...f.records.keys()].filter(k => k.startsWith('orders/')).length;
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function historical(f, fulfillmentMethod = 'local_delivery', paymentMethod = 'stripe') {
  const input = { requestId: base.requestId, cart: { mushroom: 1 }, customerName: base.customerName,
    customerEmail: base.customerEmail, customerUid: null, fulfillmentMethod, marketId: null, pickupDate: null,
    specialNotes: fulfillmentMethod === 'special_order' ? 'Historical special notes' : '',
    deliveryAddress: fulfillmentMethod === 'local_delivery' ? { street: '1 Main', city: 'Jax', state: 'FL', zip: '32202' } : null,
    paymentMethod };
  const orderId = digest(input.requestId);
  const order = { ...input, fingerprint: digest(stable(input)), orderName: 'Historical',
    status: paymentMethod === 'stripe' ? 'awaiting_payment' : 'awaiting_approval',
    receiptTokenHash: digest(base.receiptToken), receiptExpiresAt: Date.parse('2026-11-01T12:00:00Z'),
    createdAt: Date.parse('2026-10-22T12:00:00Z'), paymentBinding: 'old-binding', paymentIntentId: null,
    items: [{ productId: 'old_catalog_id', name: 'Historical item', price: 3100, quantity: 1, itemTotal: 3100 }],
    subtotal: 3100, discountAmount: 0, deliveryFee: 500, totalAmount: 3600, currency: 'usd',
    emailVersion: 0, emailSentVersion: 0, emailState: 'none' };
  f.records.set(`orders/${orderId}`, order);
  return { orderId, order, payload: { ...input, receiptToken: base.receiptToken } };
}

test('historical delivery without bound intent cannot start new provider work', async () => {
  const f = setup();
  const { payload, orderId } = historical(f);
  const before = structuredClone(f.records.get(`orders/${orderId}`));
  await assert.rejects(f.api.createPaymentIntent(payload), /pickup|reconcil/i);
  assert.equal(f.payments.length, 0);
  assert.deepEqual(f.records.get(`orders/${orderId}`), before);
});

test('six total mixed jars discounts only trusted beef/chicken IDs to $20; mushroom stays catalog priced', async () => {
  for (const [cart, expected] of [
    [{ prod_beef: 3, prod_chicken: 2 }, 12500],
    [{ prod_beef: 3, prod_chicken: 2, mushroom: 1 }, 14000],
    [{ prod_beef: 1, mushroom: 5 }, 22000],
    [{ mushroom: 6 }, 24000],
    [{ prod_beef: 7 }, 14000],
    [{ prod_beef: 1 }, 2500],
    [{ prod_chicken: 6 }, 12000],
    [{ prod_beef: 6, mushroom: 6 }, 36000],
  ]) {
    const f = setup();
    f.records.set('settings/promotions', { brothBundleEnabled: false, bundleMinimum: 1, bundlePriceCents: 1 });
    const result = await f.api.createPaymentIntent({ ...base, cart, totalAmount: 1, discountAmount: 999999, priceCents: 1, status: 'paid' });
    const order = f.records.get(`orders/${result.orderId}`);
    assert.equal(order.totalAmount, expected);
    assert.equal(f.payments[0].p.amount, expected);
    assert.equal(order.status, 'awaiting_payment');
    assert.equal(order.deliveryFee, 0);
    assert.equal(order.deliveryDate, null);
    assert.equal(order.subtotal - order.discountAmount, expected);
    assert.equal(order.items.find(i => i.productId === 'mushroom')?.price, cart.mushroom ? 4000 : undefined);
  }
  const f = setup();
  f.records.set('products/forged', { name: 'Beef Broth', priceCents: 1 });
  await assert.rejects(f.api.createPaymentIntent({ ...base, cart: { forged: 6 } }), /product|catalog/i);
  assert.equal(orderCount(f), 0);
});

test('explicit market schedules accept only the next future disclosed date in the market timezone', async () => {
  const f = setup();
  Object.assign(f.records.get('markets/atlantic'), { pickupDates: ['2026-11-01', '2026-10-25', '2026-10-18'] });
  await assert.rejects(f.api.createPreorder({ ...base, pickupDate: '2026-11-01', paymentMethod: 'pickup' }), /next|occurrence/i);
  assert.equal(orderCount(f), 0);
  await f.api.createPreorder({ ...base, paymentMethod: 'pickup' });
  const local = setup();
  local.setNow('2026-10-25T02:00:00Z'); // Still Saturday in New York.
  await local.api.createPreorder({ ...base, paymentMethod: 'pickup' });
  const sameDay = setup();
  sameDay.setNow('2026-10-25T04:00:00Z');
  await assert.rejects(sameDay.api.createPreorder({ ...base, paymentMethod: 'pickup' }), /future/i);
});

test('new delivery and special requests fail closed before persistence or provider work', async () => {
  for (const fulfillmentMethod of ['local_delivery', 'special_order']) {
    for (const method of ['createPaymentIntent', 'createPreorder']) {
      const f = setup();
      f.records.set('settings/delivery', { enabled: true, allowedZips: ['32202'], state: 'FL', feeCents: 0, minimumJars: 5, cutoffHours: 0 });
      await assert.rejects(f.api[method]({ ...base, cart: { mushroom: 5 }, fulfillmentMethod,
        paymentMethod: fulfillmentMethod === 'special_order' ? 'special_order' : 'pickup',
        specialNotes: 'Historical notes here', deliveryAddress: { street: '1 Main', city: 'Jax', state: 'FL', zip: '32202' } }), /pickup|approval/i);
      assert.equal(orderCount(f), 0);
      assert.equal(f.payments.length + f.sessions.length, 0);
    }
  }
  const f = setup();
  await assert.rejects(f.api.getDeliveryQuote({ cart: { mushroom: 5 }, address: { street: '1 Main', city: 'Jax', state: 'FL', zip: '32202' } }), /pickup|delivery/i);
});

test('retained public delivery quote callable refuses every payload before policy, catalog or provider reads', async () => {
  const { load } = require('./commerce-vm-fixture.cjs');
  for (const enabled of [false, true]) {
    const f = load(enabled);
    f.records.set('settings/delivery', {
      enabled: true, allowedZips: ['32202'], state: 'FL', feeCents: 0, minimumJars: 1, cutoffHours: 0,
    });
    const before = structuredClone([...f.records]);
    let reads = 0;
    const forbidden = () => { reads++; throw Error('Unexpected quote dependency access'); };
    f.db.collection = forbidden;
    f.db.runTransaction = forbidden;
    f.stripe.paymentIntents.create = forbidden;
    f.stripe.checkout.sessions.create = forbidden;
    const hostile = new Proxy({}, { get: forbidden, ownKeys: forbidden });
    assert.equal(typeof f.handlers.getDeliveryQuote, 'function', 'Keep the deployed endpoint exported');
    for (const payload of [undefined, null, [], {}, hostile, {
      cart: { mushroom: 6 }, address: { street: '1 Main', city: 'Jax', state: 'FL', zip: '32202' },
    }]) {
      await assert.rejects(f.handlers.getDeliveryQuote(payload, { app: undefined }), e =>
        e.code === 'failed-precondition' && /market pickup/i.test(e.message));
    }
    assert.equal(reads, 0);
    assert.deepEqual([...f.records], before);
    assert.equal(f.payments.length + f.sessions.length + f.mails.length, 0);
  }
});

test('new orders ignore missing, disabled, malformed and unreadable promotion settings for both payment choices', async () => {
  const policies = [undefined, null, [], false, 'true', {}, { brothBundleEnabled: false },
    { brothBundleEnabled: 'false', bundleMinimum: '6', bundlePriceCents: '2000' },
    { brothBundleEnabled: true, bundleMinimum: 1, bundlePriceCents: 1 },
    { brothBundleEnabled: false, bundleMinimum: NaN, bundlePriceCents: Infinity },
    { brothBundleEnabled: true, bundleMinimum: -1, bundlePriceCents: -1 },
    { brothBundleEnabled: true, bundleMinimum: 12, bundlePriceCents: 100001 }];
  for (const policy of policies) {
    for (const method of ['createPreorder', 'createPaymentIntent']) {
      const f = setup();
      if (policy === undefined) f.records.delete('settings/promotions');
      else f.records.set('settings/promotions', policy);
      const read = f.records.get.bind(f.records);
      f.records.get = key => {
        assert.notEqual(key, 'settings/promotions', 'Fixed pickup pricing must not depend on mutable settings');
        return read(key);
      };
      const result = await f.api[method]({ ...base, paymentMethod: 'pickup',
        cart: { prod_beef: 3, prod_chicken: 2, mushroom: 1 }, discountAmount: 999999, totalAmount: 1 });
      const order = f.records.get(`orders/${result.orderId}`);
      assert.equal(order.subtotal, 16500);
      assert.equal(order.discountAmount, 2500);
      assert.equal(order.totalAmount, 14000);
      assert.equal(order.items.find(i => i.productId === 'mushroom').price, 4000);
      assert.equal(f.payments.length, method === 'createPaymentIntent' ? 1 : 0);
      if (f.payments.length) assert.equal(f.payments[0].p.amount, 14000);
    }
  }
});

test('bundled pickup replay preserves stored pricing snapshots after settings and catalog changes', async () => {
  for (const method of ['createPreorder', 'createPaymentIntent']) {
    const f = setup();
    const payload = { ...base, paymentMethod: 'pickup', cart: { prod_beef: 5, mushroom: 1 } };
    const result = await f.api[method](payload);
    const before = structuredClone(f.records.get(`orders/${result.orderId}`));
    f.records.set('settings/promotions', { brothBundleEnabled: false, bundlePriceCents: 1 });
    f.records.delete('products/prod_beef');
    f.records.get('products/mushroom').priceCents = 1;
    const read = f.records.get.bind(f.records);
    f.records.get = key => {
      assert.ok(!key.startsWith('products/') && key !== 'settings/promotions', 'Replay cannot reprice');
      return read(key);
    };
    await f.api[method](payload);
    assert.deepEqual(f.records.get(`orders/${result.orderId}`), before);
    const receipt = await f.api.getGuestReceipt({ orderId: result.orderId, token: base.receiptToken });
    assert.equal(receipt.totalAmount, 14000);
    assert.equal(receipt.discountAmount, 2500);
    assert.equal(f.payments.length, method === 'createPaymentIntent' ? 1 : 0);
  }
});

function paidEvent(orderId, order, id = 'evt_pickup') {
  return { id, type: 'payment_intent.succeeded', data: { object: {
    id: order.paymentIntentId || 'pi_historical', status: 'succeeded', amount: order.totalAmount,
    amount_received: order.totalAmount, currency: order.currency,
    metadata: { orderId, binding: order.paymentBinding },
  } } };
}

test('pay at market persists pending/unpaid mixed bundle, reserves once and refuses forged payment', async () => {
  const f = setup();
  Object.assign(f.records.get('markets/atlantic'), { capacity: 1, occurrenceDate: base.pickupDate, reservedCount: 0 });
  const payload = { ...base, cart: { prod_beef: 5, mushroom: 1 }, paymentMethod: 'pickup', status: 'paid', totalAmount: 1 };
  const r = await f.api.createPreorder(payload);
  assert.equal(r.marketName, 'Atlantic', 'confirmation must use the market name from the server-owned market record');
  assert.equal(r.pickupDate, base.pickupDate, 'confirmation must use the server-accepted pickup date');
  const o = f.records.get(`orders/${r.orderId}`);
  assert.equal(o.status, 'pending');
  assert.equal(o.paymentMethod, 'pickup');
  assert.equal(o.paymentIntentId, null);
  assert.equal(o.totalAmount, 14000);
  assert.equal(o.paidAt, undefined);
  assert.equal(f.payments.length, 0);
  assert.equal(f.records.get('markets/atlantic').reservedCount, 1);
  await f.api.createPreorder(payload);
  assert.equal(f.records.get('markets/atlantic').reservedCount, 1);
  await assert.rejects(f.api.createPreorder({ ...payload, requestId: 'second-request-123456' }), /full/i);
  await assert.rejects(f.api.createPreorder({ ...payload, paymentIntentId: 'pi_forged' }), /payment/i);
  await assert.rejects(f.api.processStripeEvent(paidEvent(r.orderId, o)), /state/i);
  assert.equal(f.records.get(`orders/${r.orderId}`).status, 'pending');
  await f.api.deliverOrderEmail({ orderId: r.orderId });
  assert.equal(f.mails.length, 2);
  assert.match(f.mails[0].text, /payment is due at pickup/i);
});

test('online pickup uses bound payment intent and only matching webhook confirms payment once', async () => {
  const f = setup();
  Object.assign(f.records.get('markets/atlantic'), { capacity: 1, occurrenceDate: base.pickupDate, reservedCount: 0 });
  const r = await f.api.createPaymentIntent({ ...base, cart: { prod_chicken: 5, mushroom: 1 } });
  assert.equal(r.marketName, 'Atlantic', 'online receipt redirect must retain the authoritative market name');
  assert.equal(r.pickupDate, base.pickupDate, 'online receipt redirect must retain the server-accepted pickup date');
  const o = f.records.get(`orders/${r.orderId}`);
  assert.equal(o.totalAmount, 14000);
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(f.records.get('markets/atlantic').reservedCount, 0);
  assert.equal(f.payments[0].p.amount, 14000);
  assert.equal(f.payments[0].p.currency, 'usd');
  assert.deepEqual(f.payments[0].p.metadata, { orderId: r.orderId, binding: o.paymentBinding });
  assert.equal(f.payments[0].o.idempotencyKey, `order-${r.orderId}`);
  const event = paidEvent(r.orderId, o);
  await assert.rejects(f.api.processStripeEvent({ ...event, data: { object: { ...event.data.object, amount_received: 1 } } }), /mismatch/i);
  await f.api.processStripeEvent(event);
  await f.api.processStripeEvent(event);
  await f.api.processStripeEvent({ ...event, id: 'evt_second_paid' });
  assert.equal(f.records.get(`orders/${r.orderId}`).status, 'paid');
  assert.equal(f.records.get('markets/atlantic').reservedCount, 1);
  assert.equal(f.payments.length, 1);
});

test('paid online order routes to reconciliation when occurrence is full or no longer valid', async () => {
  for (const change of [
    m => Object.assign(m, { capacity: 1, reservedCount: 1, occurrenceDate: base.pickupDate }),
    m => { m.active = false; },
    m => { m.pickupDates = ['2026-11-01']; },
  ]) {
    const f = setup();
    const r = await f.api.createPaymentIntent(base);
    const o = f.records.get(`orders/${r.orderId}`);
    change(f.records.get('markets/atlantic'));
    const result = await f.api.processStripeEvent(paidEvent(r.orderId, o));
    assert.equal(result.status, 'paid_requires_review');
    assert.equal(f.records.get(`orders/${r.orderId}`).reconciliationRequired, true);
    await f.api.deliverOrderEmail({ orderId: r.orderId });
    assert.match(f.mails[0].text, /no pickup is confirmed/i);
  }
});

test('historical bound delivery retries and receipts stay immutable, capability protected and reconcilable', async () => {
  const f = setup();
  const { payload, order, orderId } = historical(f);
  order.paymentIntentId = 'pi_historical';
  order.clientSecret = 'historical_fixture_secret';
  const before = structuredClone(order);
  const result = await f.api.createPaymentIntent(payload, { app: undefined });
  assert.equal(result.clientSecret, 'historical_fixture_secret');
  assert.equal(result.totalAmount, 3600);
  assert.equal(f.payments.length, 0);
  assert.deepEqual(f.records.get(`orders/${orderId}`), before);
  const receipt = await f.api.getGuestReceipt({ orderId, token: base.receiptToken });
  assert.equal(receipt.totalAmount, 3600);
  assert.equal(receipt.items[0].productId, 'old_catalog_id');
  assert.equal(receipt.customerEmail, undefined);
  assert.equal(receipt.clientSecret, undefined);
  assert.equal(receipt.receiptTokenHash, undefined);
  await assert.rejects(f.api.createPaymentIntent({ ...payload, receiptToken: 'b'.repeat(64) }), e => e.code === 'permission-denied');
  await assert.rejects(f.api.createPaymentIntent({ ...payload, cart: { mushroom: 2 } }), /conflict/i);
  await f.api.processStripeEvent(paidEvent(orderId, order));
  assert.equal(f.records.get(`orders/${orderId}`).status, 'paid');
  await f.api.revokeGuestReceipt({ orderId }, admin);
  await assert.rejects(f.api.getGuestReceipt({ orderId, token: base.receiptToken }), e => e.code === 'permission-denied');
  await assert.rejects(f.api.createPaymentIntent(payload), e => e.code === 'permission-denied');
});

test('historical unpaid special order keeps authorized replay and frozen owner checkout recovery', async () => {
  const f = setup();
  const { payload, orderId } = historical(f, 'special_order', 'special_order');
  const before = structuredClone(f.records.get(`orders/${orderId}`));
  await f.api.createPreorder(payload, { app: undefined });
  assert.deepEqual(f.records.get(`orders/${orderId}`), before);
  await assert.rejects(f.api.reviewSpecialOrder({ orderId, decision: 'decline' }), /admin|owner/i);
  const terms = { orderId, decision: 'approve', items: [{ productId: 'historical_custom', name: 'Custom', quantity: 1, price: 3100 }], totalAmount: 3100 };
  const r = await f.api.reviewSpecialOrder(terms, admin);
  assert.equal(r.status, 'awaiting_payment');
  assert.equal(f.sessions.length, 1);
  await f.api.resumePaymentSetup({ orderId }, admin);
  assert.equal(f.sessions.length, 1);
  const o = f.records.get(`orders/${orderId}`);
  await f.api.processStripeEvent({ id: 'evt_historical_checkout', type: 'checkout.session.completed', data: { object: {
    id: o.checkoutSessionId, mode: 'payment', payment_intent: 'pi_special_history', payment_status: 'paid',
    amount_total: o.totalAmount, currency: 'usd', metadata: { orderId, binding: o.paymentBinding },
  } } });
  assert.equal(f.records.get(`orders/${orderId}`).status, 'paid');
});

test('pickup idempotency freezes cart, customer identity, date and payment choice without repricing', async () => {
  const f = setup();
  const payload = { ...base, paymentMethod: 'pickup' };
  const context = { auth: { uid: 'buyer' } };
  const r = await f.api.createPreorder(payload, context);
  const before = structuredClone(f.records.get(`orders/${r.orderId}`));
  f.records.get('products/mushroom').priceCents = 1;
  f.records.get('markets/atlantic').active = false;
  await f.api.createPreorder(payload, { ...context, app: undefined });
  assert.deepEqual(f.records.get(`orders/${r.orderId}`), before);
  for (const mutation of [{ cart: { mushroom: 2 } }, { pickupDate: '2026-11-01' }, { customerEmail: 'other@example.com' }])
    await assert.rejects(f.api.createPreorder({ ...payload, ...mutation }, context), /conflict/i);
  await assert.rejects(f.api.createPaymentIntent(payload, context), /conflict/i);
  await assert.rejects(f.api.createPreorder(payload, { auth: { uid: 'other' } }), /conflict/i);
  for (const token of ['b'.repeat(64), undefined])
    await assert.rejects(f.api.createPreorder({ ...payload, receiptToken: token }, context), e => ['permission-denied', 'invalid-argument'].includes(e.code));
  f.records.get(`orders/${r.orderId}`).receiptExpiresAt = 0;
  await assert.rejects(f.api.createPreorder(payload, context), e => e.code === 'permission-denied');
  assert.equal(f.payments.length, 0);
});

test('pickup validation and App Check remain fail-closed before order or provider creation', async () => {
  for (const mutation of [
    { cart: { mushroom: 13 } }, { cart: { mushroom: 0 } }, { cart: { mushroom: 1.5 } },
    { pickupDate: '2026-02-31' }, { pickupDate: '2026-11-01' }, { fulfillmentMethod: 'subscription' },
  ]) {
    const f = setup();
    await assert.rejects(f.api.createPaymentIntent({ ...base, ...mutation }));
    assert.equal(orderCount(f), 0);
    assert.equal(f.payments.length, 0);
  }
  for (const method of ['createPreorder', 'createPaymentIntent']) {
    const f = setup();
    await assert.rejects(f.api[method]({ ...base, paymentMethod: 'pickup', app: { appId: 'forged' } }, { app: undefined }), e => e.code === 'unauthenticated');
    assert.equal(orderCount(f), 0);
  }
});
