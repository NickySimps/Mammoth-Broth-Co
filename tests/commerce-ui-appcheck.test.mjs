import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function harness({ key = '', initFailure = false, tokenFailure = false } = {}) {
  const events = []; const app = {}; const appCheck = {};
  const source = (await readFile(new URL('../store.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ COMMERCE_APP_CHECK_SITE_KEY: key,
    initializeApp: () => app,
    ReCaptchaEnterpriseProvider: class { constructor(siteKey) { this.siteKey = siteKey; } },
    initializeAppCheck: (sameApp, options) => { events.push({ type: 'init', sameApp, options }); if (initFailure) throw new Error('private SDK failure'); return appCheck; },
    getToken: async instance => { assert.equal(instance, appCheck); events.push({ type: 'token' }); if (tokenFailure) throw new Error('private SDK failure'); return { token: 'sdk-attestation' }; },
    getFirestore: sameApp => { assert.equal(sameApp, app); events.push({ type: 'firestore' }); return {}; }, getFunctions: sameApp => { assert.equal(sameApp, app); events.push({ type: 'functions' }); return {}; }, getAuth: () => ({}), onAuthStateChanged: (auth, callback) => { setImmediate(callback); return () => {}; },
    httpsCallable: (functions, name) => { events.push({ type: 'bind', name }); return async data => { events.push({ type: 'call', name, data }); return { data: { status: 'test' } }; }; },
    collection: () => ({}), getDocs: async () => ({ docs: [] }), console
  });
  vm.runInContext(source, context);
  return { context, events, app };
}

test('public App Check default is explicitly disabled with no debug bypass', async () => {
  const config = await import('../commerce-config.mjs').catch(() => ({}));
  assert.equal(config.COMMERCE_APP_CHECK_SITE_KEY, '');
  const source = await readFile(new URL('../store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /FIREBASE_APPCHECK_DEBUG_TOKEN/);
  assert.match(source, /firebasejs\/9\.6\.1\/firebase-app-check\.js/);
});

test('creation fails closed without an owner site key, while catalog and receipts remain usable', async () => {
  for (const key of ['', 'YOUR_SITE_KEY', 'invalid key']) {
    const h = await harness({ key });
    for (const name of ['createPreorder', 'createPaymentIntent']) await assert.rejects(h.context[name]({ receiptToken: 'private-proof' }), /App Check.*not configured|ordering.*unavailable/i);
    assert.deepEqual(Array.from(await h.context.getProducts()), []);
    await h.context.getGuestReceipt({ orderId: 'order', token: 'receipt' });
    assert.equal(h.events.filter(event => event.type === 'init').length, 0);
    assert.equal(h.events.filter(event => event.type === 'call').length, 1);
  }
});

test('Enterprise App Check initializes the same app before Firebase services and verifies attestation before either creation callable', async () => {
  const key = '6L' + 'a'.repeat(38); // Test-only synthetic public-key-shaped value, never shipped configuration.
  const h = await harness({ key });
  const init = h.events[0];
  assert.equal(init.type, 'init');
  assert.equal(init.sameApp, h.app);
  assert.equal(init.options.provider.siteKey, key);
  assert.equal(init.options.isTokenAutoRefreshEnabled, true);
  for (const name of ['createPreorder', 'createPaymentIntent']) {
    await h.context[name]({ receiptToken: 'client-proof' });
    const events = h.events.slice(-2);
    assert.equal(events[0].type, 'token');
    assert.equal(events[1].name, name);
    assert.equal(events[1].data.receiptToken, 'client-proof');
  }
});

test('App Check setup or token errors are safe, block creation, and never break receipt reads', async () => {
  for (const failure of [{ initFailure: true }, { tokenFailure: true }]) {
    const h = await harness({ key: '6L' + 'a'.repeat(38), ...failure });
    await assert.rejects(h.context.createPreorder({ receiptToken: 'private-proof' }), error => /unavailable/i.test(error.message) && !/private/.test(error.message));
    await h.context.getGuestReceipt({ orderId: 'order', token: 'receipt' });
    assert.equal(h.events.filter(event => event.type === 'call').length, 1);
  }
});
