'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createAdapter = require('../firebase/functions/subscription-delivery-adapter.cjs');
const functionRequire = require('node:module').createRequire(require('node:path').resolve(__dirname, '../firebase/functions/package.json'));
const functions = functionRequire('firebase-functions/v1');
const Stripe = functionRequire('stripe');

const projectId = 'demo-subscriptions-test';
const origin = 'https://demo-subscriptions-test.web.app';
const secretKey = `sk_test_${'a'.repeat(32)}`;
const webhookSecret = `whsec_${'b'.repeat(32)}`;
function fixture(overrides = {}, dependencies = {}) {
  let constructions = 0;
  const config = { enabled: false, checkoutEnabled: false, projectId, origin, secretKey, webhookSecret, ...overrides };
  const adapter = createAdapter({ functions, Stripe: (...args) => { constructions++; return new Stripe(...args); },
    getConfig: () => config, getProjectId: () => projectId,
    allowedTargets: [{ projectId, origin, appIds: ['test-app'], testerUids: ['tester'] }], db: {}, ...dependencies,
  });
  return { adapter, config, constructions: () => constructions };
}
const context = () => ({ app: { appId: 'test-app' }, auth: { uid: 'tester' }, rawRequest: { headers: { origin } } });
const sdk = new Stripe(secretKey);
const event = (change = {}) => ({ id: 'evt_transport', object: 'event', type: 'invoice.paid', api_version: '2024-06-20', livemode: false, data: { object: { id: 'in_transport', object: 'invoice' } }, ...change });
const signed = value => {
  const rawBody = Buffer.from(JSON.stringify(value));
  return { method: 'POST', rawBody, headers: { 'stripe-signature': sdk.webhooks.generateTestHeaderString({ payload: rawBody.toString(), secret: webhookSecret }) } };
};
async function webhook(adapter, request) {
  const response = { statusCode: 200, status(n) { this.statusCode = n; return this; }, send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; } };
  await adapter.stripeWebhook(request, response);
  return response;
}
function providerFixture(overrides = {}, dependencies = {}) {
  const calls = [];
  const f = fixture({ enabled: true, ...overrides }, { Stripe: (...args) => {
    assert.equal(args[0], secretKey);
    assert.equal(args[1].apiVersion, '2024-06-20');
    const client = new Stripe(...args);
    client.invoices.retrieve = async (...args) => { calls.push(args); return { id: args[0], object: 'invoice', subscription_details: { metadata: {} } }; };
    return client;
  }, ...dependencies });
  return { ...f, calls };
}

test('signed SDK webhook succeeds independently of checkout switch and ignores parsed body', async () => {
  const f = providerFixture({ checkoutEnabled: false });
  const req = signed(event()); req.body = event({ livemode: true, type: 'checkout.session.completed' });
  const res = await webhook(f.adapter, req);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'in_transport');
  assert.deepEqual(f.calls[0][2], { apiVersion: '2024-06-20' });
  await assert.rejects(f.adapter.createCheckout.run({}, context()), { code: 'failed-precondition' });
});

for (const [name, change, status] of [
  ['invalid signature', req => { req.headers['stripe-signature'] = 't=1,v1=bad'; }, 400],
  ['absent raw bytes', req => { delete req.rawBody; req.body = event(); }, 400],
  ['string raw bytes', req => { req.rawBody = req.rawBody.toString(); }, 400],
  ['changed raw bytes', req => { req.rawBody = Buffer.concat([req.rawBody, Buffer.from(' ')]); }, 400],
  ['duplicate signature header', req => { req.headers['stripe-signature'] = [req.headers['stripe-signature']]; }, 400],
  ['GET method', req => { req.method = 'GET'; }, 405],
]) test(`webhook refuses ${name}`, async () => {
  const f = providerFixture(); const req = signed(event()); change(req);
  const res = await webhook(f.adapter, req);
  assert.equal(res.statusCode, status); assert.equal(f.calls.length, 0);
});
for (const [name, change] of [
  ['live event', { livemode: true }], ['missing mode', { livemode: undefined }],
  ['Connect account', { account: 'acct_other' }], ['future version', { api_version: '2025-03-31.basil' }],
  ['missing version', { api_version: undefined }], ['non-event', { object: 'invoice' }],
  ['unsupported event', { type: 'checkout.session.completed' }],
]) test(`verified webhook refuses ${name} without provider reads`, async () => {
  const f = providerFixture(); const res = await webhook(f.adapter, signed(event(change)));
  assert.equal(res.statusCode, 400); assert.equal(f.calls.length, 0);
});

test('domain verification failure is not acknowledged or disclosed', async () => {
  const f = providerFixture({}, { Stripe: (...args) => {
    const client = new Stripe(...args);
    client.invoices.retrieve = async () => { throw new Error('private address credential request capability'); };
    return client;
  } });
  const res = await webhook(f.adapter, signed(event()));
  assert.equal(res.statusCode, 500);
  assert.equal(typeof res.body, 'string'); assert.doesNotMatch(res.body, /private|credential|capability/);
});

test('disabled by default without constructing provider or touching database', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.createCheckout.run({}, context()), e => e.code === 'failed-precondition' && !e.message.includes(secretKey));
  assert.equal(f.constructions(), 0);
});

test('authorized test selection reaches domain validation without billing', async () => {
  const f = fixture({ enabled: true, checkoutEnabled: true });
  await assert.rejects(f.adapter.createCheckout.run({}, context()), { code: 'invalid-argument' });
  assert.equal(f.constructions(), 0);
});

for (const [name, edit] of [
  ['missing App Check', c => { delete c.app; }],
  ['wrong application', c => { c.app.appId = 'foreign'; }],
  ['missing authentication', c => { delete c.auth; }],
  ['unlisted tester', c => { c.auth.uid = 'outsider'; }],
  ['missing origin', c => { delete c.rawRequest.headers.origin; }],
  ['wrong origin', c => { c.rawRequest.headers.origin = 'https://attacker.invalid'; }],
]) test(`checkout rejects ${name} before domain or SDK`, async () => {
  const f = fixture({ enabled: true, checkoutEnabled: true }); const c = context(); edit(c);
  await assert.rejects(f.adapter.createCheckout.run({}, c), { code: 'permission-denied' });
  assert.equal(f.constructions(), 0);
});

for (const secretKey of ['', 'sk_live_' + 'a'.repeat(32), 'test', ' sk_test_' + 'a'.repeat(32), 'sk_test_bad', 'sk_test_' + 'a'.repeat(32) + '\n']) {
  test('unrecognized or live provider key fails closed', async () => {
    const f = fixture({ enabled: true, checkoutEnabled: true, secretKey });
    await assert.rejects(f.adapter.createCheckout.run({}, context()), { code: 'failed-precondition' });
    assert.equal(f.constructions(), 0);
  });
}

for (const [name, overrides, dependencies] of [
  ['missing explicit allowlist', {}, { allowedTargets: [] }],
  ['runtime project mismatch', {}, { getProjectId: () => 'other-test' }],
  ['configured project mismatch', { projectId: 'other-test' }, {}],
  ['ambiguous target', {}, { allowedTargets: Array(2).fill({ projectId, origin, appIds: ['test-app'], testerUids: ['tester'] }) }],
  ['production origin even if allowlisted', { origin: 'https://mammothbroth.co' }, { allowedTargets: [{ projectId, origin: 'https://mammothbroth.co', appIds: ['test-app'], testerUids: ['tester'] }] }],
  ['production project even if allowlisted', { projectId: 'mammoth-production', origin: 'https://mammoth-production.web.app' }, { getProjectId: () => 'mammoth-production', allowedTargets: [{ projectId: 'mammoth-production', origin: 'https://mammoth-production.web.app', appIds: ['test-app'], testerUids: ['tester'] }] }],
  ['master disabled', { enabled: false }, {}],
  ['string master switch', { enabled: 'true' }, {}],
]) test(`scope guard: ${name}`, async () => {
  const f = fixture({ enabled: true, checkoutEnabled: true, ...overrides }, dependencies);
  await assert.rejects(f.adapter.createCheckout.run({}, context()), { code: 'failed-precondition' });
  const res = await webhook(f.adapter, signed(event()));
  assert.equal(res.statusCode, 503); assert.equal(f.constructions(), 0);
});

// Local synthetic policy is test data only, not tax/timing/cancellation approval.
function checkoutFixture(overrides = {}) {
  const docs = new Map(); const calls = []; let beforeCommit = () => {};
  const db = { docs, collection: name => ({ doc: id => ({ path: `${name}/${id}` }) }),
    async runTransaction(fn) {
      const draft = structuredClone(docs); let writing = false;
      const value = await fn({
        get: async r => { assert.equal(writing, false); return { data: () => structuredClone(draft.get(r.path)) }; },
        create: (r, data) => { writing = true; assert.equal(draft.has(r.path), false); draft.set(r.path, structuredClone(data)); },
        update: (r, data) => { writing = true; assert.equal(draft.has(r.path), true); draft.set(r.path, { ...draft.get(r.path), ...structuredClone(data) }); },
      });
      beforeCommit(draft); docs.clear(); for (const [key, value] of draft) docs.set(key, value);
      return value;
    },
  };
  docs.set('settings/subscriptionDelivery', { enabled: true, testMode: true, version: 'SYNTHETIC-TEST-ONLY', tax: { ready: true, mode: 'approved_no_tax', approvalReference: 'SYNTHETIC-NOT-APPROVAL' }, scheduling: { ready: true, version: 'SYNTHETIC-TEST-ONLY' }, zones: [{ id: 'synthetic-zone', state: 'FL', allowedZips: ['32204'], feeCents: 500 }] });
  const httpClient = {
    getClientName: () => 'offline-subscription-test',
    async makeRequest(host, port, path, method, headers, requestData) {
      assert.equal(host, 'api.stripe.com'); assert.equal(headers['Stripe-Version'], '2024-06-20');
      assert.equal(headers.Authorization, `Bearer ${secretKey}`);
      assert.equal(method, 'POST'); assert.equal(path, '/v1/checkout/sessions');
      const params = new URLSearchParams(requestData);
      calls.push({ params, idempotencyKey: headers['Idempotency-Key'] });
      const session = { id: 'cs_test_transport', object: 'checkout.session', mode: 'subscription', livemode: overrides.liveResponse === true, status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_test_transport', expires_at: Number(params.get('expires_at')), client_reference_id: params.get('client_reference_id'), metadata: { delivery_order_id: params.get('metadata[delivery_order_id]'), delivery_terms_hash: params.get('metadata[delivery_terms_hash]') } };
      return { getStatusCode: () => 200, getHeaders: () => ({}), getRawResponse: () => ({}), toJSON: async () => session };
    },
  };
  const f = fixture({ enabled: true, checkoutEnabled: true }, { db, now: () => 1800000000000, scheduleShipment: () => null,
    Stripe: (key, options) => new Stripe(key, { ...options, httpClient, telemetry: false }),
  });
  return { ...f, db, docs, calls, beforeCommit: fn => { beforeCommit = fn; } };
}
const selection = () => ({ requestId: 'transport-test-123456', capability: 'c'.repeat(64), cart: { prod_beef: 2, prod_chicken: 2, mushroom: 2 }, cadence: 'weekly', deliveryAddress: { street: '1 Synthetic Street', city: 'Synthetic', state: 'FL', zip: '32204' }, customerName: 'Synthetic Tester', customerEmail: 'synthetic@example.invalid' });

for (const cadence of ['weekly', 'every_two_weeks', 'monthly']) test(`authorized mixed selection uses real offline Stripe serialization: ${cadence}`, async () => {
  for (const count of [6, 12]) {
    const f = checkoutFixture(); const data = selection(); data.cadence = cadence;
    data.cart = { prod_beef: count - 4, prod_chicken: 2, mushroom: 2 };
    const result = await f.adapter.createCheckout.run(data, context());
    assert.equal(result.checkoutSessionId, 'cs_test_transport');
    assert.equal(f.calls.length, 1);
    const { params, idempotencyKey } = f.calls[0];
    assert.equal(params.get('mode'), 'subscription');
    assert.equal(params.get('automatic_tax[enabled]'), 'false');
    assert.equal(params.get('success_url'), `${origin}/subscription.html#${result.subscriptionOrderId}`);
    assert.equal(params.get('line_items[0][price_data][recurring][interval]'), cadence === 'monthly' ? 'month' : 'week');
    assert.equal(params.get('line_items[0][price_data][recurring][interval_count]'), cadence === 'every_two_weeks' ? '2' : '1');
    assert.equal(idempotencyKey, `delivery:${result.subscriptionOrderId}`);
    assert.equal(JSON.stringify(result).includes(data.capability), false);
    assert.equal(f.docs.get(`deliverySubscriptions/${result.subscriptionOrderId}`).terms.uid, 'tester');
  }
});

test('live response is rejected and not persisted as a valid session', async () => {
  const f = checkoutFixture({ liveResponse: true });
  await assert.rejects(f.adapter.createCheckout.run(selection(), context()), { code: 'failed-precondition' });
  assert.equal(f.calls.length, 1);
  assert.equal([...f.docs.values()].find(x => x.id)?.session, null);
});

test('real domain still refuses missing business approval without any provider operation', async () => {
  const f = checkoutFixture(); f.docs.delete('settings/subscriptionDelivery');
  await assert.rejects(f.adapter.createCheckout.run(selection(), context()), { code: 'failed-precondition' });
  assert.equal(f.calls.length, 0); assert.equal(f.docs.size, 0);
});

for (const [name, edit] of [
  ['checkout revoked', c => { c.checkoutEnabled = false; }],
  ['master revoked', c => { c.enabled = false; }],
  ['key switched live', c => { c.secretKey = 'sk_live_' + 'x'.repeat(32); }],
]) test(`guard rechecks before provider operation: ${name}`, async () => {
  const f = checkoutFixture(); f.beforeCommit(() => edit(f.config));
  await assert.rejects(f.adapter.createCheckout.run(selection(), context()));
  assert.equal(f.calls.length, 0);
});

for (const type of ['invoice.paid', 'invoice.payment_succeeded', 'charge.refunded', 'refund.created', 'refund.updated', 'charge.refund.updated', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated']) test(`verified router reaches domain for ${type}`, async () => {
  const reads = [];
  const kind = type.startsWith('invoice.') ? 'invoice' : type.startsWith('charge.dispute.') ? 'dispute' : type === 'charge.refunded' ? 'charge' : 'refund';
  const ids = { invoice: 'in_transport', dispute: 'dp_transport', charge: 'ch_transport', refund: 're_transport' };
  const raw = { object: kind, id: ids[kind], ...(kind === 'refund' ? {} : { livemode: false }), charge: 'ch_transport' };
  const charge = { object: 'charge', id: 'ch_transport', livemode: false, paid: true, status: 'succeeded', amount_refunded: 1, amount: 12000, currency: 'usd', payment_intent: 'pi_transport', invoice: 'in_transport' };
  const source = { ...raw, amount: 1, currency: 'usd', payment_intent: 'pi_transport' };
  const f = providerFixture({}, { Stripe: (...args) => {
    const client = new Stripe(...args);
    for (const resource of ['invoices', 'charges', 'refunds', 'disputes']) client[resource].retrieve = async (id, params, options) => {
      reads.push(resource); assert.equal(options.apiVersion, '2024-06-20');
      if (resource === 'invoices') return { id, object: 'invoice', livemode: false, subscription_details: { metadata: {} } };
      return resource === 'charges' ? charge : source;
    };
    return client;
  } });
  const res = await webhook(f.adapter, signed(event({ type, data: { object: raw } })));
  assert.equal(res.statusCode, 200);
  assert.equal(reads[0], { invoice: 'invoices', charge: 'charges', refund: 'refunds', dispute: 'disputes' }[kind]);
  assert.equal(reads.at(-1), 'invoices');
});

test('master switch stops webhook but malformed signing secret never constructs SDK', async () => {
  for (const change of [{ enabled: false }, { webhookSecret: '' }, { webhookSecret: 'whsec_bad' }, { secretKey: 'sk_live_' + 'a'.repeat(32) }]) {
    const f = fixture({ enabled: true, ...change });
    assert.equal((await webhook(f.adapter, signed(event()))).statusCode, 503);
    assert.equal(f.constructions(), 0);
  }
});

test('SDK rejects stale, wrong-secret and signed-invalid-JSON payloads', async () => {
  const f = providerFixture();
  const raw = Buffer.from('{"private":');
  const invalidJson = { method: 'POST', rawBody: raw, headers: { 'stripe-signature': sdk.webhooks.generateTestHeaderString({ payload: raw.toString(), secret: webhookSecret }) } };
  const stale = signed(event());
  stale.headers['stripe-signature'] = sdk.webhooks.generateTestHeaderString({ payload: stale.rawBody.toString(), secret: webhookSecret, timestamp: Math.floor(Date.now() / 1000) - 301 });
  const wrong = signed(event());
  wrong.headers['stripe-signature'] = sdk.webhooks.generateTestHeaderString({ payload: wrong.rawBody.toString(), secret: 'whsec_' + 'z'.repeat(32) });
  for (const req of [invalidJson, stale, wrong]) assert.equal((await webhook(f.adapter, req)).statusCode, 400);
  assert.equal(f.calls.length, 0);
});

async function withHTTP(adapter, fn) {
  const http = require('node:http'); const express = functionRequire('express'); const app = express();
  app.use(express.raw({ type: '*/*' }));
  app.post('/webhook', (req, res) => { req.rawBody = req.body; req.body = event({ livemode: true }); return adapter.stripeWebhook(req, res); });
  app.post('/checkout', (req, res) => { req.body = JSON.parse(req.body); return adapter.createCheckout(req, res); });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  try { await fn(send); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('real loopback HTTP exercises Firebase onRequest with exact signed bytes', async () => {
  const f = providerFixture(); const req = signed(event());
  await withHTTP(f.adapter, async send => {
    const success = await send('/webhook', req.rawBody, req.headers);
    assert.equal(success.status, 200); assert.deepEqual(JSON.parse(success.body), { received: true });
    const tampered = await send('/webhook', Buffer.concat([req.rawBody, Buffer.from(' ')]), req.headers);
    assert.equal(tampered.status, 400);
  });
  assert.equal(f.calls.length, 1);
});

test('checkout switch revoked at final persistence cannot expose a hosted URL', async () => {
  const f = checkoutFixture();
  f.beforeCommit(draft => { if ([...draft.values()].some(record => record.session)) f.config.checkoutEnabled = false; });
  await assert.rejects(f.adapter.createCheckout.run(selection(), context()), { code: 'failed-precondition' });
  assert.equal(f.calls.length, 1);
});

async function paidFixture() {
  const f = checkoutFixture(); const result = await f.adapter.createCheckout.run(selection(), context());
  const saved = f.docs.get(`deliverySubscriptions/${result.subscriptionOrderId}`);
  const metadata = { delivery_order_id: saved.id, delivery_terms_hash: saved.termsHash };
  const customer = 'cus_transport', subId = 'sub_transport', invoiceId = 'in_transport';
  const session = { ...saved.session, status: 'complete', subscription: subId, customer };
  const subscription = { id: subId, object: 'subscription', livemode: false, customer, metadata };
  const pi = { id: 'pi_transport', object: 'payment_intent', livemode: false, status: 'succeeded', currency: 'usd', amount: saved.terms.amount, amount_received: saved.terms.amount, customer, invoice: invoiceId, latest_charge: 'ch_transport' };
  const charge = { id: 'ch_transport', object: 'charge', livemode: false, status: 'succeeded', paid: true, captured: true, refunded: false, disputed: false, amount_refunded: 0, amount: saved.terms.amount, currency: 'usd', customer, invoice: invoiceId, payment_intent: pi.id };
  const invoice = { id: invoiceId, object: 'invoice', livemode: false, subscription: subId, customer, subscription_details: { metadata }, currency: 'usd', status: 'paid', paid: true, paid_out_of_band: false, collection_method: 'charge_automatically', billing_reason: 'subscription_create', amount_paid: saved.terms.amount, amount_due: saved.terms.amount, amount_remaining: 0, subtotal: saved.terms.amount, total: saved.terms.amount, starting_balance: 0, ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, total_discount_amounts: [], total_tax_amounts: [], amount_shipping: 0, status_transitions: { paid_at: 1800000000 }, payment_intent: pi, charge };
  const lines = { has_more: false, data: saved.terms.lines.map((line, i) => ({ type: 'subscription', subscription: subId, subscription_item: `si_${i}`, quantity: line.quantity, amount: line.quantity * line.unitAmount, currency: 'usd', proration: false, period: { start: 1800000000, end: 1800604800 }, discount_amounts: [], tax_amounts: [], price: { type: 'recurring', currency: 'usd', unit_amount: line.unitAmount, recurring: { ...saved.terms.interval, usage_type: 'licensed' }, product: { metadata: { delivery_sku: line.sku } } } })) };
  const reads = [];
  const transport = providerFixture({}, { db: f.db, getConfig: () => f.config, now: () => 1800000000000, scheduleShipment: () => null, Stripe: (...args) => {
    const client = new Stripe(...args);
    client.invoices.retrieve = async () => { reads.push('invoice'); return structuredClone(invoice); };
    client.invoices.listLineItems = async () => { reads.push('lines'); return structuredClone(lines); };
    client.subscriptions.retrieve = async () => structuredClone(subscription);
    client.checkout.sessions.list = async () => ({ has_more: false, data: [structuredClone(session)] });
    return client;
  } });
  f.config.checkoutEnabled = false;
  f.docs.get('settings/subscriptionDelivery').enabled = false;
  return { ...f, webhookAdapter: transport.adapter, reads };
}

test('already-paid webhook commits with checkout and mutable checkout policy disabled; retries only ACK after commit', async () => {
  const f = await paidFixture();
  f.beforeCommit(draft => { if (draft.has('subscriptionShipments/in_transport')) throw Error('private commit failure'); });
  assert.equal((await webhook(f.webhookAdapter, signed(event()))).statusCode, 500);
  assert.equal(f.docs.has('subscriptionShipments/in_transport'), false);
  f.beforeCommit(() => {});
  await withHTTP(f.webhookAdapter, async send => {
    const req = signed(event()); const res = await send('/webhook', req.rawBody, req.headers);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { received: true });
  });
  const shipment = structuredClone(f.docs.get('subscriptionShipments/in_transport'));
  assert.equal(shipment.paymentStatus, 'paid');
  assert.equal(shipment.fulfillmentStatus, 'needs_reconciliation');
  assert.equal(shipment.deliveryAt, null); // No approved delivery timing exists.
  assert.equal((await webhook(f.webhookAdapter, signed(event()))).statusCode, 200);
  assert.deepEqual(f.docs.get('subscriptionShipments/in_transport'), shipment);
  await assert.rejects(f.adapter.createCheckout.run(selection(), context()), { code: 'failed-precondition' });
});

test('real Firebase callable HTTP wrapper refuses body-spoofed auth and App Check', async () => {
  const f = fixture({ enabled: true, checkoutEnabled: true });
  await withHTTP(f.adapter, async send => {
    const res = await send('/checkout', JSON.stringify({ data: { ...selection(), app: { appId: 'test-app' }, auth: { uid: 'tester' } } }), { origin });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).error.status, 'UNAUTHENTICATED');
    assert.doesNotMatch(res.body, /Synthetic Street|synthetic@example|cccccccc/);
  });
  assert.equal(f.constructions(), 0);
});
