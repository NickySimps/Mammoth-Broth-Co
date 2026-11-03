import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as commerce from '../commerce-ui.mjs';
import { createRequire } from 'node:module';

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const executable = source => source.replace(/^import .*;\r?\n/gm, '').replace(/export (?=(?:const|async function|function)\b)/g, '');

async function storeHarness({ restore = true } = {}) {
  const calls = [];
  let restored;
  const context = vm.createContext({
    COMMERCE_APP_CHECK_SITE_KEY: '6L' + 'a'.repeat(38),
    initializeApp: () => ({}), initializeAppCheck: () => ({}), ReCaptchaEnterpriseProvider: class {},
    getToken: async () => { calls.push('attestation'); return { token: 'valid' }; },
    getFirestore: () => ({}), getFunctions: () => ({}), getAuth: () => ({}),
    onAuthStateChanged: (_auth, callback) => { restored = callback; return () => {}; },
    httpsCallable: (_functions, name) => async () => { calls.push(name); return { data: { orderId: 'existing' } }; },
    collection: (_db, name) => name, doc: (_db, ...path) => path.join('/'),
    addDoc: async () => { calls.push('addDoc'); return { id: 'unsafe' }; }, serverTimestamp: () => 'timestamp',
    getDocs: async () => ({ docs: [{ id: 'prod_beef', data: () => ({ name: 'Beef', priceCents: 2500 }) }] }),
    getDoc: async () => ({ exists: () => true, data: () => ({ enabled: false }) }), console
  });
  vm.runInContext(executable(await read('store.js')), context);
  if (restore) restored(null);
  return { context, calls };
}

test('release gate defaults off even with valid App Check; every exported mutation refuses before network or writes', async () => {
  const { context, calls } = await storeHarness();
  assert.equal(context.isOrderingConfigured(), false);
  for (const name of ['saveOrder', 'createPaymentIntent', 'createPreorder', 'reviewSpecialOrder', 'retryOrderEmail']) {
    await assert.rejects(context[name]({ cart: { prod_beef: 6 }, fulfillmentMethod: 'special_order' }), /preview.*ordering.*disabled/i, name);
  }
  assert.deepEqual(calls, []);
});

test('disabled creation rejects immediately without waiting for auth restoration', async () => {
  const { context, calls } = await storeHarness({ restore: false });
  const result = await Promise.race([
    context.createPreorder({}).then(() => 'created', error => error.message),
    new Promise(resolve => setTimeout(() => resolve('auth wait'), 50))
  ]);
  assert.match(result, /preview.*ordering.*disabled/i);
  assert.deepEqual(calls, []);
});

test('catalog, markets, policies, and existing private receipts remain readable', async () => {
  const { context, calls } = await storeHarness();
  assert.equal((await context.getProducts())[0].id, 'prod_beef');
  assert.equal((await context.getMarkets()).length, 1);
  await context.getPromotionConfig();
  await context.getDeliveryPolicy();
  assert.equal((await context.getGuestReceipt({ orderId: 'existing', token: 'private' })).data.orderId, 'existing');
  assert.deepEqual(calls, ['getGuestReceipt']);
});

test('direct checkout wrapper cannot bypass the store gate or show successful submission', async () => {
  const { context, calls } = await storeHarness();
  const storage = new Map();
  Object.assign(context, commerce, {
    crypto: webcrypto, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    localStorage: { getItem: () => '[]', setItem: () => assert.fail('No local success history') },
    document: { getElementById: () => null, querySelector: () => null },
    window: { addEventListener() {} }, alert() {}, openDialog: () => assert.fail('No success dialog'), closeDialog() {},
    console: { error() {} }
  });
  vm.runInContext(executable(await read('checkout.js')), context);
  assert.equal(await context.checkout({ cart: { prod_beef: 6 }, fulfillmentMethod: 'special_order', specialNotes: 'Preview only' }), null);
  assert.deepEqual(calls, []);
});

// Optional offline browser coverage: point PREVIEW_PLAYWRIGHT_MODULE to an
// installed Playwright package. All external requests are intercepted/denied.
if (process.env.PREVIEW_PLAYWRIGHT_MODULE) test('browser preview blocks forced submissions with a persistent notice, even with configured providers', async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.PREVIEW_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.__calls = []; });
    const firebase = `
      export const initializeApp = () => ({}), getFirestore = () => ({}), getFunctions = () => ({}), getAuth = () => ({});
      export const initializeAppCheck = () => ({}); export class ReCaptchaEnterpriseProvider {}
      export const getToken = async () => { window.__calls.push('attestation'); return { token: 'valid' }; };
      export const onAuthStateChanged = (_auth, fn) => { queueMicrotask(fn); return () => {}; };
      export const collection = (_db, name) => name, doc = (_db, ...path) => path.join('/');
      export const getDoc = async () => ({ exists: () => false });
      export const getDocs = async name => ({ docs: (name === 'products' ? [{ id: 'prod_beef', name: 'Beef', priceCents: 2500, active: true }] : []).map(item => ({ id: item.id, data: () => item })) });
      export const serverTimestamp = () => 'timestamp';
      export const addDoc = async () => { window.__calls.push('addDoc'); throw Error('Unexpected write'); };
      export const httpsCallable = (_functions, name) => async () => { window.__calls.push(name); return { data: { orderId: 'existing' } }; };
    `;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'www.gstatic.com') return route.fulfill({ contentType: 'text/javascript', body: firebase });
      if (url.hostname === 'js.stripe.com') return route.fulfill({ contentType: 'text/javascript', body: `window.Stripe = () => { window.__calls.push('Stripe'); return {}; };` });
      if (url.origin !== 'http://preview.test') return route.abort();
      const name = url.pathname.slice(1) || 'shop.html';
      if (name === 'commerce-config.mjs') return route.fulfill({ contentType: 'text/javascript', body: `export const COMMERCE_APP_CHECK_SITE_KEY = '${'6L' + 'a'.repeat(38)}';` });
      if (name === 'stripe-config.mjs') return route.fulfill({ contentType: 'text/javascript', body: `export const STRIPE_PUBLISHABLE_KEY = 'pk_test_configured';` });
      if (['effects.js', 'market-banner.js', 'nav.js', 'floating-buttons.js'].includes(name)) return route.fulfill({ contentType: 'text/javascript', body: '' });
      if (!/^[\w.-]+$/.test(name)) return route.abort();
      try { return route.fulfill({ contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await read(name) }); }
      catch { return route.abort(); }
    });
    await page.goto('http://preview.test/shop.html');
    await page.locator('.add-to-cart-btn').click();
    assert.match(await page.locator('#ordering-availability').innerText(), /preview.*ordering.*disabled/i);
    await page.locator('#customer-name').fill('Preview');
    await page.locator('#customer-email').fill('preview@example.invalid');
    for (const method of ['market_pickup', 'special_order', 'local_delivery']) {
      await page.locator(`input[value="${method}"]`).check();
      assert.equal(await page.locator('#checkout-button').isDisabled(), true);
      assert.equal(await page.locator('#special-order-button').isDisabled(), true);
      await page.evaluate(() => {
        document.querySelector('#order-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        document.querySelector('#special-order-button').dispatchEvent(new Event('click', { bubbles: true }));
      });
      assert.equal(await page.locator('#ordering-availability').isVisible(), true);
    }
    const results = await page.evaluate(async () => {
      const store = await import('./store.js');
      const results = [];
      for (const name of ['saveOrder', 'createPaymentIntent', 'createPreorder', 'reviewSpecialOrder', 'retryOrderEmail']) {
        try { await store[name]({}); results.push('unsafe'); } catch (error) { results.push(error.message); }
      }
      window.alert = () => {};
      results.push(await (await import('./checkout.js')).checkout({ cart: { prod_beef: 1 }, fulfillmentMethod: 'special_order' }));
      return results;
    });
    for (const result of results.slice(0, -1)) assert.match(result, /preview.*ordering.*disabled/i);
    assert.equal(results.at(-1), null);
    assert.deepEqual(await page.evaluate(() => window.__calls), []);
    assert.match(await page.locator('#cart-summary').innerText(), /Beef/);
    assert.deepEqual(errors, []);
    const noJSContext = await browser.newContext({ javaScriptEnabled: false });
    await noJSContext.route('**/*', async route => {
      if (route.request().url() === 'http://preview.test/shop.html') return route.fulfill({ contentType: 'text/html', body: await read('shop.html') });
      return route.abort();
    });
    const noJS = await noJSContext.newPage();
    await noJS.goto('http://preview.test/shop.html');
    assert.equal(await noJS.locator('#ordering-availability').isVisible(), true);
    assert.match(await noJS.locator('#ordering-availability').innerText(), /preview.*ordering.*disabled/i);
  } finally { await browser.close(); }
});
