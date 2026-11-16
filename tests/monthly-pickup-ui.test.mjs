import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as commerce from '../commerce-ui.mjs';
import * as rules from '../checkout-rules.mjs';

// Browser/UI slice only: every provider boundary is a local fixture.
const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const START = '2026-11-22T15:00:00.000Z';
const END = '2026-11-22T15:30:00.000Z';

test('shop offers a clearly explained one-time monthly pickup beside legacy market pickup', async () => {
  const html = await read('shop.html');
  assert.match(html, /<input type="hidden" name="fulfillment-method" value="market_pickup">/, 'fulfillment method stays market_pickup');
  const fieldset = html.match(/<fieldset id="pickup-type-options"[\s\S]*?<\/fieldset>/)?.[0];
  assert.ok(fieldset, 'pickup type needs its own grouped radio control');
  assert.match(fieldset, /<legend[^>]*>[^<]*pickup type/i);
  assert.match(fieldset, /<input id="pickup-type-market" type="radio" name="pickup-type" value="market" checked/);
  assert.match(fieldset, /<input id="pickup-type-monthly" type="radio" name="pickup-type" value="monthly"[^>]*aria-describedby="monthly-pickup-help"/);
  const help = html.match(/<p id="monthly-pickup-help"[^>]*>([\s\S]*?)<\/p>/)?.[1] || '';
  assert.match(help, /one-time/i);
  assert.match(help, /never renews|does not renew|not auto-renew/i);
  assert.match(help, /pickup window matching market hours/i);
  assert.match(help, /once.*one alternative market|one alternative-market/i);
  assert.match(help, /until your (pickup )?window closes/i);
  assert.match(help, /up to 7 days after/i);
  assert.match(help, /private receipt/i);
  assert.doesNotMatch(help, /subscri|every month we|automatically charge/i);
});

async function loadCheckout(response) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, textContent: '', hidden: false, href: '', listeners: {}, attrs: {}, isConnected: true,
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(key, value) { this.attrs[key] = value; }, hasAttribute(key) { return key in this.attrs; },
      querySelectorAll: () => [], getClientRects: () => [{}], closest: () => null, focus() {}
    });
    return nodes.get(id);
  };
  const calls = []; const alerts = []; const storage = new Map();
  const context = vm.createContext({
    ...commerce, crypto: webcrypto, console: { error() {}, info() {}, warn() {} },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { getElementById: node, querySelector: selector => node(selector), body: { style: {} }, activeElement: null },
    window: { addEventListener() {} }, alert: message => alerts.push(message),
    createPreorder: async data => { calls.push(data); return { data: response(data) }; }
  });
  vm.runInContext((await read('dialog.mjs')).replace(/^export /gm, ''), context);
  vm.runInContext((await read('checkout.js')).replace(/^import .*;\r?\n/gm, '').replace('export async function checkout', 'async function checkout'), context);
  return { node, calls, alerts, storage, checkout: context.checkout };
}
const order = { customerName: 'Alex', customerEmail: 'alex@example.com', cart: { beef: 1 }, fulfillmentMethod: 'market_pickup', marketId: 'market_a', pickupDate: '2026-11-22', paymentMethod: 'pickup', totalAmount: 2000 };
const accepted = extra => request => ({ orderId: 'order-1', orderName: 'MB-1', receiptToken: request.receiptToken, totalAmount: 2000, marketName: 'Market A', pickupDate: '2026-11-22', ...extra });

test('checkout sends pickupType (legacy default market) and never client window times', async () => {
  const legacy = await loadCheckout(accepted({}));
  assert.ok(await legacy.checkout(order));
  assert.equal(legacy.calls[0].pickupType, 'market');
  assert.equal(legacy.calls[0].fulfillmentMethod, 'market_pickup');

  const monthly = await loadCheckout(accepted({ pickupType: 'monthly', pickupWindowStartAt: START, pickupWindowEndAt: END, marketTimezone: 'America/New_York' }));
  const saved = await monthly.checkout({ ...order, pickupType: 'monthly', pickupWindowStartAt: '2026-11-22T09:00:00Z', pickupWindowEndAt: '2026-11-22T23:00:00Z', pickupRevision: 9 });
  assert.ok(saved);
  const sent = monthly.calls[0];
  assert.equal(sent.pickupType, 'monthly');
  assert.equal(sent.fulfillmentMethod, 'market_pickup');
  for (const key of ['pickupWindowStartAt', 'pickupWindowEndAt', 'pickupRevision', 'pickupWindow']) assert.equal(key in sent, false, `${key} is server-authoritative`);
  assert.equal(saved.pickupWindowStartAt, START, 'local history uses the server window, not the client one');
  assert.equal(saved.pickupWindowEndAt, END);
  const details = monthly.node('confirmation-details').textContent;
  assert.match(details, /monthly pickup/i);
  assert.match(details, /one-time/i);
  assert.match(details, /10:00\s?AM.*10:30\s?AM/);
  assert.match(details, /pay at pickup/i);
  assert.equal(monthly.node('confirmation-receipt').hidden, false, 'receipt proof is preserved');

  const bad = await loadCheckout(accepted({}));
  assert.equal(await bad.checkout({ ...order, pickupType: 'weekly' }), null);
  assert.equal(bad.calls.length, 0, 'unknown pickup types fail closed before the provider');
});

test('checkout confirmation never invents a monthly window or type the server did not confirm', async () => {
  for (const extra of [{}, { pickupType: 'monthly' }, { pickupType: 'monthly', pickupWindowStartAt: START, pickupWindowEndAt: '2026-11-23T16:00:00.000Z' }, { pickupType: 'monthly', pickupWindowStartAt: 'soon', pickupWindowEndAt: END }]) {
    const h = await loadCheckout(accepted(extra));
    const saved = await h.checkout({ ...order, pickupType: 'monthly' });
    assert.ok(saved, 'an accepted order is never reported as failed');
    const details = h.node('confirmation-details').textContent;
    assert.doesNotMatch(details, /\d{1,2}:\d{2}\s?(AM|PM)/i, 'no unconfirmed window time');
    assert.match(details, /private receipt/i);
    assert.equal(saved.pickupWindowStartAt, undefined);
    assert.equal(h.node('confirmation-receipt').hidden, false);
    if (extra.pickupType !== 'monthly') assert.match(details, /could not be confirmed/i);
  }
});

test('shop controller reads the monthly radio, defaulting to legacy market pickup', async () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, style: {}, dataset: {}, textContent: '', options: [], attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, contains: t => false,
      replaceChildren() { this.options = []; this.value = ''; }, appendChild(o) { this.options.push(o); }, classList: { add() {}, remove() {} },
      listeners: {}, addEventListener(type, cb) { this.listeners[type] = cb; } });
    return nodes.get(id);
  };
  const calls = []; let initialize;
  const storage = new Map([['mammothCart', JSON.stringify({ beef: 1 })]]);
  const context = vm.createContext({
    crypto: webcrypto, sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    ...commerce, pickupDateOptions: market => commerce.pickupDateOptions(market, new Date('2026-11-05T12:00:00Z')), isOrderingConfigured: () => true,
    console, document: {
      getElementById: node,
      querySelector: () => ({ value: 'pickup' }),
      createElement: () => ({ value: '', textContent: '' }), querySelectorAll: () => [], addEventListener: (type, cb) => { initialize = cb; }
    },
    window: { clearTimeout() {}, setTimeout() {} },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    getProducts: async () => [{ id: 'beef', name: 'Beef Broth', price: 2000 }],
    getMarkets: async () => [{ id: 'market_a', name: 'Market A', timezone: 'America/New_York', pickupDates: ['2026-11-08'] }], getPromotionConfig: async () => ({}),
    renderProducts() {}, renderMarkets() {}, updateCartSummary() {},
    calculateCartTotal: () => ({ items: [], total: 2000, subtotal: 2000, discount: 0 }),
    checkout: async o => { calls.push(o); return null; }, STRIPE_PUBLISHABLE_KEY: 'pk_test_YOUR_KEY', ...rules
  });
  vm.runInContext((await read('app.js')).replace(/^import .*;\r?\n/gm, ''), context);
  await initialize();
  node('customer-name').value = 'Alex'; node('customer-email').value = 'alex@example.com';
  node('market-select').value = 'market_a'; node('market-select').listeners.change();
  node('pickup-date').value = '2026-11-08';
  await node('pay-at-pickup-button').listeners.click();
  assert.equal(calls[0]?.pickupType, 'market', 'legacy default is market');
  node('pickup-type-monthly').checked = true;
  node('pickup-type-monthly').value = 'weekly'; // a tampered value attribute is ignored
  await node('pay-at-pickup-button').listeners.click();
  assert.equal(calls[1]?.pickupType, 'monthly');
  assert.equal(calls[1]?.fulfillmentMethod, 'market_pickup');
  assert.equal(calls[1]?.marketId, 'market_a');
  assert.equal('pickupWindowStartAt' in calls[1], false);
});

test('store exposes the reschedulePickup callable without client schedule data', async () => {
  const source = await read('store.js');
  assert.match(source, /httpsCallable\(functions, 'reschedulePickup'\)/);
  assert.match(source, /export async function reschedulePickup\(\{ orderId, receiptToken, marketId, expectedPickupRevision \}/);
  const body = source.slice(source.indexOf('export async function reschedulePickup'));
  assert.doesNotMatch(body.slice(0, body.indexOf('\n}') + 2), /pickupWindow|pickupDate/);
});

test('receipt page has an accessible, hidden-by-default market change control', async () => {
  const html = await read('receipt.html');
  const section = html.match(/<section id="receipt-market-change"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  assert.match(section, /^<section id="receipt-market-change"[^>]*aria-labelledby="receipt-market-change-heading"[^>]*hidden/);
  assert.match(section, /<label for="receipt-market-change-select">/);
  assert.match(section, /<select id="receipt-market-change-select"[^>]*class="input-primitive"[^>]*aria-describedby="receipt-market-change-help"/);
  assert.match(section, /<button id="receipt-market-change-submit" type="button" class="btn-primitive"[^>]*disabled/);
  assert.match(section, /one time|once/i);
  assert.match(html, /id="receipt-market-change-status" role="status" aria-live="polite"/);
  assert.ok(html.indexOf('id="receipt-market-change"') > html.indexOf('id="receipt-details"'));
});

function el(tag = 'div') {
  return { tag, textContent: '', hidden: false, disabled: false, value: '', href: '', children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this[k]; },
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    addEventListener(type, fn) { this[type] = fn; } };
}
const monthlyReceipt = { orderId: 'order-1', orderName: 'MB-1', status: 'pending', paymentMethod: 'pickup', fulfillmentMethod: 'market_pickup', pickupType: 'monthly', items: [], totalAmount: 2000, marketName: 'Market A', pickupDate: '2026-11-22', pickupWindowStartAt: START, pickupWindowEndAt: END, marketTimezone: 'America/New_York', pickupRevision: 3, marketChangeEligible: true, marketChangeOptions: [{ marketId: 'market_b', marketName: 'Market B' }, { marketId: '', marketName: 'Broken' }, { marketId: 'market_c', marketName: 'Market C' }] };
async function loadReceipt({ receipt = monthlyReceipt, hash = '#order=order-1&token=private-cap', reschedule } = {}) {
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, el()); return nodes.get(id); };
  const requests = [];
  const state = { receipt };
  const context = vm.createContext({ ...commerce, URL, URLSearchParams, Intl, Date,
    location: { hash, pathname: '/receipt.html' }, history: { replaceState() {} },
    sessionStorage: { getItem() {}, setItem() {} }, window: { print() {} },
    clearOrderQr() {}, showOrderQr() {},
    document: { getElementById: node, createElement: el },
    fetch: async (url, request) => {
      const body = JSON.parse(request.body);
      requests.push({ url, request, body });
      if (url.endsWith('/getGuestReceipt')) return { ok: true, json: async () => ({ result: state.receipt }) };
      return reschedule(body, state);
    }
  });
  vm.runInContext((await read('receipt.mjs')).replace(/^import .*;\r?\n/gm, ''), context);
  await new Promise(setImmediate);
  const details = () => node('receipt-details').children.map(child => child.textContent).join('\n');
  return { node, requests, state, details };
}

test('receipt shows the server window and the market change control only for eligible monthly orders', async () => {
  const h = await loadReceipt();
  assert.match(h.details(), /Monthly pickup.*one-time/i);
  assert.match(h.details(), /Pickup window: .*10:00\s?AM.*10:30\s?AM/);
  assert.equal(h.node('receipt-market-change').hidden, false);
  const select = h.node('receipt-market-change-select');
  assert.deepEqual(select.children.map(o => o.value), ['', 'market_b', 'market_c'], 'only valid server-provided markets are offered');
  assert.equal(h.node('receipt-market-change-submit').disabled, false);

  const ineligible = [
    { pickupType: 'market' }, { pickupType: undefined }, { marketChangeEligible: false }, { marketChangeEligible: 'true' },
    { marketChangeOptions: [] }, { pickupRevision: undefined }, { status: 'cancelled' }, { status: 'completed' }, { fulfillmentMethod: 'local_delivery' }
  ];
  for (const change of ineligible) {
    const other = await loadReceipt({ receipt: { ...monthlyReceipt, ...change } });
    assert.equal(other.node('receipt-market-change').hidden, true, JSON.stringify(change));
    assert.equal(other.node('receipt-market-change-submit').disabled, true);
  }
  const noCapability = await loadReceipt({ hash: '' });
  assert.equal(noCapability.node('receipt-market-change').hidden, true, 'ID/email alone never unlocks the control');
  assert.equal(noCapability.requests.length, 0);

  const fullHoursWindow = await loadReceipt({ receipt: { ...monthlyReceipt, pickupWindowEndAt: '2026-11-22T17:00:00.000Z' } });
  assert.match(fullHoursWindow.details(), /10:00\s?AM.*12:00\s?PM/, 'accepts the authoritative full market-hours window');
  const unconfirmedWindow = await loadReceipt({ receipt: { ...monthlyReceipt, pickupWindowEndAt: '2026-11-23T17:00:00.000Z' } });
  assert.doesNotMatch(unconfirmedWindow.details(), /10:00\s?AM/);
  assert.match(unconfirmedWindow.details(), /Pickup window: not confirmed/i);
});

test('market change sends only the receipt capability, market and revision, then shows the server schedule', async () => {
  const h = await loadReceipt({ reschedule: (body, state) => {
    state.receipt = { ...monthlyReceipt, marketId: 'market_c', marketName: 'Market C', pickupDate: '2026-11-29', pickupWindowStartAt: '2026-11-29T16:00:00.000Z', pickupWindowEndAt: '2026-11-29T16:30:00.000Z', pickupRevision: 4, marketChangeEligible: false };
    return { ok: true, json: async () => ({ result: { marketId: 'market_c', marketName: 'Market C', pickupDate: '2026-11-29', pickupWindowStartAt: '2026-11-29T16:00:00.000Z', pickupWindowEndAt: '2026-11-29T16:30:00.000Z', pickupRevision: 4 } }) };
  } });
  h.node('receipt-market-change-select').value = 'market_c';
  await h.node('receipt-market-change-submit').click();
  const call = h.requests.find(r => r.url.endsWith('/reschedulePickup'));
  assert.equal(call.url, 'https://us-central1-mammoth-broth-co.cloudfunctions.net/reschedulePickup');
  assert.deepEqual(call.body, { data: { orderId: 'order-1', receiptToken: 'private-cap', marketId: 'market_c', expectedPickupRevision: 3 } });
  assert.equal(call.request.credentials, 'omit');
  assert.equal(call.request.referrerPolicy, 'no-referrer');
  const status = h.node('receipt-market-change-status').textContent;
  assert.match(status, /Market C.*2026-11-29.*11:00\s?AM.*11:30\s?AM/);
  assert.equal(h.node('receipt-market-change').hidden, true, 'one transfer: control hides after the server refresh');
  assert.match(h.details(), /Pickup: Market C 2026-11-29/);
  assert.match(h.node('receipt-status').textContent, /ready at the selected market/i, 'payment/status copy is still from the server receipt');

  const blank = await loadReceipt({ reschedule: () => { throw new Error('should not send'); } });
  await blank.node('receipt-market-change-submit').click();
  assert.equal(blank.requests.filter(r => r.url.endsWith('/reschedulePickup')).length, 0, 'no market chosen, nothing sent');
  blank.node('receipt-market-change-select').value = 'market_forged';
  await blank.node('receipt-market-change-submit').click();
  assert.equal(blank.requests.filter(r => r.url.endsWith('/reschedulePickup')).length, 0, 'only server-offered markets are sent');
});

test('market change fails closed on errors or incomplete server responses', async () => {
  const good = { marketId: 'market_b', marketName: 'Market B', pickupDate: '2026-11-29', pickupWindowStartAt: '2026-11-29T16:00:00.000Z', pickupWindowEndAt: '2026-11-29T16:30:00.000Z', pickupRevision: 4 };
  const failures = [
    () => ({ ok: false, json: async () => ({ error: { status: 'FAILED_PRECONDITION' } }) }),
    () => ({ ok: true, json: async () => ({ result: good }) }), // mutation response says success, authoritative receipt remains unchanged
    () => ({ ok: true, json: async () => ({}) }),
    () => ({ ok: true, json: async () => ({ result: { ...good, pickupWindowEndAt: undefined } }) }),
    () => ({ ok: true, json: async () => ({ result: { ...good, pickupWindowEndAt: '2026-11-29T17:00:00.000Z' } }) }),
    () => ({ ok: true, json: async () => ({ result: { ...good, marketId: 'market_c' } }) }),
    () => ({ ok: true, json: async () => ({ result: { ...good, pickupDate: '29/11/2026' } }) }),
    () => ({ ok: true, json: async () => ({ result: { ...good, pickupRevision: 3 } }) }),
    () => ({ ok: true, json: async () => ({ result: { ...good, marketName: '' } }) }),
    () => { throw new Error('offline'); }
  ];
  for (const reschedule of failures) {
    const h = await loadReceipt({ reschedule });
    h.node('receipt-market-change-select').value = 'market_b';
    await h.node('receipt-market-change-submit').click();
    const status = h.node('receipt-market-change-status').textContent;
    assert.match(status, /could not be confirmed|did not confirm/i);
    assert.doesNotMatch(status, /Market B|2026-11-29|AM|PM/);
    assert.match(h.details(), /Pickup: Market A 2026-11-22/, 'receipt reflects only the refreshed server state');
    assert.equal(h.requests.filter(r => r.url.endsWith('/getGuestReceipt')).length, 2, 'receipt is refreshed from the server after any attempt');
  }
});
