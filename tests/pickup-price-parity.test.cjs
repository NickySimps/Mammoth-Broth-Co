'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture, base } = require('./commerce-fixture.cjs');

// Exercise the actual browser pricing function, not a duplicated test algorithm.
// All Firebase boundaries below are offline fixtures; no live order/provider calls.
const browserSource = readFileSync(path.join(__dirname, '../store.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/export (?=(?:const|async function|function)\b)/g, '');
function browserStore(products, setting) {
  const context = vm.createContext({
    COMMERCE_APP_CHECK_SITE_KEY: '', console: { warn() {}, error() {} },
    initializeApp: () => ({}), getFirestore: () => ({}), getAuth: () => ({}),
    getFunctions: () => ({}), onAuthStateChanged: () => () => {},
    httpsCallable: () => async () => { throw Error('No network allowed'); },
    collection: (_db, name) => name, doc: (_db, name, id) => `${name}/${id}`,
    getDocs: async () => ({ docs: products.map(({ id, ...data }) => ({ id, data: () => data })) }),
    getDoc: async () => {
      if (setting.denied) throw Error('permission-denied');
      return { exists: () => setting.exists !== false, data: () => setting.value };
    },
  });
  vm.runInContext(browserSource, context);
  return context;
}
const ids = ['prod_beef', 'prod_chicken', 'mushroom'];
const sortedItems = items => JSON.parse(JSON.stringify(items)).sort((a, b) => a.productId.localeCompare(b.productId));
const mixes = [];
for (let beef = 0; beef <= 12; beef++) {
  for (let chicken = 0; chicken <= 12 - beef; chicken++) {
    for (let mushroom = 0; mushroom <= 12 - beef - chicken; mushroom++) {
      if (beef + chicken + mushroom) {
        mixes.push(Object.fromEntries(Object.entries({ prod_beef: beef, prod_chicken: chicken, mushroom })
          .filter(([, q]) => q)));
      }
    }
  }
}

const settings = [
  { exists: false }, { denied: true },
  ...[{}, null, [], false, 'false', { brothBundleEnabled: false },
    { brothBundleEnabled: true, bundleMinimum: 1, bundlePriceCents: 1 },
    { brothBundleEnabled: false, bundleMinimum: 12, bundlePriceCents: 100001 },
    { brothBundleEnabled: 'true', bundleMinimum: '6', bundlePriceCents: '2000' },
    { brothBundleEnabled: null, bundleMinimum: NaN, bundlePriceCents: Infinity },
    { brothBundleEnabled: true, bundleMinimum: -1, bundlePriceCents: -1 },
  ].map(value => ({ value })),
];
const catalogs = [
  [2500, 2500, 4000], // Approved storefront catalog.
  [1500, 3100, 4200], // Never increase a cheaper jar; mushroom remains catalog-priced.
].map(prices => ids.map((id, index) => ({
  id, name: 'Renamed seasonal jar', priceCents: prices[index], price: 1,
})));

for (const [catalogIndex, products] of catalogs.entries()) {
  test(`exact server/client parity for all 1–12 jar mixes, legacy settings and payment choices (catalog ${catalogIndex})`, async t => {
    assert.equal(mixes.length, 454);
    let comparisons = 0;
    for (const setting of settings) {
      const store = browserStore(products, setting);
      const catalog = await store.getProducts();
      const promotion = await store.getPromotionConfig();
      for (const cart of mixes) {
        const count = Object.values(cart).reduce((sum, q) => sum + q, 0);
        const expectedSubtotal = products.reduce((sum, p) => sum + (cart[p.id] || 0) * p.priceCents, 0);
        const expectedDiscount = count < 6 ? 0 : products.reduce((sum, p) => sum +
          (p.id === 'mushroom' ? 0 : Math.max(0, p.priceCents - 2000) * (cart[p.id] || 0)), 0);
        const before = JSON.stringify({ cart, catalog, promotion });
        const display = store.calculateCartTotal(cart, catalog, promotion);
        assert.equal(display.subtotal, expectedSubtotal);
        assert.equal(display.discount, expectedDiscount);
        assert.equal(display.total, expectedSubtotal - expectedDiscount);
        assert.equal(display.brothCount, count);
        for (const method of ['createPreorder', 'createPaymentIntent']) {
          const f = fixture();
          for (const { id, ...data } of products) f.records.set(`products/${id}`, data);
          if (setting.exists === false || setting.denied) f.records.delete('settings/promotions');
          else f.records.set('settings/promotions', setting.value);
          const read = f.records.get.bind(f.records);
          f.records.get = key => {
            assert.notEqual(key, 'settings/promotions', 'New pricing cannot depend on settings reads');
            return read(key);
          };
          const result = await f.api[method]({ ...base, cart, paymentMethod: 'pickup',
            subtotal: 1, totalAmount: 1, discountAmount: 999999 });
          const order = f.records.get(`orders/${result.orderId}`);
          const label = JSON.stringify({ cart, setting, method, catalogIndex });
          assert.equal(order.subtotal, display.subtotal, label);
          assert.equal(order.discountAmount, display.discount, label);
          assert.equal(order.totalAmount, display.total, label);
          assert.equal(order.deliveryFee, 0, label);
          assert.equal(order.deliveryDate, null, label);
          assert.deepEqual(sortedItems(order.items), sortedItems(display.items), label);
          if (method === 'createPaymentIntent') {
            assert.equal(f.payments.length, 1, label);
            assert.equal(f.payments[0].p.amount, display.total, label);
          } else {
            assert.equal(f.payments.length, 0, label);
            assert.equal(order.status, 'pending', label);
          }
          comparisons++;
        }
        assert.equal(JSON.stringify({ cart, catalog, promotion }), before, 'Inputs remain immutable');
      }
    }
    assert.equal(comparisons, mixes.length * settings.length * 2);
    t.diagnostic(`${comparisons} exact persisted-order/client comparisons; offline fixture only`);
  });
}
