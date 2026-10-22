import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../store.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/export (?=(?:const|async function|function)\b)/g, '');

function loadStore({ denied = false, promotion, promotionDenied = false } = {}) {
  const requests = [];
  let restoreAuth;
  const context = vm.createContext({
    COMMERCE_APP_CHECK_SITE_KEY: '6L' + 'a'.repeat(38),
    initializeAppCheck: () => ({}), ReCaptchaEnterpriseProvider: class {}, getToken: async () => ({ token: 'test-attestation' }),
    console: { error() {}, warn() {} },
    initializeApp: () => ({}), getFirestore: () => ({}), getFunctions: () => ({}),
    getAuth: () => ({ currentUser: null }),
    onAuthStateChanged: (auth, callback) => { restoreAuth = callback; return () => {}; },
    httpsCallable: (functions, name) => async data => { requests.push({ name, data }); return { data: { orderId: 'test-order' } }; }, collection: (db, name) => name,
    doc: (_db, _collection, id) => id,
    getDoc: async () => { if (promotionDenied) throw new Error('offline'); return { exists: () => true, data: () => promotion }; },
    getDocs: async name => {
      if (denied) throw new Error('Missing or insufficient permissions.');
      const records = name === 'products'
        ? [{ id: 'prod_beef', name: 'Beef Broth', price: 2500 }, { id: 'prod_chicken', name: 'Chicken Broth', price: 2500 }]
        : [{ id: 'market_atlantic', name: 'Atlantic Beach' }];
      return { docs: records.map(record => ({ id: record.id, data: () => record })) };
    }
  });
  vm.runInContext(source, context);
  context.requests = requests;
  context.restoreAuth = user => restoreAuth(user);
  return context;
}

const store = loadStore();
const products = await store.getProducts();
assert.deepEqual(Array.from(products, product => product.id), ['prod_beef', 'prod_chicken'], 'Never inject a product that has no server catalog document');
assert.equal(products[0].price, 2500);
const pending = vm.runInContext('createPreorder({ cart: { prod_beef: 1 } })', store);
await Promise.resolve();
assert.equal(store.requests.length, 0, 'Checkout must await restored Firebase auth before sending the callable request');
store.restoreAuth(null);
await pending;
assert.equal(store.requests.length, 1, 'Guest checkout remains supported after auth restoration');
const denied = loadStore({ denied: true });
await assert.rejects(denied.getProducts(), /permissions/, 'Permission failures must not fabricate purchasable products');
await assert.rejects(denied.getMarkets(), /permissions/, 'Permission failures must not fabricate pickup markets');
const cheapBroth = [{ id: 'beef', name: 'Beef Broth', price: 1500 }];
const cheapTotal = store.calculateCartTotal({ beef: 4 }, cheapBroth, { brothBundleEnabled: true, bundleMinimum: 4, bundlePriceCents: 2000 });
assert.equal(cheapTotal.total, 6000, 'A bundle must never increase catalog price');
assert.equal(cheapTotal.discount, 0);
for (const promotion of [null, [], { brothBundleEnabled: 'false' }, { bundleMinimum: 0 }, { bundleMinimum: 13 }, { bundleMinimum: 2.5 }, { bundleMinimum: '4' }, { bundlePriceCents: 0 }, { bundlePriceCents: '2000' }, { bundlePriceCents: NaN }]) {
  const total = store.calculateCartTotal({ prod_beef: 4 }, products, promotion);
  assert.equal(total.total, 10000, `Malformed policy must use catalog price: ${JSON.stringify(promotion)}`);
  assert.equal(total.discount, 0);
}
const unavailablePromotion = await loadStore({ promotionDenied: true }).getPromotionConfig();
assert.equal(store.calculateCartTotal({ prod_beef: 4 }, products, unavailablePromotion).discount, 0, 'Unreadable promotion cannot advertise guessed savings');
for (const promotion of [null, [], { bundleMinimum: null }]) {
  const fetched = await loadStore({ promotion }).getPromotionConfig();
  assert.equal(store.calculateCartTotal({ prod_beef: 4 }, products, fetched).discount, 0);
}
console.log('server-authoritative catalog regression tests passed');
