import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as commerce from '../commerce-ui.mjs';
import * as rules from '../checkout-rules.mjs';

const delivery = { method: 'local_delivery', deliveryAddress: { street: '1 Main St', city: 'Jacksonville', state: 'FL', zip: '32202' } };

test('delivery requires 6–12 whole jars and an explicit supported subscription interval', () => {
  for (const totalJars of [6, 9, 12]) {
    for (const subscriptionInterval of ['weekly', 'every_two_weeks', 'monthly']) {
      assert.deepEqual(rules.validateFulfillment({ ...delivery, totalJars, subscriptionInterval }), []);
    }
  }
  for (const totalJars of [0, 5, 13, 6.5, Infinity]) {
    assert.match(rules.validateFulfillment({ ...delivery, totalJars, subscriptionInterval: 'weekly' }).join(' '), /6.*12/);
  }
  for (const subscriptionInterval of [undefined, '', 'one_time', 'yearly']) {
    assert.match(rules.validateFulfillment({ ...delivery, totalJars: 6, subscriptionInterval }).join(' '), /subscription interval/i);
  }
});

async function harness({ policy = null, paymentResponse, quoteResponse, receiptResponse, confirmResponse, savedSession, configured = true, stripeAvailable = true } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, style: {}, textContent: '', listeners: {}, attributes: { 'aria-describedby': 'ordering-availability' }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, getAttribute(name) { return this.attributes[name] ?? null; }, classList: { add() {}, remove() {} }, selectedOptions: [{ textContent: 'Market', dataset: { weekday: '0' } }], addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {} });
    return nodes.get(id);
  };
  const calls = { payments: [], preorders: [], confirms: [], quotes: [], specialOrders: [], unmounts: 0, receipt: [] };
  let ready;
  let method = 'market_pickup';
  const storage = savedSession || new Map([['mammothCart', '{"beef":5}']]);
  const document = { getElementById: node, querySelector: () => ({ value: method }), querySelectorAll: selector => selector.includes('fulfillment-method') ? [] : ['checkout-button', 'pay-at-pickup-button', 'special-order-button'].map(node), addEventListener: (type, fn) => { ready = fn; } };
  const context = vm.createContext({ ...commerce, URL, URLSearchParams, Date, Math, Number, Object, JSON, crypto: webcrypto, document, console: { error() {}, warn() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { location: { origin: 'https://shop.example', href: '' }, clearTimeout() {}, setTimeout() {} },
    STRIPE_PUBLISHABLE_KEY: stripeAvailable ? 'pk_test_configured' : 'YOUR_KEY',
    Stripe: () => ({ elements: () => ({ create: () => ({ mount() {}, unmount() { calls.unmounts++; } }) }), confirmPayment: async request => { calls.confirms.push(request); assert.ok(storage.has('mammothGuestReceipt'), 'Save receipt before calling Stripe'); return confirmResponse ? confirmResponse(request) : { paymentIntent: { status: 'succeeded', id: 'pi_test' } }; } }),
    isOrderingConfigured: () => configured,
    getProducts: async () => ['beef', 'chicken', 'mushroom'].map(id => ({ id, active: true, name: id, price: 2000 })), getMarkets: async () => [], getPromotionConfig: async () => ({}), getDeliveryPolicy: async () => policy,
    renderProducts() {}, renderMarkets() {}, updateCartSummary() {},
    calculateCartTotal: () => ({ items: [], total: 10000, discount: 0, subtotal: 10000 }),
    ...rules,
    createPaymentIntent: async request => { calls.payments.push(request); return paymentResponse ? await paymentResponse(request) : { data: { orderId: 'order-1', receiptToken: request.receiptToken, clientSecret: 'secret', totalAmount: 10000 } }; },
    createPreorder: async request => { calls.preorders.push(request); return { data: {} }; }, checkout: async request => { calls.specialOrders.push(request); return null; },
    getGuestReceipt: async request => { calls.receipt.push(request); return receiptResponse ? receiptResponse(request) : { data: { deliveryFee: 500, totalAmount: 10500, deliveryDate: '2026-10-26' } }; },
    getDeliveryQuote: async request => { calls.quotes.push(request); return quoteResponse ? quoteResponse(request) : { data: { deliveryFee: 500, totalAmount: 10500, deliveryDate: '2026-10-26' } }; }
  });
  vm.runInContext((await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, ''), context);
  await ready();
  node('customer-name').value = 'Alex'; node('customer-email').value = 'alex@example.com'; node('market-select').value = 'market'; node('pickup-date').value = '2026-10-25';
  return { context, calls, node, storage, setMethod: value => { method = value; context.syncFulfillmentUI(); } };
}


const configuredPolicy = { enabled: true, allowedZips: ['32202'], state: 'FL', feeCents: 500, minimumJars: 6, cutoffHours: 48 };
function chooseDelivery(h) {
  h.context.handleAddToCart('chicken', 1);
  h.setMethod('local_delivery');
  for (const [id, value] of Object.entries({ 'delivery-street': '1 Main St', 'delivery-city': 'Jacksonville', 'delivery-state': 'FL', 'delivery-zip': '32202', 'subscription-interval': 'weekly' })) h.node(id).value = value;
}

test('subscription selection is explicit, accessible and unavailable even without JavaScript', async () => {
  const html = await readFile(new URL('../shop.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="subscription-interval">/);
  assert.match(html, /<select[^>]*id="subscription-interval"[^>]*aria-describedby="subscription-availability"/);
  for (const interval of ['weekly', 'every_two_weeks', 'monthly']) assert.ok(html.includes(`value="${interval}"`));
  assert.match(html, /id="subscription-availability"[^>]*role="status"[^>]*>Subscription checkout unavailable/);
  assert.doesNotMatch(html, /one.time delivery|6 jars or more/i);
  assert.match(html, /id="delivery-quote-button"[^>]*disabled/);
});

test('delivery selections remain a plan, never a one-time payment or subscription activation', async () => {
  const h = await harness({ policy: configuredPolicy });
  chooseDelivery(h);
  assert.equal(h.node('local-delivery-option').disabled, false, 'Customers can plan a delivery subscription');
  assert.equal(h.node('subscription-interval').required, true);
  for (const subscriptionInterval of ['weekly', 'every_two_weeks', 'monthly']) {
    h.node('subscription-interval').value = subscriptionInterval;
    const details = h.context.fulfillmentDetails();
    assert.equal(details.subscriptionInterval, subscriptionInterval);
    assert.equal(h.context.validateOrderDetails().length, 0, 'A mixed six-jar cart is valid to plan');
    assert.equal(await h.context.preparePaymentElement(), false);
    await h.context.handleOrderSubmit({ preventDefault() {} });
    await h.node('delivery-quote-button').listeners.click();
    await h.context.handleSpecialOrder();
    assert.equal(h.node('checkout-button').disabled, true);
    assert.equal(h.node('delivery-quote-button').disabled, true);
    assert.equal(h.node('payment-element').hidden, true);
    assert.match(h.node('payment-message').textContent, /subscription checkout unavailable/i);
  }
  assert.deepEqual(h.calls.payments, []);
  assert.deepEqual(h.calls.confirms, []);
  assert.deepEqual(h.calls.quotes, []);
  assert.deepEqual(h.calls.preorders, []);
  assert.deepEqual(h.calls.specialOrders, []);
  assert.deepEqual(JSON.parse(h.storage.get('mammothCart')), { beef: 5, chicken: 1 });
  assert.equal(h.context.window.location.href, '');
  h.node('subscription-interval').value = 'one_time';
  assert.match(h.context.validateOrderDetails().join(' '), /subscription interval/i);
  h.context.handleAddToCart('mushroom', 6);
  assert.equal(h.context.validateOrderDetails().some(error => /6.*12/.test(error)), false);
  h.context.handleAddToCart('mushroom', 1);
  assert.equal(h.context.totalJars(), 12);
});

test('offline or unconfigured checkout cannot fall back to a one-time delivery', async () => {
  for (const options of [{ policy: null }, { policy: configuredPolicy, configured: false }, { policy: configuredPolicy, stripeAvailable: false }]) {
    const h = await harness(options);
    chooseDelivery(h);
    await h.context.handleOrderSubmit({ preventDefault() {} });
    assert.equal(await h.context.preparePaymentElement(), false);
    await h.node('delivery-quote-button').listeners.click();
    assert.equal(h.calls.payments.length + h.calls.confirms.length + h.calls.quotes.length, 0);
    assert.match(h.node('subscription-availability').textContent, /subscription checkout unavailable/i);
    assert.equal(h.node('checkout-button').disabled, true);
  }
});

test('switching from mounted pickup payment to delivery unmounts it; returning preserves pickup and special orders', async () => {
  const h = await harness({ policy: configuredPolicy });
  assert.equal(await h.context.preparePaymentElement(), true);
  chooseDelivery(h);
  assert.equal(h.calls.unmounts, 1);
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.confirms.length, 0);
  h.setMethod('market_pickup');
  assert.equal(h.node('subscription-interval').required, false);
  assert.equal('subscriptionInterval' in h.context.fulfillmentDetails(), false);
  assert.equal(h.node('checkout-button').disabled, false);
  assert.equal(await h.context.preparePaymentElement(), true);
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.confirms.length, 1);
  h.setMethod('special_order');
  h.node('special-order-notes').value = 'Please prepare this special order.';
  assert.equal(h.context.validateOrderDetails().length, 0);
  assert.equal(h.node('special-order-button').hidden, false);
  assert.equal(h.node('special-order-button').disabled, false);
  await h.context.handleSpecialOrder();
  assert.equal(h.calls.specialOrders.length, 1);
  assert.equal(h.calls.specialOrders[0].fulfillmentMethod, 'special_order');
});
