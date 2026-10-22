import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../store.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/export (?=(?:const|async function|function)\b)/g, '');

function loadStore({ denied = false } = {}) {
  const requests = [];
  let restoreAuth;
  const context = vm.createContext({
    console: { error() {}, warn() {} },
    initializeApp: () => ({}), getFirestore: () => ({}), getFunctions: () => ({}),
    getAuth: () => ({ currentUser: null }),
    onAuthStateChanged: (auth, callback) => { restoreAuth = callback; return () => {}; },
    httpsCallable: (functions, name) => async data => { requests.push({ name, data }); return { data: { orderId: 'test-order' } }; }, collection: (db, name) => name,
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
console.log('server-authoritative catalog regression tests passed');
