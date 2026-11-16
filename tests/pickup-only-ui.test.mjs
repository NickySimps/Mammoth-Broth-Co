import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as commerce from '../commerce-ui.mjs';
import { createRequire } from 'node:module';
import { validateFulfillment } from '../checkout-rules.mjs';

test('pickup-only validation rejects other fulfillment and unlisted dates', () => {
  for (const method of ['local_delivery', 'special_order']) assert.ok(validateFulfillment({ method, totalJars: 6, notes: 'Previously valid request', deliveryAddress: { street: '1 Main', city: 'Town', state: 'FL', zip: '32202' } }).length);
  const input = { method: 'market_pickup', marketId: 'market', pickupDate: '2026-11-08', allowedPickupDates: ['2026-11-08'] };
  assert.deepEqual(validateFulfillment(input), []);
  assert.ok(validateFulfillment({ ...input, pickupDate: '2026-11-09' }).length);
  assert.ok(validateFulfillment({ ...input, allowedPickupDates: [] }).length);
});

const now = new Date('2026-11-05T17:00:00Z');
const base = { id: 'market', name: 'Listed market', timezone: 'America/New_York', weekday: 0 };

// Opt in with PICKUP_BROWSER_TEST=1 and NODE_PATH pointing to Playwright.
// All network responses are local fixtures, never live callables or providers.
async function browserFixture({ online = false, configured = true, preorder, payment, javaScriptEnabled = true } = {}) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  await page.clock.install({ time: new Date('2026-11-05T16:59:00Z') });
  await page.clock.pauseAt(now);
  const calls = { preorder: [], payment: [], confirms: [], blocked: [], errors: [] };
  const fixtureProducts = [{ id: 'beef', name: 'Fixture Beef', description: 'Fixture', price: 2500 }, { id: 'chicken', name: 'Fixture Chicken', description: 'Fixture', price: 2500 }, { id: 'mushroom', name: 'Fixture Mushroom', description: 'Fixture', price: 4000 }];
  const fixtureMarkets = [base, { ...base, id: 'holiday', name: 'Listed holiday', pickupDates: ['2026-11-25', '2026-12-24'] }, { ...base, id: 'full', name: 'Full fixture', capacity: 1, reservedCount: 1, occurrenceDate: '2026-11-08' }, { ...base, id: 'closed', name: 'Closed fixture', active: false }];
  const allow = new Set(['shop.html', 'app.js', 'ui.js', 'product-images.mjs', 'checkout.js', 'commerce-ui.mjs', 'checkout-rules.mjs', 'schedule-helper.mjs', 'dialog.mjs', 'style.css', 'fire.css']);
  page.on('pageerror', error => calls.errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const file = url.pathname.slice(1);
    const fulfillJS = body => route.fulfill({ contentType: 'text/javascript', body });
    if (url.origin === 'https://js.stripe.com') return fulfillJS(`window.Stripe=()=>({elements:()=>({create:()=>({mount(selector){document.querySelector(selector).textContent='Synthetic provider fields';},unmount(){}})}),confirmPayment:async request=>{await fetch('/__fixture/confirm',{method:'POST',body:JSON.stringify({return_url:request.confirmParams.return_url})});return {error:{message:'Synthetic decline'}};}});`);
    if (url.origin !== 'https://pickup.test') { calls.blocked.push(url.href); return route.abort(); }
    if (file === 'stripe-config.mjs') return fulfillJS(`export const STRIPE_PUBLISHABLE_KEY=${JSON.stringify(online ? 'pk_test_fixture' : 'pk_test_YOUR_KEY')};`);
    if (file === 'store.js') return fulfillJS(`
      export const getProducts=async()=>${JSON.stringify(fixtureProducts)};
      export const getMarkets=async()=>${JSON.stringify(fixtureMarkets)};
      export const getPromotionConfig=async()=>({});
      export const isOrderingConfigured=()=>${configured};
      const send=async(path,data)=>{const response=await fetch('/__fixture/'+path,{method:'POST',body:JSON.stringify(data)});if(!response.ok)throw new Error('Synthetic refusal');return {data:await response.json()};};
      export const createPreorder=data=>send('preorder',data);
      export const createPaymentIntent=data=>send('payment',data);
      export const getDeliveryPolicy=async()=>null;
      export const getDeliveryQuote=async()=>{throw new Error('Forbidden fixture path');};
      export const getGuestReceipt=async()=>{throw new Error('Forbidden fixture path');};
      export function calculateCartTotal(cart, products){const count=Object.values(cart).reduce((a,b)=>a+b,0);let discount=0;const items=Object.entries(cart).map(([productId,quantity])=>{const p=products.find(p=>p.id===productId);const price=count>=6&&productId!=='mushroom'?2000:p.price;discount+=(p.price-price)*quantity;return {productId,name:p.name,quantity,price};});const total=items.reduce((n,p)=>n+p.price*p.quantity,0);return {items,total,discount,subtotal:total+discount};}
    `);
    if (file.startsWith('__fixture/')) {
      const kind = file.split('/')[1];
      const request = JSON.parse(route.request().postData());
      if (kind === 'confirm') { calls.confirms.push(request); return route.fulfill({ json: {} }); }
      calls[kind].push(request);
      if (kind === 'preorder' && preorder) return route.fulfill(await preorder(request, calls[kind].length));
      if (kind === 'payment' && payment) return route.fulfill(await payment(request, calls[kind].length));
      return route.fulfill({ json: { orderId: 'synthetic-order', orderName: 'Fixture-42', receiptToken: request.receiptToken, totalAmount: 14000, marketName: 'Listed holiday', pickupDate: request.pickupDate, clientSecret: 'synthetic-secret', emailState: 'pending' } });
    }
    if (allow.has(file)) return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    calls.blocked.push(url.href); return route.abort();
  });
  await page.goto('https://pickup.test/shop.html');
  if (javaScriptEnabled) await page.locator('#product-list .add-to-cart-btn').first().waitFor();
  return { browser, page, calls, async fill() {
    await page.locator('.quantity-input[data-id="beef"]').fill('3');
    await page.locator('.add-to-cart-btn[data-id="beef"]').click();
    await page.locator('.quantity-input[data-id="chicken"]').fill('2');
    await page.locator('.add-to-cart-btn[data-id="chicken"]').click();
    await page.locator('.add-to-cart-btn[data-id="mushroom"]').click();
    await page.locator('#customer-name').fill('Fixture Customer');
    await page.locator('#customer-email').fill('fixture@example.test');
    await page.locator('#market-select').selectOption('holiday');
  } };
}

const browserOptions = { skip: process.env.PICKUP_BROWSER_TEST !== '1' };
test('offline browser selects listed market/date and confirms pay-at-pickup only after acceptance', browserOptions, async () => {
  let accept;
  const h = await browserFixture({ preorder: request => new Promise(resolve => { accept = () => resolve({ json: { orderId: 'synthetic-order', orderName: 'Fixture-42', receiptToken: request.receiptToken, totalAmount: 14000, marketName: 'Listed holiday', pickupDate: request.pickupDate, emailState: 'pending' } }); }) });
  try {
    await h.fill();
    assert.equal(await h.page.locator('[name="fulfillment-method"][value="local_delivery"], [name="fulfillment-method"][value="special_order"], #special-order-button').count(), 0);
    assert.equal(await h.page.locator('#pickup-date').evaluate(node => node.tagName), 'SELECT');
    assert.deepEqual(await h.page.locator('#pickup-date option').evaluateAll(nodes => nodes.filter(n=>n.value).map(n=>n.value)), ['2026-11-25']);
    assert.equal(await h.page.locator('#market-select option[value="full"]').isDisabled(), true);
    await h.page.locator('#pickup-date').selectOption('2026-11-25');
    await h.page.locator('#payment-pickup').check();
    await h.page.locator('#pay-at-pickup-button').click();
    await h.page.waitForFunction(()=>document.querySelector('#pay-at-pickup-button').disabled);
    while (!accept) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await h.page.locator('#confirmationModal').evaluate(node=>node.classList.contains('show')), false);
    assert.match(await h.page.locator('#cart-summary').innerText(), /Fixture Mushroom/);
    accept();
    await h.page.waitForFunction(()=>document.querySelector('#orderNumber').textContent==='Fixture-42');
    assert.match(await h.page.locator('#confirmation-details').innerText(), /Listed holiday.*2026-11-25.*pay at pickup/i);
    assert.equal(h.calls.preorder.length, 1);
    const request = h.calls.preorder[0];
    assert.deepEqual(request.cart, { beef: 3, chicken: 2, mushroom: 1 });
    assert.equal(request.fulfillmentMethod, 'market_pickup');
    assert.equal(request.paymentMethod, 'pickup');
    assert.equal(request.pickupDate, '2026-11-25');
    assert.match(request.receiptToken, /^[a-f0-9]{64}$/);
    assert.match(await h.page.locator('#confirmation-receipt').getAttribute('href'), /#order=synthetic-order&token=/);
    assert.deepEqual(h.calls.errors, []);
    assert.equal(h.calls.payment.length, 0);
  } finally { await h.browser.close(); }
});

test('server response without an authoritative total cannot confirm a pickup reservation', browserOptions, async () => {
  const h = await browserFixture({ preorder: async request => ({ json: { orderId: 'incomplete', receiptToken: request.receiptToken } }) });
  try {
    h.page.on('dialog', dialog => dialog.dismiss());
    await h.fill();
    await h.page.locator('#pickup-date').selectOption('2026-11-25');
    await h.page.locator('#pay-at-pickup-button').click();
    await h.page.waitForFunction(()=>!document.querySelector('#pay-at-pickup-button').disabled);
    assert.equal(h.calls.preorder.length, 1);
    assert.equal(await h.page.locator('#orderNumber').innerText(), '');
    assert.match(await h.page.locator('#cart-summary').innerText(), /Fixture Mushroom/);
  } finally { await h.browser.close(); }
});

test('placeholder payment and unconfigured ordering fail closed without silently choosing pickup', browserOptions, async () => {
  for (const configured of [true, false]) {
    const h = await browserFixture({ configured });
    try {
      await h.fill();
      await h.page.locator('#pickup-date').selectOption('2026-11-25');
      assert.equal(await h.page.locator('#payment-online').isDisabled(), true);
      assert.equal(await h.page.locator('#pay-at-pickup-button').isDisabled(), !configured);
      await h.page.evaluate(() => { document.querySelector('#payment-online').checked = true; document.querySelector('#order-form').requestSubmit(); });
      assert.equal(h.calls.preorder.length, 0);
      assert.equal(h.calls.payment.length, 0);
      assert.equal(h.calls.confirms.length, 0);
      assert.deepEqual(h.calls.errors, []);
    } finally { await h.browser.close(); }
  }
});

test('pay-at-pickup refusal and mismatched proof preserve cart and retry capability', browserOptions, async () => {
  const h = await browserFixture({ preorder: async (request, attempt) => attempt === 1 ? { status: 503, json: { error: 'Synthetic refusal' } } : { json: { orderId: 'synthetic-order', orderName: 'Fixture-42', receiptToken: attempt === 2 ? 'ab'.repeat(32) : request.receiptToken, totalAmount: 14000 } } });
  try {
    h.page.on('dialog', dialog => dialog.dismiss());
    await h.fill();
    await h.page.locator('#pickup-date').selectOption('2026-11-25');
    for (let n = 1; n <= 3; n++) {
      await h.page.locator('#pay-at-pickup-button').click();
      await h.page.waitForFunction(()=>!document.querySelector('#pay-at-pickup-button').disabled);
      assert.equal(h.calls.preorder.length, n);
      if (n < 3) {
        assert.equal(await h.page.locator('#orderNumber').innerText(), '');
        assert.match(await h.page.locator('#cart-summary').innerText(), /Fixture Mushroom/);
      }
    }
    assert.deepEqual(h.calls.preorder[0], h.calls.preorder[1]);
    assert.deepEqual(h.calls.preorder[0], h.calls.preorder[2]);
    assert.match(await h.page.locator('#cart-summary').innerText(), /empty/i);
    const storage = await h.page.evaluate(()=>JSON.stringify(localStorage));
    assert.equal(storage.includes(h.calls.preorder[0].receiptToken), false);
  } finally { await h.browser.close(); }
});

test('unlisted tampered date never reaches the callable', browserOptions, async () => {
  const h = await browserFixture();
  try {
    await h.fill();
    await h.page.evaluate(()=>{const option = document.createElement('option'); option.value='2026-12-24'; option.textContent=option.value; document.querySelector('#pickup-date').appendChild(option); document.querySelector('#pickup-date').value=option.value;});
    await h.page.locator('#pay-at-pickup-button').click();
    assert.match(await h.page.locator('#payment-message').innerText(), /available listed pickup date/i);
    assert.equal(h.calls.preorder.length, 0);
    assert.equal(h.calls.payment.length, 0);
  } finally { await h.browser.close(); }
});

test('online pickup requires explicit second payment action and preserves private proof', browserOptions, async () => {
  const h = await browserFixture({ online: true });
  try {
    await h.fill();
    await h.page.locator('#pickup-date').selectOption('2026-11-25');
    await h.page.locator('#payment-online').check();
    await h.page.locator('#checkout-button').click();
    await h.page.waitForFunction(()=>document.querySelector('#checkout-button').textContent==='Pay $140.00');
    assert.equal(h.calls.payment.length, 1);
    assert.equal(h.calls.confirms.length, 0);
    assert.equal(h.calls.preorder.length, 0);
    assert.equal(h.calls.payment[0].fulfillmentMethod, 'market_pickup');
    assert.equal('totalAmount' in h.calls.payment[0], false);
    assert.equal(await h.page.locator('#payment-element').isVisible(), true);
    assert.match(await h.page.locator('#payment-message').innerText(), /pending.*2026-11-25/);
    await h.page.locator('#checkout-button').click();
    await h.page.waitForFunction(()=>document.querySelector('#payment-message').textContent.includes('could not be completed'));
    assert.equal(h.calls.confirms.length, 1);
    assert.equal(JSON.stringify(h.calls.confirms).includes(h.calls.payment[0].receiptToken), false);
    assert.match(await h.page.locator('#cart-summary').innerText(), /Fixture Mushroom/);
    assert.equal(await h.page.locator('#orderNumber').innerText(), '');
    await h.page.locator('#customer-name').fill('Changed fixture name');
    assert.equal(await h.page.locator('#payment-element').isVisible(), false);
    assert.equal(await h.page.locator('#checkout-button').innerText(), 'Continue to secure payment');
    assert.deepEqual(h.calls.errors, []);
  } finally { await h.browser.close(); }
});

test('pickup checkout refuses unsupported fulfillment or payment before creating an order', browserOptions, async () => {
  const h = await browserFixture();
  try {
    h.page.on('dialog', dialog => dialog.dismiss());
    for (const [fulfillmentMethod, paymentMethod] of [['special_order', 'special_order'], ['local_delivery', 'pickup'], ['market_pickup', 'card']]) {
      const result = await h.page.evaluate(async ([fulfillmentMethod, paymentMethod]) => {
        const { checkout } = await import('./checkout.js');
        return checkout({ cart: { beef: 1 }, fulfillmentMethod, paymentMethod });
      }, [fulfillmentMethod, paymentMethod]);
      assert.equal(result, null);
    }
    assert.equal(h.calls.preorder.length, 0);
  } finally { await h.browser.close(); }
});

test('online response after edited customer details cannot mount stale payment fields', browserOptions, async () => {
  let finish;
  const h = await browserFixture({ online: true, payment: request => new Promise(resolve => { finish = () => resolve({ json: { orderId: 'stale', receiptToken: request.receiptToken, totalAmount: 14000, clientSecret: 'synthetic-secret' } }); }) });
  try {
    await h.fill();
    await h.page.locator('#pickup-date').selectOption('2026-11-25');
    await h.page.locator('#payment-online').check();
    await h.page.locator('#checkout-button').click();
    while (!finish) await new Promise(resolve => setTimeout(resolve, 10));
    await h.page.locator('#customer-email').fill('changed@example.test');
    finish();
    await h.page.waitForFunction(()=>!document.querySelector('#checkout-button').disabled);
    assert.equal(await h.page.locator('#payment-element').isVisible(), false);
    assert.equal(h.calls.confirms.length, 0);
    assert.equal(await h.page.evaluate(()=>sessionStorage.getItem('mammothGuestReceipt')), null);
  } finally { await h.browser.close(); }
});

test('online lost-response retry survives reload with the same persisted request proof', browserOptions, async () => {
  const h = await browserFixture({ online: true, payment: async (request, n) => n === 1 ? { status: 503, json: {} } : { json: { orderId: 'retry', receiptToken: request.receiptToken, totalAmount: 14000, clientSecret: 'synthetic-secret' } } });
  try {
    await h.fill();
    await h.page.locator('#pickup-date').selectOption('2026-11-25');
    await h.page.locator('#payment-online').check();
    await h.page.locator('#checkout-button').click();
    await h.page.waitForFunction(()=>document.querySelector('#payment-message').textContent.includes('No payment was requested'));
    await h.page.reload();
    await h.page.locator('#product-list .add-to-cart-btn').first().waitFor();
    await h.page.locator('#customer-name').fill('Fixture Customer');
    await h.page.locator('#customer-email').fill('fixture@example.test');
    await h.page.locator('#market-select').selectOption('holiday');
    await h.page.locator('#pickup-date').selectOption('2026-11-25');
    await h.page.locator('#payment-online').check();
    await h.page.locator('#checkout-button').click();
    await h.page.waitForFunction(()=>document.querySelector('#checkout-button').textContent==='Pay $140.00');
    assert.deepEqual(h.calls.payment[0], h.calls.payment[1]);
    assert.equal(h.calls.confirms.length, 0);
  } finally { await h.browser.close(); }
});

test('checkout is disabled without JavaScript and pickup controls fit narrow viewports', browserOptions, async () => {
  const noJS = await browserFixture({ javaScriptEnabled: false });
  try {
    assert.equal(await noJS.page.locator('#pay-at-pickup-button').isDisabled(), true);
    assert.equal(await noJS.page.locator('#checkout-button').isDisabled(), true);
    assert.equal(await noJS.page.locator('#payment-online').isDisabled(), true);
    assert.equal(noJS.calls.preorder.length + noJS.calls.payment.length, 0);
  } finally { await noJS.browser.close(); }
  const h = await browserFixture();
  try {
    await h.fill();
    for (const width of [320, 390, 1280]) {
      await h.page.setViewportSize({ width, height: 850 });
      for (const selector of ['#market-select', '#pickup-date', '#customer-name', '#customer-email', '#pay-at-pickup-button']) {
        const rect = await h.page.locator(selector).boundingBox();
        assert.ok(rect.width > 0 && rect.x >= 0 && rect.x + rect.width <= width, `${selector} fits ${width}px`);
      }
    }
    assert.deepEqual(h.calls.errors, []);
  } finally { await h.browser.close(); }
});

test('pickup dates use only valid server schedule and occurrence-scoped availability', () => {
  assert.equal(typeof commerce.pickupDateOptions, 'function');
  const dates = market => commerce.pickupDateOptions(market, now);
  assert.deepEqual(dates(base), ['2026-11-08']);
  assert.deepEqual(dates({ ...base, pickupDates: ['2026-12-24', '2026-11-04', '2026-11-25'] }), ['2026-11-25']);
  assert.deepEqual(dates({ ...base, capacity: 10, reservedCount: 2, occurrenceDate: '2026-11-08' }), ['2026-11-08']);
  assert.deepEqual(dates({ ...base, pickupDates: ['2026-11-08', '2026-11-15'], capacity: 10, occurrenceDate: '2026-11-15' }), []);
  for (const invalid of [null, {}, { ...base, active: false }, { ...base, capacity: 1, reservedCount: 1, occurrenceDate: '2026-11-08' }, { ...base, capacity: 2 }, { ...base, reservedCount: -1 }, { ...base, pickupDates: ['2026-02-30', '2026-11-08'] }, { ...base, orderCutoffAt: '2026-11-05T16:00:00Z', occurrenceDate: '2026-11-08' }, { ...base, orderCutoffAt: '2026-11-07T16:00:00', occurrenceDate: '2026-11-08' }]) assert.deepEqual(dates(invalid), []);
});
