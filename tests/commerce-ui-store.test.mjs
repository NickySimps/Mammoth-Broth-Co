import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('store exposes server commerce callables and fail-closed public delivery policy read', async () => {
  const calls = [];
  const context = vm.createContext({ initializeApp: () => ({}), getFirestore: () => ({}), getFunctions: () => ({}), getAuth: () => ({}), onAuthStateChanged: (auth, callback) => { setImmediate(callback); return () => {}; },
    httpsCallable: (functions, name) => async data => { calls.push({ name, data }); return { data: { status: 'test' } }; },
    doc: (db, ...path) => path.join('/'), getDoc: async ref => { calls.push({ ref }); return { exists: () => false }; }, console
  });
  const source = (await readFile(new URL('../store.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
  assert.equal(typeof context.getDeliveryPolicy, 'function');
  assert.equal(await context.getDeliveryPolicy(), null);
  for (const name of ['getDeliveryQuote', 'reviewSpecialOrder', 'retryOrderEmail', 'getGuestReceipt']) {
    assert.equal(typeof context[name], 'function', name);
    await context[name]({ orderId: 'order' });
    assert.equal(calls.at(-1).name, name);
  }
  assert.ok(calls.some(call => call.ref === 'settings/delivery'));
});
