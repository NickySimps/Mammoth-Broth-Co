const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture, base } = require('./commerce-fixture.cjs');

const products = [
  { id: 'prod_beef', name: 'Renamed beef', price: 2500 },
  { id: 'prod_chicken', name: 'Renamed chicken', price: 2500 },
  { id: 'mushroom', name: 'Mushroom Broth', price: 4000 },
  { id: 'tea', name: 'Beef Chicken Mushroom Broth tea', price: 900 },
];
function client(promotion) {
  const source = fs.readFileSync(path.join(__dirname, '../store.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export (?=(?:const|async function|function)\b)/g, '');
  const context = vm.createContext({
    COMMERCE_APP_CHECK_SITE_KEY: '', console,
    initializeApp: () => ({}), getFirestore: () => ({}), getFunctions: () => ({}),
    getAuth: () => ({}), onAuthStateChanged: () => () => {},
    httpsCallable: () => async () => {}, doc: () => 'promotions',
    getDoc: async () => ({ exists: () => true, data: () => promotion }),
  });
  vm.runInContext(source, context);
  return context;
}
function server(promotion) {
  const f = fixture();
  for (const p of products) f.records.set(`products/${p.id}`, { name: p.name, priceCents: p.price });
  f.records.set('settings/promotions', promotion);
  return f;
}
async function priced(f, cart, extra = {}) {
  const result = await f.api.createPaymentIntent({ ...base, cart, ...extra });
  return f.records.get(`orders/${result.orderId}`);
}
const stale = { brothBundleEnabled: true, bundleMinimum: 4, bundlePriceCents: 2000 };

test('client fetched stale four-jar promotion cannot lower the mandatory six-jar floor', async () => {
  const c = client(stale);
  const promotion = await c.getPromotionConfig();
  const result = c.calculateCartTotal({ prod_beef: 4 }, products, promotion);
  assert.equal(result.discount, 0);
  assert.equal(result.total, 10000);
});

test('server stale four-jar promotion cannot lower the mandatory six-jar floor', async () => {
  const f = server(stale);
  const order = await priced(f, { prod_beef: 4 });
  assert.equal(order.discountAmount, 0);
  assert.equal(order.totalAmount, 10000);
  assert.equal(f.payments[0].p.amount, 10000);
});

test('client/server pricing parity for all valid configured thresholds and canonical mixed jars', async () => {
  const cases = [
    [{ prod_beef: 4 }, 10000, 2000, 4],
    [{ prod_beef: 5 }, 12500, 2500, 5],
    [{ prod_beef: 6 }, 15000, 3000, 6],
    [{ prod_chicken: 6 }, 15000, 3000, 6],
    [{ prod_beef: 2, prod_chicken: 1, mushroom: 3 }, 19500, 1500, 6],
    [{ mushroom: 6 }, 24000, 0, 6],
    [{ prod_beef: 1, mushroom: 4, tea: 1 }, 19400, 500, 5],
    [{ prod_beef: 12 }, 30000, 6000, 12],
  ];
  for (let bundleMinimum = 1; bundleMinimum <= 12; bundleMinimum++) {
    const promotion = { ...stale, bundleMinimum };
    const c = client(promotion);
    for (const [cart, subtotal, possibleDiscount, count] of cases) {
      const expectedDiscount = count >= 6 ? possibleDiscount : 0;
      const preview = c.calculateCartTotal(cart, products, await c.getPromotionConfig());
      const f = server(promotion);
      const order = await priced(f, cart, {
        promotion: { bundleMinimum: 1, bundlePriceCents: 1 },
        subtotal: 1, discountAmount: 999999, totalAmount: 1,
      });
      assert.deepEqual([preview.subtotal, preview.discount, preview.total, preview.brothCount],
        [subtotal, expectedDiscount, subtotal - expectedDiscount, count]);
      assert.deepEqual([order.subtotal, order.discountAmount, order.totalAmount],
        [preview.subtotal, preview.discount, preview.total]);
      assert.equal(f.payments[0].p.amount, preview.total);
      assert.equal(order.items.find(i => i.productId === 'mushroom')?.price,
        cart.mushroom ? 4000 : undefined);
    }
  }
});

test('malicious threshold/price settings never advertise savings or permit server writes', async () => {
  for (const promotion of [
    { bundleMinimum: 0 }, { bundleMinimum: -1 }, { bundleMinimum: 1.5 },
    { bundleMinimum: '4' }, { bundleMinimum: null }, { bundleMinimum: 13 },
    { bundleMinimum: Number.MAX_SAFE_INTEGER }, { bundleMinimum: Infinity },
    { bundleMinimum: NaN }, { bundleMinimum: true },
    { bundlePriceCents: -1 }, { bundlePriceCents: '1' }, { brothBundleEnabled: 'true' },
    { brothBundleEnabled: false, bundleMinimum: -1, bundlePriceCents: -1000 },
  ]) {
    const cart = { prod_beef: 6 };
    const preview = client(promotion).calculateCartTotal(cart, products, promotion);
    assert.equal(preview.discount, 0);
    assert.equal(preview.total, 15000);
    const f = server(promotion);
    const before = structuredClone([...f.records]);
    await assert.rejects(priced(f, cart), { code: 'failed-precondition' });
    assert.deepEqual([...f.records], before);
    assert.equal(f.payments.length, 0);
  }
});

test('fixed six/$20 policy overrides stale enabled, disabled and price settings for new orders', async () => {
  for (const brothBundleEnabled of [true, false]) {
    for (const bundlePriceCents of [1, 1500, 2000, 2500, 100000]) {
      const promotion = { brothBundleEnabled, bundleMinimum: 12, bundlePriceCents };
      const c = client(promotion);
      const fetched = await c.getPromotionConfig();
      for (let quantity = 1; quantity <= 12; quantity++) {
        // Mushroom contributes to eligibility but keeps its $40 catalog price.
        const cart = quantity === 1 ? { prod_beef: 1 }
          : { prod_beef: quantity - 1, mushroom: 1 };
        const subtotal = quantity === 1 ? 2500 : (quantity - 1) * 2500 + 4000;
        const discount = quantity >= 6 ? (quantity - 1) * 500 : 0;
        const preview = c.calculateCartTotal(cart, products, fetched);
        const f = server(promotion);
        const order = await priced(f, cart);
        assert.deepEqual([preview.subtotal, preview.discount, preview.total],
          [subtotal, discount, subtotal - discount], JSON.stringify({ promotion, quantity }));
        assert.deepEqual([order.subtotal, order.discountAmount, order.totalAmount],
          [subtotal, discount, subtotal - discount]);
        assert.equal(f.payments[0].p.amount, subtotal - discount);
      }
    }
  }
});

test('unchanged request retries preserve the stored pricing snapshot after policy/catalog changes', async () => {
  const f = server(stale);
  const cart = { prod_beef: 2, prod_chicken: 1, mushroom: 3 };
  const first = await f.api.createPaymentIntent({ ...base, cart });
  const saved = structuredClone(f.records.get(`orders/${first.orderId}`));
  f.records.set('settings/promotions', { bundleMinimum: 12, bundlePriceCents: 1 });
  f.records.get('products/mushroom').priceCents = 9000;
  const before = structuredClone([...f.records]);
  assert.deepEqual(await f.api.createPaymentIntent({ ...base, cart }), first);
  assert.deepEqual(f.records.get(`orders/${first.orderId}`), saved);
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 1);
});

test('stale disabled policy cannot change read-only delivery quotes or special-order intake pricing', async () => {
  const { deliveryPolicy } = require('./delivery-policy-fixture.cjs');
  const promotion = { brothBundleEnabled: false, bundleMinimum: 12, bundlePriceCents: 1 };
  const f = server(promotion);
  f.records.set('settings/delivery', deliveryPolicy());
  const cart = { prod_beef: 2, prod_chicken: 1, mushroom: 3 };
  const address = { street: '1 Main St', city: 'Jacksonville', state: 'FL', zip: '32204' };
  const before = structuredClone([...f.records]);
  const quote = await f.api.getDeliveryQuote({ cart, address });
  assert.deepEqual([quote.subtotal, quote.discountAmount, quote.totalAmount], [19500, 1500, 19000]);
  assert.deepEqual([...f.records], before, 'Quotes remain read-only');
  await assert.rejects(priced(f, cart, { fulfillmentMethod: 'local_delivery', deliveryAddress: address }),
    { code: 'failed-precondition', message: 'Delivery requires subscription checkout, which is not available yet.' });
  assert.deepEqual([...f.records], before, 'Pricing changes must not enable delivery checkout');
  const result = await f.api.createPreorder({ ...base, cart, fulfillmentMethod: 'special_order',
    paymentMethod: 'special_order', specialNotes: 'Please arrange a custom batch.' });
  const order = f.records.get(`orders/${result.orderId}`);
  assert.deepEqual([order.subtotal, order.discountAmount, order.totalAmount], [19500, 1500, 18000]);
  assert.equal(order.status, 'awaiting_approval');
  assert.equal(f.payments.length, 0);
  assert.equal(f.sessions.length, 0);
});

test('historical four-jar discounted snapshots are not repriced by a capability-protected retry', async () => {
  const f = server(stale);
  const cart = { prod_beef: 4 };
  const result = await f.api.createPaymentIntent({ ...base, cart });
  // Seed the historical snapshot produced by the old four-jar policy.
  const historical = f.records.get(`orders/${result.orderId}`);
  historical.discountAmount = 2000;
  historical.totalAmount = 8000;
  const before = structuredClone([...f.records]);
  const retry = await f.api.createPaymentIntent({ ...base, cart });
  assert.equal(retry.totalAmount, 8000);
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 1);
});
