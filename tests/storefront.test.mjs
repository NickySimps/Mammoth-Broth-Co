import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as rules from '../checkout-rules.mjs';
import * as commerce from '../commerce-ui.mjs';
import { webcrypto } from 'node:crypto';

// Exercise the real shop handlers with isolated DOM/provider boundaries.
// No Firebase writes, emails, or payment requests are made by these tests.
async function loadShop({ failCheckout = false, checkoutImpl, savedCart = JSON.stringify({ beef: 1 }), orderingConfigured = true, markets = [{ id: 'market_atlantic', name: 'Atlantic Beach', timezone: 'America/New_York', pickupDates: ['2026-11-08'] }] } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', hidden: false, disabled: false, required: false, style: {},
      dataset: {}, selectedOptions: [], textContent: '', options: [], attrs: {},
      setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
      contains(target) { return target === this; },
      replaceChildren() { this.options = []; this.value = ''; }, appendChild(option) { this.options.push(option); },
      classList: { add() {}, remove() {} },
      listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }
    });
    return nodes.get(id);
  };
  const radios = ['pickup', 'online'].map(value => ({
    ...node(value), value
  }));
  let selected = 'pickup';
  const calls = [];
  const storage = new Map([['mammothCart', savedCart]]);
  let rendered = false;
  let initialize;
  const context = vm.createContext({
    crypto: webcrypto, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    ...commerce, pickupDateOptions: market => commerce.pickupDateOptions(market, new Date('2026-11-05T12:00:00Z')), isOrderingConfigured: () => orderingConfigured,
    console, Date, JSON, Number, Object, String, Boolean,
    document: {
      getElementById: node,
      querySelector: () => ({ value: selected }),
      createElement: () => ({ value: '', textContent: '' }),
      querySelectorAll: selector => selector.includes('payment-method') ? radios : [],
      addEventListener: (type, callback) => { initialize = callback; }
    },
    window: { clearTimeout() {}, setTimeout() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    getProducts: async () => [{ id: 'beef', name: 'Beef Broth', price: 2000 }],
    getMarkets: async () => markets, getPromotionConfig: async () => ({}),
    renderProducts() { rendered = true; }, renderMarkets() {}, updateCartSummary() {},
    calculateCartTotal: () => ({ items: [], total: 2000, subtotal: 2000, discount: 0 }),
    checkout: async order => { calls.push(order); return checkoutImpl ? checkoutImpl(order) : failCheckout ? null : order; },
    STRIPE_PUBLISHABLE_KEY: 'pk_test_YOUR_REAL_PUBLISHABLE_KEY',
    ...rules
  });
  const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  await initialize();
  node('customer-name').value = 'Alex';
  node('customer-email').value = 'alex@example.com';
  node('market-select').value = 'market_atlantic';
  node('market-select').selectedOptions = [{ textContent: 'Atlantic Beach', dataset: { weekday: '0' } }];
  node('market-select').listeners.change();
  node('pickup-date').value = node('pickup-date').options[1]?.value || '';
  return { node, calls, storage, context, rendered, async choose(method) {
    selected = method;
    radios.find(radio => radio.value === method).listeners.change();
  } };
}

const shop = await loadShop();
await shop.node('pay-at-pickup-button').listeners.click();
assert.equal(shop.calls.length, 1, 'Valid pickup must reach checkout, not fail fulfillment validation');
assert.equal(shop.calls[0].fulfillmentMethod, 'market_pickup');
assert.equal(shop.calls[0].paymentMethod, 'pickup');
assert.deepEqual(JSON.parse(shop.storage.get('mammothCart')), {}, 'Clear cart only after a successful order');

const failed = await loadShop({ failCheckout: true });
await failed.node('pay-at-pickup-button').listeners.click();
assert.deepEqual(JSON.parse(failed.storage.get('mammothCart')), { beef: 1 });

const online = await loadShop();
await online.choose('online');
await online.node('order-form').listeners.submit({ preventDefault() {} });
assert.match(online.node('payment-message').textContent, /online payment is not configured/i);
assert.equal(online.node('checkout-button').disabled, true, 'Do not enable unconfigured Stripe checkout');
assert.equal(online.calls.length, 0, 'An online choice must never silently reserve a pay-at-pickup order');

const cleared = await loadShop();
cleared.node('market-select').selectedOptions = [];
cleared.node('market-select').value = '';
cleared.node('market-select').listeners.change();
assert.equal(cleared.node('pickup-date').value, '', 'Clearing market selection must clear pickup date without throwing');

const dates = await loadShop();
assert.deepEqual(dates.node('pickup-date').options.map(option => option.value), ['', '2026-11-08'], 'Only the next approved date is offered in the picker');
assert.equal(dates.node('pickup-date').disabled, false);
const unlisted = await loadShop();
unlisted.node('pickup-date').value = '2026-11-09';
await unlisted.node('pay-at-pickup-button').listeners.click();
assert.equal(unlisted.calls.length, 0, 'A tampered date must not bypass the listed schedule');
assert.match(unlisted.node('payment-message').textContent, /available listed pickup date/i);

const badQuantity = await loadShop({ savedCart: '{}' });
for (const quantity of [-1, 0, 1.5, NaN]) {
  vm.runInContext(`handleAddToCart('beef', ${String(quantity)})`, badQuantity.context);
}
assert.deepEqual(JSON.parse(badQuantity.storage.get('mammothCart')), {}, 'Invalid product quantities must not enter the cart');

const damagedCart = await loadShop({ savedCart: 'not-json' });
assert.equal(damagedCart.rendered, true, 'Corrupt cached cart must not prevent catalog rendering');

const keyboardPickup = await loadShop();
await keyboardPickup.node('order-form').listeners.submit({ preventDefault() {} });
assert.equal(keyboardPickup.calls[0]?.paymentMethod, 'pickup', 'Enter should reserve pickup when online payment is unavailable');

let release;
const busy = await loadShop({ checkoutImpl: () => new Promise(resolve => { release = resolve; }) });
const first = busy.node('pay-at-pickup-button').listeners.click();
const second = busy.node('pay-at-pickup-button').listeners.click();
assert.equal(busy.calls.length, 1, 'Concurrent checkout events must not submit twice');
release({ orderName: 'Test' });
await Promise.all([first, second]);

const unavailable = await loadShop({ orderingConfigured: false });
assert.equal(unavailable.node('pay-at-pickup-button').disabled, true, 'Unavailable pickup must not appear actionable');
await unavailable.node('pay-at-pickup-button').listeners.click();
await unavailable.node('order-form').listeners.submit({ preventDefault() {} });
await unavailable.choose('online');
assert.equal(unavailable.node('checkout-button').disabled, true, 'Changing payment must not re-enable unavailable ordering');
await unavailable.node('order-form').listeners.submit({ preventDefault() {} });
await unavailable.choose('pickup');
await unavailable.node('pay-at-pickup-button').listeners.click();
assert.equal(unavailable.calls.length, 0, 'Neither click nor Enter may send an unconfigured order');
assert.deepEqual(JSON.parse(unavailable.storage.get('mammothCart')), { beef: 1 });
assert.match(unavailable.node('payment-message').textContent, /ordering.*unavailable/i);

const holiday = await loadShop({ markets: [{ id: 'market_atlantic', timezone: 'America/New_York', pickupDates: ['2026-12-24', '2026-11-25'] }] });
assert.deepEqual(holiday.node('pickup-date').options.map(option => option.value), ['', '2026-11-25'], 'Real controller must offer only the earliest approved holiday date');
assert.equal(holiday.node('pickup-date').value, '2026-11-25');
const inactive = await loadShop({ markets: [{ id: 'market_atlantic', active: false, timezone: 'America/New_York', pickupDates: ['2026-11-08'] }] });
assert.equal(inactive.node('pickup-date').value, '');
assert.equal(inactive.node('pickup-date').disabled, true);
await inactive.node('pay-at-pickup-button').listeners.click();
assert.equal(inactive.calls.length, 0, 'An inactive market cannot reserve a pickup');
const unscheduled = await loadShop({ markets: [{ id: 'market_atlantic', name: 'Sunday' }] });
assert.equal(unscheduled.node('pickup-date').value, '');
console.log('storefront handler regression tests passed');
