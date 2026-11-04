'use strict';
// OFFLINE ONLY. Invented credentials, provider objects, tax approval and Friday
// route are fixtures, NOT Stripe/Firestore evidence or owner business approval.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireFunctions = createRequire(path.resolve(__dirname, '../../firebase/functions/package.json'));
const functions = requireFunctions('firebase-functions/v1');
const Stripe = requireFunctions('stripe');
const createAdapter = require('../../firebase/functions/subscription-delivery-adapter.cjs');
const { scheduleShipment } = require('../../firebase/functions/subscription-schedule.cjs');
const { API_VERSION } = require('../../firebase/functions/subscription-delivery.cjs');
const ms = Date.parse;
const projectId = 'demo-subscriptions-test';
const origin = `https://${projectId}.web.app`;
const secretKey = 'sk_test_' + 'OfflineSyntheticOnly0000000000000';
const webhookSecret = 'whsec_' + 'OfflineSyntheticOnly0000000000000';

function policy() {
  const dates = { 2: [], 5: [] };
  for (let time = ms('2026-11-01T00:00:00Z'); time <= ms('2027-02-28T00:00:00Z'); time += 86400000) {
    const weekday = new Date(time).getUTCDay();
    if (dates[weekday]) dates[weekday].push({ date: new Date(time).toISOString().slice(0, 10), open: true });
  }
  return {
    enabled: true, testMode: true, version: 'SYNTHETIC-OFFLINE-ONLY',
    tax: { ready: true, mode: 'approved_no_tax', approvalReference: 'NOT-A-REAL-TAX-APPROVAL' },
    zones: [
      { id: 'synthetic-near', state: 'FL', allowedZips: ['32204', '32205'], feeCents: 1000 },
      { id: 'synthetic-far', state: 'FL', allowedZips: ['32233'], feeCents: 1500 },
      { id: 'synthetic-32082', state: 'FL', allowedZips: ['32082'], feeCents: 1500 },
    ],
    scheduling: {
      ready: true, version: 'SYNTHETIC-CLOCK-NOT-OWNER-APPROVAL', approvalReference: 'NOT-BUSINESS-APPROVAL', timezone: 'America/New_York',
      zones: ['synthetic-near', 'synthetic-far', 'synthetic-32082'].map(zoneId => ({ zoneId, allowedRouteIds: [zoneId === 'synthetic-32082' ? 'synthetic-tuesday' : 'synthetic-friday'] })),
      // Tuesday for 32082 follows the proposed shared route; 10:00 is invented.
      // Equal local clock times give a 24h cutoff for these non-DST fixtures.
      routes: [[2, 'synthetic-tuesday'], [5, 'synthetic-friday']].map(([weekday, id]) => ({ id, weekday, deliveryTime: '10:00', cutoff: { daysBefore: 1, time: '10:00' }, calendar: { from: '2026-11-01', through: '2027-02-28', dates: dates[weekday] } })),
      periodMapping: { mode: 'first_eligible_market_in_paid_period', approvalReference: 'SYNTHETIC-ONLY' },
      monthly: { mode: 'explicit_period_dates', approvalReference: 'SYNTHETIC-ONLY', billingTimezone: 'America/New_York', rollover: 'clamp_day', mappings: [
        { periodStart: ms('2026-11-09T05:00:00Z'), periodEnd: ms('2026-12-09T05:00:00Z'), routeId: 'synthetic-friday', date: '2026-11-13' },
        { periodStart: ms('2026-12-09T05:00:00Z'), periodEnd: ms('2027-01-09T05:00:00Z'), routeId: 'synthetic-friday', date: '2026-12-11' },
        { periodStart: ms('2026-11-09T05:00:00Z'), periodEnd: ms('2026-12-09T05:00:00Z'), routeId: 'synthetic-tuesday', date: '2026-11-10' },
        { periodStart: ms('2026-12-09T05:00:00Z'), periodEnd: ms('2027-01-09T05:00:00Z'), routeId: 'synthetic-tuesday', date: '2026-12-15' },
      ] },
    },
  };
}

// Serialized, rollback-capable Firestore-shaped fixture. JSON persistence proves
// restart/readback in THIS fixture, not real Firestore transactions or durability.
function database(directory) {
  const filename = path.join(directory, 'documents.json');
  let docs = fs.existsSync(filename) ? new Map(JSON.parse(fs.readFileSync(filename, 'utf8'))) : new Map();
  let queue = Promise.resolve(), beforeCommit = () => {};
  const db = {
    collection: name => ({ doc: id => ({ path: `${name}/${id}` }) }),
    read: key => structuredClone(docs.get(key)),
    entries: () => structuredClone([...docs]),
    beforeCommit: fn => { beforeCommit = fn; },
    runTransaction(fn) {
      const pending = queue.then(async () => {
        const draft = structuredClone(docs); let writing = false;
        const result = await fn({
          get: async ref => { assert.equal(writing, false, 'Firestore reads must precede writes'); return { data: () => structuredClone(draft.get(ref.path)) }; },
          create: (ref, data) => { writing = true; assert.equal(draft.has(ref.path), false, 'create must not overwrite'); draft.set(ref.path, structuredClone(data)); },
          update: (ref, data) => { writing = true; assert.equal(draft.has(ref.path), true, 'update requires existing record'); draft.set(ref.path, { ...draft.get(ref.path), ...structuredClone(data) }); },
        });
        beforeCommit(draft);
        fs.writeFileSync(filename + '.next', JSON.stringify([...draft]));
        fs.renameSync(filename + '.next', filename);
        docs = draft;
        return result;
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
  return db;
}

function selection({ cadence = 'weekly', zip = '32204', count = 6 } = {}) {
  return { requestId: 'offline-integration-000001', capability: 'a'.repeat(64), cart: { prod_beef: count - 4, prod_chicken: 2, mushroom: 2 }, cadence,
    deliveryAddress: { street: '1 Synthetic Street', city: 'Synthetic', state: 'FL', zip }, customerName: 'Offline Tester', customerEmail: 'offline@example.invalid' };
}

async function fixture(t, { bridgeClock = true, config: overrides = {}, businessPolicy = policy() } = {}) {
  // Do not trust a shell TMPDIR that can point at Windows' system temp.
  const scratch = path.join(process.env.LOCALAPPDATA || 'C:/Users/RenderCube/AppData/Local', 'hermes', 'cache', 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, 'subscription-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let db = database(directory), clock = ms('2026-11-09T05:00:00Z');
  if (businessPolicy) await db.runTransaction(tx => tx.create(db.collection('settings').doc('subscriptionDelivery'), businessPolicy));
  const config = { enabled: true, checkoutEnabled: true, projectId, origin, secretKey, webhookSecret, ...overrides };
  const calls = [], objects = new Map(), scheduled = [];
  let session;
  const httpClient = {
    getClientName: () => 'offline-no-network-subscription-integration',
    async makeRequest(host, port, endpoint, method, headers, requestData) {
      assert.equal(host, 'api.stripe.com');
      assert.equal(headers.Authorization, `Bearer ${secretKey}`);
      assert.equal(headers['Stripe-Version'], API_VERSION);
      const url = new URL(endpoint, 'https://offline.invalid');
      const params = new URLSearchParams(requestData);
      calls.push({ endpoint: url.pathname, query: url.searchParams, method, params, idempotencyKey: headers['Idempotency-Key'] });
      let value;
      if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        session ||= { object: 'checkout.session', id: 'cs_test_offline', livemode: false, mode: 'subscription', status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_test_offline', expires_at: Number(params.get('expires_at')), client_reference_id: params.get('client_reference_id'), metadata: { delivery_order_id: params.get('metadata[delivery_order_id]'), delivery_terms_hash: params.get('metadata[delivery_terms_hash]') } };
        value = session;
      } else if (method === 'GET' && url.pathname === '/v1/checkout/sessions') {
        assert.equal(url.searchParams.get('subscription'), 'sub_offline');
        value = { object: 'list', has_more: false, data: [session] };
      } else if (method === 'GET' && objects.has(url.pathname)) value = objects.get(url.pathname);
      else throw new Error(`Unexpected offline provider operation: ${method} ${url.pathname}`);
      return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: async () => structuredClone(value) };
    },
  };
  const sdk = new Stripe(secretKey, { httpClient, telemetry: false });
  const build = () => createAdapter({ functions, db, Stripe: (key, options) => new Stripe(key, { ...options, httpClient, telemetry: false }), getConfig: () => config,
    getProjectId: () => projectId, allowedTargets: [{ projectId, origin, appIds: ['offline-app'], testerUids: ['offline-tester'] }], now: () => clock,
    scheduleShipment: input => { const result = scheduleShipment(bridgeClock ? { ...input, evaluatedAt: clock } : input); scheduled.push({ input: structuredClone(input), result: structuredClone(result) }); return result; },
  });
  let adapter = build();
  const context = { app: { appId: 'offline-app' }, auth: { uid: 'offline-tester' }, rawRequest: { headers: { origin } } };
  async function checkout(data = selection()) { return adapter.createCheckout.run(data, context); }
  function invoice(id, start, end, { reason = 'subscription_create', paidAt = start } = {}) {
    const saved = db.entries().find(([key]) => key.startsWith('deliverySubscriptions/'))?.[1];
    assert.ok(saved, 'create actual checkout before provider invoice fixture');
    session = { ...session, status: 'complete', subscription: 'sub_offline', customer: 'cus_offline' };
    const metadata = { delivery_order_id: saved.id, delivery_terms_hash: saved.termsHash };
    objects.set('/v1/subscriptions/sub_offline', { object: 'subscription', id: 'sub_offline', livemode: false, customer: 'cus_offline', metadata });
    const charge = { object: 'charge', id: `ch_${id}`, livemode: false, status: 'succeeded', paid: true, captured: true, refunded: false, disputed: false, amount_refunded: 0, amount: saved.terms.amount, currency: 'usd', customer: 'cus_offline', invoice: id, payment_intent: `pi_${id}` };
    const pi = { object: 'payment_intent', id: `pi_${id}`, livemode: false, status: 'succeeded', amount: saved.terms.amount, amount_received: saved.terms.amount, currency: 'usd', customer: 'cus_offline', invoice: id, latest_charge: charge.id };
    const value = { object: 'invoice', id, livemode: false, subscription: 'sub_offline', customer: 'cus_offline', subscription_details: { metadata }, currency: 'usd', status: 'paid', paid: true, paid_out_of_band: false, collection_method: 'charge_automatically', billing_reason: reason, amount_paid: saved.terms.amount, amount_due: saved.terms.amount, subtotal: saved.terms.amount, total: saved.terms.amount, amount_remaining: 0, starting_balance: 0, ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, total_discount_amounts: [], total_tax_amounts: [], amount_shipping: 0, status_transitions: { paid_at: paidAt / 1000 }, payment_intent: pi, charge };
    const lines = saved.terms.lines.map((line, i) => ({ type: 'subscription', subscription: 'sub_offline', subscription_item: `si_offline_${i}`, proration: false, currency: 'usd', quantity: line.quantity, amount: line.quantity * line.unitAmount, discount_amounts: [], tax_amounts: [], period: { start: start / 1000, end: end / 1000 }, price: { type: 'recurring', currency: 'usd', unit_amount: line.unitAmount, recurring: { ...saved.terms.interval, usage_type: 'licensed' }, product: { object: 'product', id: `prod_offline_${i}`, metadata: { delivery_sku: line.sku } } } }));
    objects.set(`/v1/invoices/${id}`, value);
    objects.set(`/v1/invoices/${id}/lines`, { object: 'list', has_more: false, data: lines });
    objects.set(`/v1/charges/${charge.id}`, charge);
    return value;
  }
  function event(type, object, suffix = 'one') { return { object: 'event', id: `evt_offline_${suffix}`, api_version: API_VERSION, livemode: false, type, data: { object } }; }
  function signed(value) {
    const rawBody = Buffer.from(JSON.stringify(value));
    return { method: 'POST', rawBody, headers: { 'stripe-signature': sdk.webhooks.generateTestHeaderString({ payload: rawBody.toString(), secret: webhookSecret }) } };
  }
  async function request(req) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; } };
    await adapter.stripeWebhook(req, response);
    return response;
  }
  return { checkout, config, calls, objects, scheduled, invoice, event, signed, request,
    post: value => request(signed(value)), read: key => db.read(key), entries: () => db.entries(),
    setClock: value => { clock = value; }, beforeCommit: fn => db.beforeCommit(fn),
    restart: () => { db = database(directory); adapter = build(); },
  };
}
// Browser dependencies are injected at their actual import boundary; application,
// checkout rules and revision helpers are production sources, not reimplemented UI.
async function browserHarness() {
  const vm = require('node:vm');
  const { webcrypto } = require('node:crypto');
  const { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '../..');
  const commerce = await import(pathToFileURL(path.join(root, 'commerce-ui.mjs')));
  const rules = await import(pathToFileURL(path.join(root, 'checkout-rules.mjs')));
  const nodes = new Map(), storage = new Map([['mammothCart', JSON.stringify({ prod_beef: 2, prod_chicken: 2, mushroom: 2 })]]);
  const calls = [];
  let ready;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, disabled: false, style: {}, textContent: '', listeners: {}, attributes: {},
      setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; }, getAttribute(k) { return this.attributes[k] ?? null; },
      classList: { add() {}, remove() {} }, selectedOptions: [], addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {} });
    return nodes.get(id);
  };
  const forbidden = name => async (...args) => { calls.push({ name, args }); throw new Error(`Unexpected fallback: ${name}`); };
  const context = vm.createContext({ ...commerce, ...rules, URL, URLSearchParams, crypto: webcrypto,
    document: { getElementById: node, querySelector: () => ({ value: 'local_delivery' }), querySelectorAll: selector => selector.includes('fulfillment-method') ? [] : ['checkout-button', 'pay-at-pickup-button', 'special-order-button'].map(node), addEventListener: (type, fn) => { ready = fn; } },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    window: { location: { origin, href: '' }, clearTimeout() {}, setTimeout() {} }, console: { warn() {}, error() {} },
    STRIPE_PUBLISHABLE_KEY: 'pk_test_offline', Stripe: () => ({ elements: forbidden('elements'), confirmPayment: forbidden('confirmPayment') }),
    isOrderingConfigured: () => true,
    getProducts: async () => ['prod_beef', 'prod_chicken', 'mushroom'].map(id => ({ id, active: true, name: id, price: 2000 })),
    getMarkets: async () => [], getPromotionConfig: async () => ({}), getDeliveryPolicy: async () => ({ enabled: true, state: 'FL', allowedZips: ['32204'], minimumJars: 6, cutoffHours: 24, feeCents: 1000 }),
    renderProducts() {}, renderMarkets() {}, updateCartSummary() {}, calculateCartTotal: () => ({ items: [], total: 17000, subtotal: 17000, discount: 0 }),
    createPaymentIntent: forbidden('createPaymentIntent'), createPreorder: forbidden('createPreorder'), checkout: forbidden('specialOrder'), getGuestReceipt: forbidden('getGuestReceipt'), getDeliveryQuote: forbidden('getDeliveryQuote'),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
  await ready();
  for (const [id, value] of Object.entries({ 'customer-name': 'Offline Tester', 'customer-email': 'offline@example.invalid', 'delivery-street': '1 Synthetic Street', 'delivery-city': 'Synthetic', 'delivery-state': 'FL', 'delivery-zip': '32204', 'subscription-interval': 'weekly' })) node(id).value = value;
  context.syncFulfillmentUI();
  return { context, node, calls, storage };
}
module.exports = { fixture, policy, selection, ms, browserHarness };
