import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as commerce from '../commerce-ui.mjs';
import { webcrypto } from 'node:crypto';

async function harness({ policy = null, paymentResponse, quoteResponse, receiptResponse, confirmResponse, savedSession } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, style: {}, textContent: '', listeners: {}, attributes: { 'aria-describedby': 'ordering-availability' }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, getAttribute(name) { return this.attributes[name] ?? null; }, classList: { add() {}, remove() {} }, selectedOptions: [{ textContent: 'Market', dataset: { weekday: '0' } }], addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {} });
    return nodes.get(id);
  };
  const calls = { payments: [], preorders: [], confirms: [], quotes: [], unmounts: 0, receipt: [] };
  let ready;
  let method = 'market_pickup';
  const storage = savedSession || new Map([['mammothCart', '{"beef":5}']]);
  const document = { getElementById: node, querySelector: () => ({ value: method }), querySelectorAll: selector => selector.includes('fulfillment-method') ? [] : ['checkout-button', 'pay-at-pickup-button', 'special-order-button'].map(node), addEventListener: (type, fn) => { ready = fn; } };
  const context = vm.createContext({ ...commerce, URL, URLSearchParams, Date, Math, Number, Object, JSON, crypto: webcrypto, document, console: { error() {}, warn() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { location: { origin: 'https://shop.example', href: '' }, clearTimeout() {}, setTimeout() {} },
    STRIPE_PUBLISHABLE_KEY: 'pk_test_configured',
    Stripe: () => ({ elements: () => ({ create: () => ({ mount() {}, unmount() { calls.unmounts++; } }) }), confirmPayment: async request => { calls.confirms.push(request); assert.ok(storage.has('mammothGuestReceipt'), 'Save receipt before calling Stripe'); return confirmResponse ? confirmResponse(request) : { paymentIntent: { status: 'succeeded', id: 'pi_test' } }; } }),
    isOrderingConfigured: () => true,
    getProducts: async () => [{ id: 'beef', active: true, name: 'Beef broth', price: 2000 }], getMarkets: async () => [], getPromotionConfig: async () => ({}), getDeliveryPolicy: async () => policy,
    renderProducts() {}, renderMarkets() {}, updateCartSummary() {},
    calculateCartTotal: () => ({ items: [], total: 10000, discount: 0, subtotal: 10000 }),
    FULFILLMENT_METHODS: { MARKET_PICKUP: 'market_pickup', LOCAL_DELIVERY: 'local_delivery', SPECIAL_ORDER: 'special_order' }, validateFulfillment: () => [],
    createPaymentIntent: async request => { calls.payments.push(request); return paymentResponse ? await paymentResponse(request) : { data: { orderId: 'order-1', receiptToken: request.receiptToken, clientSecret: 'secret', totalAmount: 10000 } }; },
    createPreorder: async request => { calls.preorders.push(request); return { data: {} }; }, checkout: async () => null,
    getGuestReceipt: async request => { calls.receipt.push(request); return receiptResponse ? receiptResponse(request) : { data: { deliveryFee: 500, totalAmount: 10500, deliveryDate: '2026-10-26' } }; },
    getDeliveryQuote: async request => { calls.quotes.push(request); return quoteResponse ? quoteResponse(request) : { data: { deliveryFee: 500, totalAmount: 10500, deliveryDate: '2026-10-26' } }; }
  });
  vm.runInContext((await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, ''), context);
  await ready();
  node('customer-name').value = 'Alex'; node('customer-email').value = 'alex@example.com'; node('market-select').value = 'market'; node('pickup-date').value = '2026-10-25';
  return { context, calls, node, storage, setMethod: value => { method = value; context.syncFulfillmentUI(); } };
}

test('configured order buttons do not describe themselves with the hidden ordering-unavailable message', async () => {
  const h = await harness();
  assert.equal(h.node('ordering-availability').hidden, true);
  for (const id of ['checkout-button', 'pay-at-pickup-button', 'special-order-button']) assert.equal(h.node(id).getAttribute('aria-describedby'), null);
});

test('card intent durably records full customer request before confirm and never marks paid in browser', async () => {
  const h = await harness();
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.confirms.length, 0, 'Opening card fields must not immediately confirm an unfilled payment element');
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.payments[0].customerName, 'Alex');
  assert.equal(h.calls.payments[0].customerEmail, 'alex@example.com');
  assert.match(h.calls.payments[0].requestId, /^[\w-]{16,128}$/);
  assert.equal(h.calls.preorders.length, 0, 'Stripe success must not create or mark a paid preorder');
  assert.equal(h.storage.has('pendingOrder'), false);
  assert.equal(h.storage.has('mammothOrders'), false);
  assert.match(h.context.window.location.href, /receipt\.html#order=order-1&token=[a-f0-9]{64}/);
});

test('changing any customer or receiving field invalidates mounted payment and stale in-flight setup', async () => {
  let finish;
  const h = await harness({ paymentResponse: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.context.preparePaymentElement();
  assert.equal(typeof h.node('order-form').listeners.input, 'function');
  h.node('customer-email').value = 'other@example.com';
  h.node('order-form').listeners.input({ target: h.node('customer-email') });
  finish({ data: { orderId: 'old', receiptToken: 'old-cap', clientSecret: 'old-secret' } });
  assert.equal(await pending, false);
  assert.equal(h.node('payment-element').hidden, true);
});

test('delivery cannot prepare card fields without configured geography and an explicit server quote', async () => {
  const h = await harness(); h.setMethod('local_delivery');
  await h.context.preparePaymentElement();
  assert.equal(h.calls.payments.length, 0);
  assert.match(h.node('delivery-quote-status').textContent, /not configured/i);
});

const configuredPolicy = { enabled: true, allowedZips: ['32202'], state: 'FL', feeCents: 500, minimumJars: 5, cutoffHours: 48 };
function chooseDelivery(h) {
  h.setMethod('local_delivery');
  for (const [id, value] of Object.entries({ 'delivery-street': '1 Main St', 'delivery-city': 'Jacksonville', 'delivery-state': 'FL', 'delivery-zip': '32202' })) h.node(id).value = value;
}

test('delivery refuses inconsistent intent total even when the saved receipt matches the quote', async () => {
  const h = await harness({ policy: configuredPolicy });
  chooseDelivery(h);
  await h.node('delivery-quote-button').listeners.click();
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.node('payment-element').hidden, true);
  assert.equal(h.calls.confirms.length, 0);
});

test('lost receipt capability blocks charge and gives the durable reference for contact', async () => {
  const h = await harness({ paymentResponse: async () => ({ data: { orderId: 'durable-order', orderName: 'Bison-42', receiptToken: null, clientSecret: 'secret', totalAmount: 10000 } }) });
  await h.context.handleOrderSubmit({ preventDefault() {} });
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.confirms.length, 0);
  assert.equal(h.node('payment-element').hidden, true);
  assert.match(h.node('payment-message').textContent, /Bison-42/);
  assert.match(h.node('payment-message').textContent, /contact/i);
  assert.equal(h.calls.payments[0].requestId, h.calls.payments[1].requestId);
});

test('changed delivery quote requires review, then mounts fields without charging', async () => {
  let quotes = 0;
  const quote = { deliveryFee: 700, totalAmount: 10700, deliveryDate: '2026-11-02' };
  const h = await harness({ policy: configuredPolicy,
    quoteResponse: async () => ({ data: ++quotes === 1 ? { deliveryFee: 500, totalAmount: 10500, deliveryDate: '2026-10-26' } : quote }),
    paymentResponse: async request => ({ data: { orderId: 'delivery-1', orderName: 'Mammoth-12', receiptToken: request.receiptToken, clientSecret: 'secret', totalAmount: 10700 } }),
    receiptResponse: async () => ({ data: quote }) });
  chooseDelivery(h);
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.payments.length, 0, 'An explicit quote action is required');
  await h.node('delivery-quote-button').listeners.click();
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.payments.length, 0, 'Changed terms must be reviewed before an order is created');
  assert.match(h.node('delivery-quote-status').textContent, /terms changed.*\$7\.00.*2026-11-02.*\$107\.00/i);
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.node('payment-element').hidden, false);
  assert.equal(h.calls.confirms.length, 0);
  assert.equal(h.calls.receipt.length, 1);
  assert.equal(h.calls.payments[0].deliveryAddress.zip, '32202');
  assert.equal('totalAmount' in h.calls.payments[0], false);
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.confirms.length, 1);
});

test('changed cart while Stripe confirmation is pending cannot redirect or clear the new cart', async () => {
  let finish;
  const h = await harness({ confirmResponse: () => new Promise(resolve => { finish = resolve; }) });
  await h.context.handleOrderSubmit({ preventDefault() {} });
  const confirmation = h.context.handleOrderSubmit({ preventDefault() {} });
  h.context.handleAddToCart('beef', 1);
  finish({ paymentIntent: { status: 'succeeded' } });
  await confirmation;
  assert.equal(h.context.window.location.href, '');
  assert.deepEqual(JSON.parse(h.storage.get('mammothCart')), { beef: 6 });
  assert.doesNotMatch(h.node('payment-message').textContent, /successful|paid/i);
});

test('setup retries reuse identical requestId and snapshot after a network failure', async () => {
  let attempts = 0;
  const h = await harness({ paymentResponse: async request => {
    if (++attempts === 1) throw new Error('network');
    return { data: { orderId: 'retry', receiptToken: request.receiptToken, clientSecret: 'secret', totalAmount: 10000 } };
  } });
  await h.context.handleOrderSubmit({ preventDefault() {} });
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.payments.length, 2);
  assert.equal(JSON.stringify(h.calls.payments[0]), JSON.stringify(h.calls.payments[1]));
  assert.equal(h.calls.confirms.length, 0);
});

test('stale quote response after address edit never restores delivery eligibility', async () => {
  let finish;
  const h = await harness({ policy: configuredPolicy, quoteResponse: () => new Promise(resolve => { finish = resolve; }) });
  chooseDelivery(h);
  const pending = h.node('delivery-quote-button').listeners.click();
  h.node('delivery-zip').value = '99999';
  h.node('order-form').listeners.input({ target: h.node('delivery-zip') });
  finish({ data: { deliveryFee: 500, totalAmount: 10500, deliveryDate: '2026-10-26' } });
  await pending;
  await h.context.handleOrderSubmit({ preventDefault() {} });
  assert.equal(h.calls.payments.length, 0);
  assert.match(h.node('delivery-quote-status').textContent, /outside/i);
});

test('card setup sends a stable client receipt proof before provider failure and rejects mismatched or missing response proof', async () => {
  let attempts = 0;
  const h = await harness({ paymentResponse: async request => {
    assert.match(request.receiptToken || '', /^[a-f0-9]{64}$/);
    assert.ok([...h.storage.entries()].some(([key, value]) => key.includes(request.requestId) && value.includes(request.receiptToken)), 'Proof persisted before network');
    if (++attempts === 1) throw new Error('provider failed');
    return { data: { orderId: 'recovered', receiptToken: request.receiptToken, clientSecret: 'secret', totalAmount: 10000 } };
  } });
  assert.equal(await h.context.preparePaymentElement(), false);
  assert.equal(await h.context.preparePaymentElement(), true);
  assert.deepEqual(h.calls.payments[0], h.calls.payments[1]);
  assert.equal(JSON.parse(h.storage.get('mammothGuestReceipt')).token, h.calls.payments[0].receiptToken);
  for (const proof of [undefined, 'cd'.repeat(32)]) {
    const invalid = await harness({ paymentResponse: async () => ({ data: { orderId: 'bad', receiptToken: proof, clientSecret: 'secret', totalAmount: 10000 } }) });
    assert.equal(await invalid.context.preparePaymentElement(), false);
    assert.equal(invalid.storage.has('mammothGuestReceipt'), false);
    assert.equal(invalid.calls.confirms.length, 0);
  }
});

test('card reload preserves the original attempt capability despite initial fulfillment rendering', async () => {
  const first = await harness({ paymentResponse: async () => { throw new Error('lost provider response'); } });
  assert.equal(await first.context.preparePaymentElement(), false);
  const retry = await harness({ savedSession: first.storage });
  assert.equal(await retry.context.preparePaymentElement(), true);
  assert.equal(JSON.stringify(retry.calls.payments[0]), JSON.stringify(first.calls.payments[0]));
});

test('card legacy persisted attempts without proof block safely rather than replacing the order', async () => {
  const storage = new Map([['mammothCart', '{"beef":5}'], ['mammothCommerceAttempt:card', 'legacy-request'], ['mammothCommerceAttempt:card:legacy-request', JSON.stringify({ requestId: 'legacy-request', signature: '{}' })]]);
  const h = await harness({ savedSession: storage });
  assert.equal(await h.context.preparePaymentElement(), false);
  assert.equal(h.calls.payments.length, 0);
  assert.match(h.node('payment-message').textContent, /capability.*unavailable.*contact/i);
  assert.equal(storage.get('mammothCommerceAttempt:card'), 'legacy-request');
});

test('Stripe redirect parameters and application errors never disclose the receipt proof', async () => {
  const h = await harness({ confirmResponse: async () => ({ error: { message: 'Provider detail ' + h.calls.payments[0].receiptToken } }) });
  await h.context.handleOrderSubmit({ preventDefault() {} });
  await h.context.handleOrderSubmit({ preventDefault() {} });
  const proof = h.calls.payments[0].receiptToken;
  assert.equal(JSON.stringify(h.calls.confirms).includes(proof), false);
  assert.equal(h.node('payment-message').textContent.includes(proof), false);
  assert.match(h.node('payment-message').textContent, /payment.*could not/i);
  assert.equal(h.context.window.location.href, '');
});

export { harness };
