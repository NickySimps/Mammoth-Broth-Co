import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as schedule from '../schedule-helper.mjs';
import * as rules from '../checkout-rules.mjs';
import * as commerce from '../commerce-ui.mjs';
import { webcrypto } from 'node:crypto';

// Exercise the real shop handlers with isolated DOM/provider boundaries.
// No Firebase writes, emails, or payment requests are made by these tests.
async function loadShop({ failCheckout = false, checkoutImpl, savedCart = JSON.stringify({ beef: 1 }), orderingConfigured = true, markets = [{ id: 'market_atlantic', timezone: 'America/New_York', weekday: 0 }] } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', hidden: false, disabled: false, required: false, style: {},
      dataset: {}, selectedOptions: [], textContent: '',
      classList: { add() {}, remove() {} },
      listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }
    });
    return nodes.get(id);
  };
  const radios = ['market_pickup', 'local_delivery', 'special_order'].map(value => ({
    ...node(value), value
  }));
  let selected = 'market_pickup';
  const calls = [];
  const storage = new Map([['mammothCart', savedCart]]);
  let rendered = false;
  let initialize;
  const context = vm.createContext({
    crypto: webcrypto, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    ...commerce, getDeliveryPolicy: async () => null, isOrderingConfigured: () => orderingConfigured,
    console, Date, JSON, Number, Object, String, Boolean,
    document: {
      getElementById: node,
      querySelector: () => ({ value: selected }),
      querySelectorAll: selector => selector.includes('fulfillment-method') ? radios
        : ['checkout-button', 'pay-at-pickup-button', 'special-order-button'].map(node),
      addEventListener: (type, callback) => { initialize = callback; }
    },
    window: { clearTimeout() {}, setTimeout() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    getProducts: async () => [{ id: 'beef', name: 'Beef Broth', price: 2000 }],
    getMarkets: async () => markets, getPromotionConfig: async () => ({}),
    nextPickupDate: (market, now) => schedule.nextPickupDate(market, now),
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

const special = await loadShop();
await special.choose('special_order');
special.node('special-order-notes').value = 'Please make this extra spicy.';
await special.node('special-order-button').listeners.click();
assert.equal(special.calls.length, 1, 'Special-order notes must reach validation under their real field name');
assert.equal(special.calls[0].status, 'awaiting_approval');
assert.equal(special.calls[0].marketId, '', 'Special orders must not retain a stale pickup market');
assert.equal(special.node('market-select').required, false);
assert.equal(special.node('pickup-date').required, false);

const delivery = await loadShop();
await delivery.choose('local_delivery');
await delivery.node('order-form').listeners.submit({ preventDefault() {} });
assert.match(delivery.node('payment-message').textContent, /5 jars/);
assert.equal(delivery.node('checkout-button').disabled, true, 'Do not enable unconfigured Stripe checkout');

const cleared = await loadShop();
cleared.node('market-select').selectedOptions = [];
cleared.node('market-select').listeners.change();
assert.equal(cleared.node('pickup-date').value, '', 'Clearing market selection must clear pickup date without throwing');

const keyboardSpecial = await loadShop();
await keyboardSpecial.choose('special_order');
keyboardSpecial.node('special-order-notes').value = 'Please prepare a special batch.';
await keyboardSpecial.node('order-form').listeners.submit({ preventDefault() {} });
assert.equal(keyboardSpecial.calls[0].paymentMethod, 'special_order', 'Enter must submit a request, never start special-order payment');

const dates = await loadShop();
dates.context.Date = class extends Date {
  constructor(...args) { super(...(args.length ? args : [2026, 9, 22, 23, 30])); }
};
assert.equal(vm.runInContext("nextMarketDate({ timezone: 'America/New_York', pickupDates: ['2026-12-24', '2026-10-26'] })", dates.context), '2026-10-26', 'Autoselect the earliest future holiday-approved date');
assert.equal(dates.node('pickup-date').readOnly, true, 'Approved pickup dates cannot be freely edited');
assert.equal(vm.runInContext('nextMarketDate(7)', dates.context), '');
assert.equal(vm.runInContext('nextMarketDate(undefined)', dates.context), '');

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
assert.equal(unavailable.node('special-order-button').disabled, true);
await unavailable.node('pay-at-pickup-button').listeners.click();
await unavailable.node('order-form').listeners.submit({ preventDefault() {} });
await unavailable.choose('special_order');
unavailable.node('special-order-notes').value = 'Please prepare a special batch.';
await unavailable.node('special-order-button').listeners.click();
assert.equal(unavailable.node('special-order-button').disabled, true, 'Switching fulfillment must not re-enable unavailable ordering');
assert.equal(unavailable.calls.length, 0, 'Neither click nor Enter may send an unconfigured order');
assert.deepEqual(JSON.parse(unavailable.storage.get('mammothCart')), { beef: 1 });
assert.match(unavailable.node('payment-message').textContent, /ordering.*unavailable/i);

const holiday = await loadShop({ markets: [{ id: 'market_atlantic', timezone: 'America/New_York', pickupDates: ['2026-12-24', '2026-11-25'] }] });
holiday.context.Date = class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-23T02:30:00Z'])); } };
holiday.node('market-select').listeners.change();
assert.equal(holiday.node('pickup-date').value, '2026-11-25', 'Real controller must use the earliest approved holiday date');
assert.equal(holiday.node('pickup-date').readOnly, true);
holiday.node('market-select').selectedOptions[0].disabled = true;
holiday.node('market-select').listeners.change();
assert.equal(holiday.node('pickup-date').value, '', 'Unavailable options cannot auto-populate a pickup date');
const unscheduled = await loadShop({ markets: [{ id: 'market_atlantic', name: 'Sunday' }] });
assert.equal(unscheduled.node('pickup-date').value, '');
console.log('storefront handler regression tests passed');
