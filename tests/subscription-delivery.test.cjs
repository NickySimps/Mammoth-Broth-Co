"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const createSubscriptions = require('../firebase/functions/subscription-delivery.cjs');

// Serialized, atomic, rollback-capable Firestore-shaped fixture (no provider/network actions).
function memoryDB() {
  const docs = new Map(); let tail = Promise.resolve(); let failShipmentCommit = false; let failHoldCommit = false;
  const ref = (collection, id) => ({ path: `${collection}/${id}`, id });
  return {
    set failShipmentCommit(value) { failShipmentCommit = value; },
    set failHoldCommit(value) { failHoldCommit = value; },
    docs, collection: name => ({ doc: id => ref(name, id) }),
    runTransaction: fn => {
      const run = tail.then(async () => {
        const draft = structuredClone(docs); let writing = false;
        const value = await fn({
          get: async r => { assert.equal(writing, false, 'Firestore reads precede writes'); const data = draft.get(r.path); return { exists: !!data, data: () => structuredClone(data) }; },
          create: (r, data) => { writing = true; assert.ok(!draft.has(r.path)); draft.set(r.path, structuredClone(data)); },
          update: (r, data) => { writing = true; assert.ok(draft.has(r.path)); draft.set(r.path, { ...draft.get(r.path), ...structuredClone(data) }); },
        });
        if (failShipmentCommit && [...draft.keys()].some(k => k.startsWith('subscriptionShipments/') && !docs.has(k))) { failShipmentCommit = false; throw Error('injected commit failure'); }
        if (failHoldCommit && [...draft.keys()].some(k => k.startsWith('subscriptionPaymentHolds/') && !docs.has(k))) { failHoldCommit = false; throw Error('injected hold commit failure'); }
        docs.clear(); for (const [k,v] of draft) docs.set(k,v); return value;
      });
      tail = run.catch(() => {}); return run;
    },
  };
}
class DomainError extends Error { constructor(code, message) { super(message); this.code = code; } }
const request = () => ({ requestId: 'request-1234567890', capability: 'a'.repeat(64), cart: { prod_beef: 2, prod_chicken: 3, mushroom: 1 }, cadence: 'every_two_weeks', deliveryAddress: { street: '1 Test Street', city: 'Test City', state: 'FL', zip: '32204' }, customerName: 'Test Buyer', customerEmail: 'buyer@example.invalid' });
function fixture() {
  const db = memoryDB(); const calls = []; const sessions = new Map(); let clock = 1800000000000;
  const policy = { enabled: true, testMode: true, version: 'test-v1', tax: { ready: true, mode: 'approved_no_tax', approvalReference: 'TEST ONLY' }, scheduling: { ready: true, version: 'test-schedule' }, zones: [{ id: 'test-zone', state: 'FL', allowedZips: ['32204'], feeCents: 1000 }] };
  db.docs.set('settings/subscriptionDelivery', policy);
  const stripe = { checkout: { sessions: {
    create: async (params, opts) => { calls.push({ params, opts }); const existing = sessions.get(opts.idempotencyKey); if (existing) { assert.deepEqual(existing.params, params); return structuredClone(existing.session); } const session = { id: 'cs_test_1', object: 'checkout.session', mode: 'subscription', livemode: false, status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_test_1', expires_at: params.expires_at, metadata: params.metadata, client_reference_id: params.client_reference_id, subscription: null, customer: null }; sessions.set(opts.idempotencyKey, { params, session }); return structuredClone(session); },
  } } };
  const options = { db, stripe, HttpsError: DomainError, now: () => clock, origin: 'https://shop.example.invalid', scheduleShipment: async ({ paidAt }) => ({ cutoffAt: paidAt + 3600000, deliveryAt: paidAt + 86400000 }) };
  const api = createSubscriptions(options);
  return { db, calls, sessions, stripe, policy, options, api, context: { app: { appId: 'verified-at-entrypoint' }, auth: { uid: 'buyer-1' } }, setClock: n => { clock = n; } };
}

function paidProvider(f, result, invoiceId = 'in_first') {
  const saved = f.db.docs.get(`deliverySubscriptions/${result.subscriptionOrderId}`);
  const metadata = { delivery_order_id: saved.id, delivery_terms_hash: saved.termsHash };
  const session = { ...saved.session, status: 'complete', payment_status: 'paid', subscription: 'sub_test_1', customer: 'cus_test_1', metadata: structuredClone(metadata) };
  const subscription = { id: 'sub_test_1', object: 'subscription', livemode: false, customer: 'cus_test_1', metadata: structuredClone(metadata), status: 'active' };
  const invoice = { id: invoiceId, object: 'invoice', livemode: false, subscription: subscription.id, customer: subscription.customer, subscription_details: { metadata }, currency: 'usd', status: 'paid', paid: true, paid_out_of_band: false, collection_method: 'charge_automatically', billing_reason: invoiceId === 'in_first' ? 'subscription_create' : 'subscription_cycle', amount_paid: saved.terms.amount, amount_due: saved.terms.amount, amount_remaining: 0, subtotal: saved.terms.amount, total: saved.terms.amount, starting_balance: 0, ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, total_discount_amounts: [], total_tax_amounts: [], amount_shipping: 0, status_transitions: { paid_at: 1800000000 }, payment_intent: { id: `pi_${invoiceId}`, object: 'payment_intent', status: 'succeeded', amount: saved.terms.amount, amount_received: saved.terms.amount, currency: 'usd', customer: subscription.customer, invoice: invoiceId, livemode: false, latest_charge: `ch_${invoiceId}` }, charge: { id: `ch_${invoiceId}`, object: 'charge', paid: true, captured: true, status: 'succeeded', refunded: false, disputed: false, amount_refunded: 0, amount: saved.terms.amount, currency: 'usd', customer: subscription.customer, invoice: invoiceId, payment_intent: `pi_${invoiceId}`, livemode: false } };
  const lines = { object: 'list', has_more: false, data: saved.terms.lines.map((l,i) => ({ id: `il_${i}`, object: 'line_item', type: 'subscription', subscription: subscription.id, subscription_item: `si_${i}`, quantity: l.quantity, amount: l.quantity*l.unitAmount, currency: 'usd', proration: false, period: { start: 1800000000, end: 1801209600 }, discount_amounts: [], tax_amounts: [], price: { id: `price_${i}`, object: 'price', type: 'recurring', currency: 'usd', unit_amount: l.unitAmount, recurring: { ...saved.terms.interval, usage_type: 'licensed' }, product: { id: `prod_stripe_${i}`, object: 'product', metadata: { delivery_sku: l.sku } } } })) };
  f.stripe.invoices = { retrieve: async id => { assert.equal(id,invoice.id); return structuredClone(invoice); }, listLineItems: async id => { assert.equal(id,invoice.id); return structuredClone(lines); } };
  f.stripe.subscriptions = { retrieve: async id => { assert.equal(id,subscription.id); return structuredClone(subscription); } };
  f.stripe.checkout.sessions.list = async params => { assert.equal(params.subscription,subscription.id); return { object: 'list', has_more: false, data: [structuredClone(session)] }; };
  const event = { id: `evt_${invoiceId}`, object: 'event', api_version: '2024-06-20', livemode: false, type: 'invoice.paid', data: { object: { id: invoiceId, object: 'invoice' } } };
  return { event, invoice, lines, session, subscription };
}

for (const [name, change] of [
  ['5 jars', r => { r.cart = { prod_beef: 5 }; }],
  ['13 jars', r => { r.cart = { prod_beef: 13 }; }],
  ['fractional jars', r => { r.cart.prod_beef = 2.5; }],
  ['negative jars', r => { r.cart.prod_beef = -1; }],
  ['string quantity', r => { r.cart.prod_beef = '2'; }],
  ['unknown SKU', r => { r.cart = { arbitrary: 6 }; }],
  ['legacy mistaken mushroom SKU', r => { r.cart = { prod_mushroom: 6 }; }],
  ['one-time cadence', r => { r.cadence = 'one_time'; }],
  ['unknown cadence', r => { r.cadence = 'every_14_days'; }],
  ['mailbox list', r => { r.customerEmail = 'a@example.invalid,b@example.invalid'; }],
  ['missing capability', r => { delete r.capability; }],
  ['malformed capability', r => { r.capability = 'a'.repeat(63); }],
  ['out-of-zone ZIP', r => { r.deliveryAddress.zip = '99999'; }],
  ['blank street', r => { r.deliveryAddress.street = ' '; }],
]) test(`input boundary refuses ${name} without billing`, async () => {
  const f = fixture(), r = request(); change(r);
  await assert.rejects(f.api.createCheckout(r,f.context));
  assert.equal(f.calls.length,0);
});

for (const [name, change] of [
  ['disabled', p => { p.enabled = false; }],
  ['live mode', p => { p.testMode = false; }],
  ['tax unconfirmed', p => { p.tax.ready = false; }],
  ['tax unspecified', p => { delete p.tax; }],
  ['unsupported tax', p => { p.tax.mode = 'automatic'; }],
  ['schedule unconfirmed', p => { p.scheduling.ready = false; }],
  ['schedule unspecified', p => { delete p.scheduling; }],
  ['ambiguous zones', p => { p.zones.push({ ...p.zones[0] }); }],
  ['negative delivery fee', p => { p.zones[0].feeCents = -1; }],
]) test(`policy fails closed: ${name}`, async () => {
  const f = fixture(); change(f.policy);
  await assert.rejects(f.api.createCheckout(request(),f.context), { code: 'failed-precondition' });
  assert.equal(f.calls.length,0);
  assert.equal(f.db.docs.size,1);
});

for (const cadence of ['weekly','every_two_weeks','monthly']) test(`${cadence} accepts inclusive 6/12 jar limits`, async () => {
  for (const quantity of [6,12]) {
    const f = fixture();
    await f.api.createCheckout({ ...request(), cadence, cart: { prod_beef: quantity } }, f.context);
    assert.deepEqual(f.calls[0].params.line_items.map(x => x.price_data.recurring), Array(2).fill(cadence === 'monthly' ? { interval: 'month', interval_count: 1 } : { interval: 'week', interval_count: cadence === 'weekly' ? 1 : 2 }));
  }
});

test('capability, payload and original UID authorize replay; policy changes cannot reprice pending retry', async () => {
  const f = fixture();
  const create = f.stripe.checkout.sessions.create;
  let once = true;
  f.stripe.checkout.sessions.create = async (p,o) => { const result = await create(p,o); if (once) { once = false; throw Error('lost response'); } return result; };
  await assert.rejects(f.api.createCheckout(request(),f.context), { code: 'unavailable' });
  f.db.docs.get('settings/subscriptionDelivery').zones[0].feeCents = 9999;
  for (const [r,context] of [
    [{ ...request(), capability: 'b'.repeat(64) },f.context],
    [{ ...request(), cart: { prod_beef: 6 } },f.context],
    [request(),{ ...f.context, auth: { uid: 'other-user' } }],
    [request(),{ ...f.context, auth: null }],
  ]) await assert.rejects(f.api.createCheckout(r,context), { code: 'permission-denied' });
  const result = await f.api.createCheckout(request(),f.context);
  assert.equal(result.amountPerDelivery,15000);
  assert.equal(f.sessions.size,1);
  assert.deepEqual(f.calls[0],f.calls[1]);
  f.setClock(1800000000000+23*3600000);
  await assert.rejects(f.api.createCheckout(request(),f.context),{ code: 'permission-denied' });
});

test('missing App Check context and invalid origins fail before provider work', async () => {
  const f = fixture();
  await assert.rejects(f.api.createCheckout(request(),{}), { code: 'unauthenticated' });
  for (const origin of [undefined,'http://shop.example.invalid','https://evil:pass@shop.example.invalid','https://shop.example.invalid/subpath','https://shop.example.invalid?token=x']) {
    const api = createSubscriptions({ ...f.options, origin });
    await assert.rejects(api.createCheckout(request(),f.context), { code: 'failed-precondition' });
  }
  assert.equal(f.calls.length,0);
});

for (const [name, change] of [
  ['unpaid invoice', p => { p.invoice.paid = false; }],
  ['manual settlement', p => { p.invoice.paid_out_of_band = true; }],
  ['manual invoice', p => { p.invoice.billing_reason = 'manual'; }],
  ['live invoice', p => { p.invoice.livemode = true; }],
  ['foreign currency', p => { p.invoice.currency = 'eur'; }],
  ['underpaid invoice', p => { p.invoice.amount_paid--; }],
  ['discounted invoice', p => { p.invoice.total_discount_amounts = [{ amount: 1 }]; }],
  ['tax drift', p => { p.invoice.total_tax_amounts = [{ amount: 1 }]; }],
  ['customer credit', p => { p.invoice.starting_balance = -1; }],
  ['credit note', p => { p.invoice.post_payment_credit_notes_amount = 1; }],
  ['invoice metadata drift', p => { p.invoice.subscription_details.metadata.delivery_terms_hash = 'wrong'; }],
  ['subscription metadata drift', p => { p.subscription.metadata.delivery_terms_hash = 'wrong'; }],
  ['foreign checkout', p => { p.session.client_reference_id = 'other'; }],
  ['foreign session customer', p => { p.session.customer = 'cus_other'; }],
  ['foreign subscription customer', p => { p.subscription.customer = 'cus_other'; }],
  ['payment intent not settled', p => { p.invoice.payment_intent.status = 'processing'; }],
  ['foreign payment intent invoice', p => { p.invoice.payment_intent.invoice = 'in_other'; }],
  ['refunded charge', p => { p.invoice.charge.refunded = true; }],
  ['disputed charge', p => { p.invoice.charge.disputed = true; }],
  ['charge payment mismatch', p => { p.invoice.charge.payment_intent = 'pi_other'; }],
  ['truncated lines', p => { p.lines.has_more = true; }],
  ['extra lines', p => { p.lines.data.push(structuredClone(p.lines.data[0])); }],
  ['changed quantity', p => { p.lines.data[0].quantity++; }],
  ['wrong amount', p => { p.lines.data[0].price.unit_amount++; }],
  ['wrong product', p => { p.lines.data[0].price.product.metadata.delivery_sku = 'prod_unknown'; }],
  ['wrong interval', p => { p.lines.data[0].price.recurring.interval = 'month'; }],
  ['prorated invoice', p => { p.lines.data[0].proration = true; }],
  ['period mismatch', p => { p.lines.data[0].period.start++; }],
  ['unsupported webhook version', p => { p.event.api_version = '2025-03-31.basil'; }],
  ['live webhook', p => { p.event.livemode = true; }],
  ['connected account', p => { p.event.account = 'acct_other'; }],
]) test(`fulfillment rejects ${name} without creating any shipment`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  change(p);
  await assert.rejects(f.api.processStripeEvent(p.event), { code: 'failed-precondition' });
  assert.equal([...f.db.docs.keys()].filter(k => k.startsWith('subscriptionShipments/')).length,0);
});

for (const [name, change] of [
  ['blank name', r => { r.customerName = '   '; }],
  ['state outside ZIP zone', r => { r.deliveryAddress.state = 'CA'; }],
]) test(`checkout refuses ${name} before provider work`, async () => {
  const f = fixture(), r = request(); change(r);
  await assert.rejects(f.api.createCheckout(r,f.context));
  assert.equal(f.calls.length,0);
});

test('concurrent checkout attempts share one durable record and Stripe idempotency key', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 12 },() => f.api.createCheckout(request(),f.context)));
  assert.equal(new Set(results.map(r => r.checkoutSessionId)).size,1);
  assert.equal(f.sessions.size,1);
  assert.equal(f.db.docs.size,2);
  for (const call of f.calls) {
    assert.equal(call.opts.idempotencyKey,f.calls[0].opts.idempotencyKey);
    assert.deepEqual(call.params,f.calls[0].params);
    assert.ok(!JSON.stringify(call).includes(request().capability));
  }
});

test('copied metadata on another subscription cannot fulfill against an already-bound order', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context);
  const first = paidProvider(f,result); await f.api.processStripeEvent(first.event);
  const next = paidProvider(f,result,'in_copy');
  next.subscription.id = 'sub_other'; next.invoice.subscription = 'sub_other'; next.session.subscription = 'sub_other';
  for (const line of next.lines.data) line.subscription = 'sub_other';
  await assert.rejects(f.api.processStripeEvent(next.event),{ code: 'failed-precondition' });
  assert.ok(!f.db.docs.has('subscriptionShipments/in_copy'));
});

test('malformed or duplicate-identity zone configuration fails closed with a domain error', async () => {
  for (const zones of [[null],[{ id: 'same', state: 'FL', allowedZips: ['32204'], feeCents: 1000 },{ id: 'same', state: 'FL', allowedZips: ['32205'], feeCents: 1500 }]]) {
    const f = fixture(); f.policy.zones = zones;
    await assert.rejects(f.api.createCheckout(request(),f.context), { code: 'failed-precondition' });
    assert.equal(f.calls.length,0);
  }
});

test('stored frozen terms must still match their invoice-bound digest', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  f.db.docs.get(`deliverySubscriptions/${result.subscriptionOrderId}`).terms.deliveryAddress.street = 'Other location';
  await assert.rejects(f.api.processStripeEvent(p.event),{ code: 'failed-precondition' });
  assert.ok(!f.db.docs.has('subscriptionShipments/in_first'));
});

test('webhook recovers a session lost before checkout persistence without requiring browser retry', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  f.db.docs.get(`deliverySubscriptions/${result.subscriptionOrderId}`).session = null;
  assert.equal((await f.api.processStripeEvent(p.event)).created,true);
  const saved = f.db.docs.get(`deliverySubscriptions/${result.subscriptionOrderId}`);
  assert.equal(saved.session.id,p.session.id); assert.equal(saved.subscriptionId,p.subscription.id);
});

test('atomic shipment commit failure leaves no binding or shipment and retries safely', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  const snapshot = structuredClone(f.db.docs); f.db.failShipmentCommit = true;
  await assert.rejects(f.api.processStripeEvent(p.event),/injected commit failure/);
  assert.deepEqual(f.db.docs,snapshot);
  assert.equal((await f.api.processStripeEvent(p.event)).created,true);
  assert.equal((await f.api.processStripeEvent(p.event)).created,false);
});

test('scheduling transient failure is retriable; missed cutoff records paid reconciliation, never a delivery promise', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  const broken = createSubscriptions({ ...f.options, scheduleShipment: async () => { throw Error('temporary failure'); } });
  await assert.rejects(broken.processStripeEvent(p.event),{ code: 'unavailable' });
  assert.ok(!f.db.docs.has(`subscriptionShipments/${p.invoice.id}`));
  const late = createSubscriptions({ ...f.options, scheduleShipment: async ({ paidAt }) => ({ cutoffAt: paidAt-1, deliveryAt: paidAt+86400000 }) });
  const reply = await late.processStripeEvent(p.event); assert.equal(reply.fulfillmentStatus,'needs_reconciliation');
  const saved = f.db.docs.get(`subscriptionShipments/${p.invoice.id}`);
  assert.equal(saved.paymentStatus,'paid'); assert.equal(saved.deliveryAt,null); assert.equal(saved.cutoffAt,null);
  const snapshot = structuredClone(saved);
  await f.api.processStripeEvent(p.event);
  assert.deepEqual(f.db.docs.get(`subscriptionShipments/${p.invoice.id}`),snapshot);
});

test('renewal before initial invoice, then canceled subscription, never regresses or duplicates immutable shipments', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context);
  const renewal = paidProvider(f,result,'in_renewal');
  const shift = 1209600; f.setClock((1800000000+shift)*1000);
  renewal.invoice.status_transitions.paid_at += shift;
  for (const l of renewal.lines.data) { l.period.start += shift; l.period.end += shift; }
  assert.equal((await f.api.processStripeEvent(renewal.event)).fulfillmentStatus,'scheduled');
  const initial = paidProvider(f,result); initial.subscription.status = 'canceled';
  assert.equal((await f.api.processStripeEvent(initial.event)).fulfillmentStatus,'needs_reconciliation');
  const snapshots = structuredClone(f.db.docs);
  await f.api.processStripeEvent(initial.event);
  assert.deepEqual(f.db.docs,snapshots);
  assert.equal([...f.db.docs.keys()].filter(k => k.startsWith('subscriptionShipments/')).length,2);
});

test('delayed paid webhook past cutoff reconciles; exact cutoff still schedules', async () => {
  for (const delay of [3600000,3600001]) {
    const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
    f.setClock(1800000000000+delay);
    assert.equal((await f.api.processStripeEvent(p.event)).fulfillmentStatus,delay === 3600000 ? 'scheduled' : 'needs_reconciliation');
  }
});

function adverseProvider(f,p,type = 'charge.refunded') {
  const charge = structuredClone(p.invoice.charge);
  charge.amount_refunded = 1;
  f.stripe.charges = { retrieve: async id => { assert.equal(id,charge.id); return structuredClone(charge); } };
  const dispute = { id: 'dp_test', object: 'dispute', amount: charge.amount, currency: charge.currency, charge: charge.id, payment_intent: charge.payment_intent, livemode: false };
  f.stripe.disputes = { retrieve: async () => structuredClone(dispute) };
  // Stripe Refund has no livemode; mode comes from the verified event and bound Charge.
  const refund = { id: 're_test', object: 'refund', amount: 1, currency: 'usd', charge: charge.id, payment_intent: charge.payment_intent, status: 'succeeded' };
  f.stripe.refunds = { retrieve: async () => structuredClone(refund) };
  const object = type.startsWith('charge.dispute.') ? dispute : type === 'charge.refunded' ? charge : refund;
  const event = { ...p.event, id: 'evt_adverse', type, data: { object } };
  return { event, charge, dispute, refund };
}

for (const type of ['refund.updated','charge.dispute.created']) for (const [name, mutate] of [
  ['zero amount', a => { a.source.amount = 0; }],
  ['fractional amount', a => { a.source.amount = 0.5; }],
  ['excess amount', a => { a.source.amount = a.charge.amount+1; }],
  ['currency mismatch', a => { a.source.currency = 'eur'; }],
  ['missing intent', a => { a.source.payment_intent = null; }],
  ['foreign intent', a => { a.source.payment_intent = 'pi_foreign'; }],
  ['live bound charge', a => { a.charge.livemode = true; }],
  ['foreign charge customer', a => { a.charge.customer = 'cus_foreign'; }],
]) test(`adverse retrieved schema boundary ${type}: ${name}`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  await f.api.processStripeEvent(p.event);
  const a = adverseProvider(f,p,type); a.source = type === 'refund.updated' ? a.refund : a.dispute;
  a.event = structuredClone(a.event); // Event alone must never authorize a hold.
  mutate(a);
  const before = structuredClone(f.db.docs);
  await assert.rejects(f.api.processStripeEvent(a.event), { code: 'failed-precondition' });
  assert.deepEqual(f.db.docs,before);
});

for (const [name, mutate] of [
  ['full refund', p => { p.invoice.charge.refunded = true; p.invoice.charge.amount_refunded = p.invoice.charge.amount; }],
  ['dispute', p => { p.invoice.charge.disputed = true; }],
  ['partial refund', p => { p.invoice.charge.amount_refunded = 1; }],
]) test(`adverse paid replay fences scheduled history before rejecting: ${name}`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  await f.api.processStripeEvent(p.event);
  const before = structuredClone(f.db.docs.get('subscriptionShipments/in_first'));
  mutate(p);
  // Mutable billing exceptions and line/scheduler outages cannot leave a known payment dispatchable.
  p.invoice.post_payment_credit_notes_amount = 1;
  f.stripe.invoices.listLineItems = async () => { throw Error('lines offline'); };
  const api = createSubscriptions({ ...f.options, scheduleShipment: async () => { throw Error('must not reschedule'); } });
  await assert.rejects(api.processStripeEvent(p.event), { code: 'failed-precondition' });
  const shipment = f.db.docs.get('subscriptionShipments/in_first');
  assert.deepEqual(shipment,{ ...before, fulfillmentStatus: 'needs_reconciliation', reconciliationReason: 'refund_or_dispute', cutoffAt: null, deliveryAt: null });
  assert.equal(f.db.docs.get('subscriptionPaymentHolds/in_first').chargeId,p.invoice.charge.id);
  const snapshot = structuredClone(f.db.docs);
  await assert.rejects(api.processStripeEvent(p.event), { code: 'failed-precondition' });
  assert.deepEqual(f.db.docs,snapshot);
});

for (const [name, mutate] of [
  ['unpaid', p => { p.invoice.paid = false; }],
  ['live charge', p => { p.invoice.charge.livemode = true; }],
  ['underpaid', p => { p.invoice.amount_paid--; }],
  ['foreign intent', p => { p.invoice.charge.payment_intent = 'pi_other'; }],
  ['foreign customer', p => { p.invoice.charge.customer = 'cus_other'; }],
  ['foreign subscription', p => { p.subscription.metadata.delivery_terms_hash = 'wrong'; }],
  ['copied new charge', p => { p.invoice.charge.id = 'ch_other'; p.invoice.payment_intent.latest_charge = 'ch_other'; }],
]) test(`adverse paid replay cannot fence unverified stable binding: ${name}`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  await f.api.processStripeEvent(p.event);
  p.invoice.charge.disputed = true; mutate(p);
  const before = structuredClone(f.db.docs);
  await assert.rejects(f.api.processStripeEvent(p.event), { code: 'failed-precondition' });
  assert.deepEqual(f.db.docs,before);
});

test('adverse paid hold and scheduled reconciliation commit atomically and retry without rescheduling', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  await f.api.processStripeEvent(p.event);
  p.invoice.charge.disputed = true;
  const before = structuredClone(f.db.docs); f.db.failHoldCommit = true;
  await assert.rejects(f.api.processStripeEvent(p.event), /injected hold commit failure/);
  assert.deepEqual(f.db.docs,before);
  await assert.rejects(f.api.processStripeEvent(p.event), { code: 'failed-precondition' });
  assert.ok(f.db.docs.get('subscriptionPaymentHolds/in_first').held);
  assert.equal(f.db.docs.get('subscriptionShipments/in_first').fulfillmentStatus,'needs_reconciliation');
});

for (const state of ['absent','fulfilled']) test(`adverse paid invoice preserves ${state} shipment history and never grants dispatch`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  if (state === 'fulfilled') {
    await f.api.processStripeEvent(p.event);
    f.db.docs.get('subscriptionShipments/in_first').fulfillmentStatus = 'fulfilled';
  }
  const before = structuredClone(f.db.docs.get('subscriptionShipments/in_first'));
  p.invoice.charge.amount_refunded = 1;
  await assert.rejects(f.api.processStripeEvent(p.event), { code: 'failed-precondition' });
  assert.deepEqual(f.db.docs.get('subscriptionShipments/in_first'),before);
  assert.ok(f.db.docs.get('subscriptionPaymentHolds/in_first').held);
  // A stale clean provider snapshot must not release the fence or rewrite fulfillment.
  p.invoice.charge.amount_refunded = 0;
  await f.api.processStripeEvent(p.event);
  const after = f.db.docs.get('subscriptionShipments/in_first');
  if (before) assert.deepEqual(after,before);
  else assert.equal(after.fulfillmentStatus,'needs_reconciliation');
  assert.ok(f.db.docs.get('subscriptionPaymentHolds/in_first').held);
});

for (const type of ['charge.refunded','charge.dispute.created']) test(`verified ${type} durably holds exact invoice and duplicate paid replay cannot release it`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  await f.api.processStripeEvent(p.event);
  const a = adverseProvider(f,p,type);
  await f.api.processStripeEvent(a.event);
  const shipment = f.db.docs.get('subscriptionShipments/in_first');
  assert.equal(shipment.fulfillmentStatus,'needs_reconciliation');
  assert.equal(shipment.paymentStatus,'paid');
  assert.equal(f.db.docs.get('subscriptionPaymentHolds/in_first').chargeId,p.invoice.charge.id);
  const snapshot = structuredClone(f.db.docs);
  await f.api.processStripeEvent(a.event); await f.api.processStripeEvent(p.event);
  assert.deepEqual(f.db.docs,snapshot);
});

for (const fulfilled of [false,true]) test(`adverse event before paid or after fulfilled never invents dispatch (fulfilled=${fulfilled})`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  if (fulfilled) {
    await f.api.processStripeEvent(p.event);
    f.db.docs.get('subscriptionShipments/in_first').fulfillmentStatus = 'fulfilled';
  }
  const before = structuredClone(f.db.docs.get('subscriptionShipments/in_first'));
  await f.api.processStripeEvent(adverseProvider(f,p).event);
  await f.api.processStripeEvent(p.event);
  const shipment = f.db.docs.get('subscriptionShipments/in_first');
  if (fulfilled) assert.deepEqual(shipment,before);
  else assert.equal(shipment.fulfillmentStatus,'needs_reconciliation');
  assert.ok(f.db.docs.has('subscriptionPaymentHolds/in_first'));
});

test('adverse events reject spoofed charge bindings and retry unresolved provider reads', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  await f.api.processStripeEvent(p.event);
  const a = adverseProvider(f,p); a.charge.customer = 'cus_foreign';
  const before = structuredClone(f.db.docs);
  await assert.rejects(f.api.processStripeEvent(a.event),{ code: 'failed-precondition' });
  assert.deepEqual(f.db.docs,before);
  f.stripe.charges.retrieve = async () => { throw Error('offline'); };
  await assert.rejects(f.api.processStripeEvent(a.event),{ code: 'unavailable' });
  assert.deepEqual(f.db.docs,before);
});

for (const duration of [1,604800,1209601+3600,2678400]) test(`biweekly implausible period ${duration} preserves paid reconciliation`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  for (const l of p.lines.data) l.period.end = l.period.start+duration;
  assert.equal((await f.api.processStripeEvent(p.event)).fulfillmentStatus,'needs_reconciliation');
  assert.equal(f.db.docs.get('subscriptionShipments/in_first').paymentStatus,'paid');
});

for (const offset of [0,1,604800,-604800]) test(`different invoice overlapping period offset ${offset} cannot schedule twice`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context);
  const p = paidProvider(f,result); await f.api.processStripeEvent(p.event);
  const second = paidProvider(f,result,'in_overlap');
  for (const l of second.lines.data) { l.period.start += offset; l.period.end += offset; }
  const reply = await f.api.processStripeEvent(second.event);
  assert.equal(reply.fulfillmentStatus,'needs_reconciliation');
  assert.equal(f.db.docs.get('subscriptionShipments/in_overlap').paymentStatus,'paid');
});

test('concurrent identical periods atomically schedule only one invoice', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context);
  const a = paidProvider(f,result), b = paidProvider(f,result,'in_parallel');
  const invoices = new Map([a,b].map(p => [p.invoice.id,p]));
  f.stripe.invoices.retrieve = async id => structuredClone(invoices.get(id).invoice);
  f.stripe.invoices.listLineItems = async id => structuredClone(invoices.get(id).lines);
  await Promise.all([a,b].map(p => f.api.processStripeEvent(p.event)));
  const shipments = [...f.db.docs.entries()].filter(([key]) => key.startsWith('subscriptionShipments/')).map(([,v]) => v);
  assert.equal(shipments.length,2);
  assert.equal(shipments.filter(s => s.fulfillmentStatus === 'scheduled').length,1);
  assert.ok(shipments.every(s => s.paymentStatus === 'paid'));
});

test('monthly Stripe periods retain exact varying month and DST boundaries', async () => {
  for (const [start,end] of [['2027-01-31T05:00:00Z','2027-02-28T05:00:00Z'],['2027-02-28T05:00:00Z','2027-03-31T04:00:00Z'],['2028-02-01T05:00:00Z','2028-03-01T05:00:00Z']]) {
    const f = fixture(); const result = await f.api.createCheckout({ ...request(), cadence: 'monthly' },f.context); const p = paidProvider(f,result);
    const s = Date.parse(start)/1000, e = Date.parse(end)/1000;
    p.invoice.status_transitions.paid_at = s; f.setClock(s*1000);
    for (const l of p.lines.data) l.period = { start: s, end: e };
    assert.equal((await f.api.processStripeEvent(p.event)).fulfillmentStatus,'scheduled');
    const shipment = f.db.docs.get('subscriptionShipments/in_first');
    assert.equal(shipment.periodStart,s*1000); assert.equal(shipment.periodEnd,e*1000);
  }
});

test('paid invalid cadence records reconciliation even when scheduler is unavailable', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  for (const l of p.lines.data) l.period.end = l.period.start+1;
  const api = createSubscriptions({ ...f.options, scheduleShipment: async () => { throw Error('must not schedule invalid period'); } });
  assert.equal((await api.processStripeEvent(p.event)).fulfillmentStatus,'needs_reconciliation');
});

test('cutoff is rechecked at the atomic shipment commit boundary', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  const run = f.db.runTransaction; let scheduled = false;
  f.db.runTransaction = fn => { if (scheduled) f.setClock(1800003600001); return run(fn); };
  const api = createSubscriptions({ ...f.options, scheduleShipment: async () => { scheduled = true; return { cutoffAt: 1800003600000, deliveryAt: 1800086400000 }; } });
  assert.equal((await api.processStripeEvent(p.event)).fulfillmentStatus,'needs_reconciliation');
});

test('paid events remain processable while current checkout authorization is disabled', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  const policy = f.db.docs.get('settings/subscriptionDelivery'); policy.enabled = false; policy.tax.ready = false;
  assert.equal((await f.api.processStripeEvent(p.event)).fulfillmentStatus,'scheduled');
});

test('policy revoked during provider creation cannot expose returned URL', async () => {
  const f = fixture(); const create = f.stripe.checkout.sessions.create;
  f.stripe.checkout.sessions.create = async (p,o) => { const session = await create(p,o); f.db.docs.get('settings/subscriptionDelivery').enabled = false; return session; };
  await assert.rejects(f.api.createCheckout(request(),f.context),{ code: 'failed-precondition' });
  assert.equal([...f.db.docs.values()].filter(x => x.session).length,0);
});

for (const type of ['refund.created','refund.updated','charge.refund.updated','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated']) test(`${type} never releases a reconciliation hold`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  const a = adverseProvider(f,p,type);
  await Promise.all([f.api.processStripeEvent(p.event),f.api.processStripeEvent(a.event)]);
  assert.equal(f.db.docs.get('subscriptionShipments/in_first').fulfillmentStatus,'needs_reconciliation');
  assert.ok(f.db.docs.get('subscriptionPaymentHolds/in_first').held);
});

for (const mutate of [a => { a.event.livemode = true; },a => { a.event.account = 'acct_other'; },a => { a.event.api_version = 'wrong'; },a => { a.dispute.charge = 'ch_other'; },a => { a.charge.invoice = 'in_other'; },a => { a.charge.payment_intent = 'pi_other'; }]) test(`adverse binding boundary: ${mutate}`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  await f.api.processStripeEvent(p.event);
  const a = adverseProvider(f,p,'charge.dispute.created'); mutate(a);
  await assert.rejects(f.api.processStripeEvent(a.event));
  assert.equal(f.db.docs.get('subscriptionShipments/in_first').fulfillmentStatus,'scheduled');
  assert.ok(!f.db.docs.has('subscriptionPaymentHolds/in_first'));
});

test('adjacent periods in reverse event order do not overlap', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context);
  const later = paidProvider(f,result,'in_later');
  for (const l of later.lines.data) { l.period.start += 1209600; l.period.end += 1209600; }
  assert.equal((await f.api.processStripeEvent(later.event)).fulfillmentStatus,'scheduled');
  const earlier = paidProvider(f,result);
  assert.equal((await f.api.processStripeEvent(earlier.event)).fulfillmentStatus,'scheduled');
  assert.equal(f.db.docs.get('subscriptionPeriods/sub_test_1').periods.length,2);
});

for (const state of ['missing','capacity','malformed']) test(`period ledger ${state} preserves paid reconciliation`, async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context);
  const p = paidProvider(f,result); await f.api.processStripeEvent(p.event);
  const key = 'subscriptionPeriods/sub_test_1';
  if (state === 'missing') f.db.docs.delete(key);
  else if (state === 'capacity') f.db.docs.get(key).periods = Array.from({ length: 512 },(_,i) => ({ invoiceId: `in_old_${i}`, start: 1000000+i*1209600, end: 1000000+(i+1)*1209600 }));
  else f.db.docs.get(key).periods = [null];
  const next = paidProvider(f,result,'in_later');
  for (const l of next.lines.data) { l.period.start += 1209600; l.period.end += 1209600; }
  assert.equal((await f.api.processStripeEvent(next.event)).fulfillmentStatus,'needs_reconciliation');
  assert.equal(f.db.docs.get('subscriptionShipments/in_later').paymentStatus,'paid');
});

test('known overlapping paid invoice reconciles without depending on the scheduler', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context); const p = paidProvider(f,result);
  await f.api.processStripeEvent(p.event);
  const next = paidProvider(f,result,'in_overlap');
  const api = createSubscriptions({ ...f.options, scheduleShipment: async () => { throw Error('do not reschedule duplicate period'); } });
  assert.equal((await api.processStripeEvent(next.event)).fulfillmentStatus,'needs_reconciliation');
});

test('non-payment events and unrelated invoices never create fulfillment', async () => {
  const f = fixture();
  for (const type of ['checkout.session.completed','customer.subscription.deleted','invoice.payment_failed','invoice.created']) assert.deepEqual(await f.api.processStripeEvent({ type }),{ ignored: true });
  f.stripe.invoices = { retrieve: async () => ({ id: 'in_unrelated', object: 'invoice', subscription_details: null }) };
  assert.deepEqual(await f.api.processStripeEvent({ type: 'invoice.paid', id: 'evt_other', api_version: '2024-06-20', livemode: false, data: { object: { id: 'in_unrelated', object: 'invoice' } } }),{ ignored: true });
  assert.equal(f.db.docs.size,1);
});

test('installed Stripe SDK serializes real subscription endpoints and version headers against offline fixtures', async () => {
  const Stripe = require('../firebase/functions/node_modules/stripe');
  const f = fixture(); const wire = []; let provider;
  const client = new Stripe('fixture_not_a_credential', {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url,init) => {
      const u = new URL(url); const body = new URLSearchParams(init.body || ''); wire.push({ method: init.method, path: u.pathname, query: u.searchParams, body, headers: init.headers });
      let response;
      if (init.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
        const saved = [...f.db.docs.values()].find(x => x.id);
        response = { id: 'cs_sdk_1', object: 'checkout.session', livemode: false, mode: 'subscription', status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_sdk_1', client_reference_id: saved.id, metadata: saved.createParams.metadata, expires_at: saved.createParams.expires_at };
      } else if (u.pathname === '/v1/invoices/in_first') response = provider.invoice;
      else if (u.pathname === '/v1/invoices/in_first/lines') response = provider.lines;
      else if (u.pathname === '/v1/subscriptions/sub_test_1') response = provider.subscription;
      else if (u.pathname === '/v1/charges/ch_in_first') response = { ...provider.invoice.charge, amount_refunded: 1 };
      else if (u.pathname === '/v1/refunds/re_test') response = { id: 're_test', object: 'refund', amount: 1, currency: 'usd', charge: provider.invoice.charge.id, payment_intent: provider.invoice.payment_intent.id, status: 'succeeded' };
      else if (u.pathname === '/v1/checkout/sessions') response = { object: 'list', has_more: false, data: [provider.session] };
      else throw Error(`Unexpected offline request: ${init.method} ${u.pathname}`);
      return new Response(JSON.stringify(response),{ status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_offline_fixture' } });
    }),
  });
  const api = createSubscriptions({ ...f.options, stripe: client });
  const result = await api.createCheckout(request(),f.context); provider = paidProvider(f,result);
  assert.equal((await api.processStripeEvent(provider.event)).created,true);
  assert.equal(wire.length,5);
  for (const w of wire) assert.equal(w.headers['Stripe-Version'],'2024-06-20');
  assert.equal(wire[0].headers['Idempotency-Key'],`delivery:${result.subscriptionOrderId}`);
  assert.equal(wire[0].body.get('line_items[0][price_data][recurring][interval_count]'),'2');
  assert.equal(wire[0].body.get('line_items[3][price_data][unit_amount]'),'1000');
  assert.equal(wire[1].query.get('expand[0]'),'payment_intent');
  assert.equal(wire[3].query.get('subscription'),'sub_test_1');
  assert.equal(wire[4].query.get('expand[0]'),'data.price.product');
  const refundEvent = adverseProvider(f,provider,'refund.updated').event;
  assert.equal(Object.hasOwn(refundEvent.data.object,'livemode'),false);
  await api.processStripeEvent(refundEvent);
  assert.equal(wire.length,10);
  assert.equal(wire[5].path,'/v1/refunds/re_test');
  assert.equal(wire[6].path,'/v1/charges/ch_in_first');
  for (const w of wire.slice(5)) assert.equal(w.headers['Stripe-Version'],'2024-06-20');
  assert.equal(f.db.docs.get('subscriptionShipments/in_first').fulfillmentStatus,'needs_reconciliation');
});

test('a paid bound subscription cannot expose a stale open checkout URL', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context);
  const p = paidProvider(f,result); await f.api.processStripeEvent(p.event);
  await assert.rejects(f.api.createCheckout(request(),f.context),{ code: 'failed-precondition' });
});

test('provider session response must bind frozen terms and allow time for Stripe minimum expiry', async () => {
  const f = fixture();
  const create = f.stripe.checkout.sessions.create;
  f.stripe.checkout.sessions.create = async (p,o) => {
    assert.ok(p.expires_at >= 1800003600, 'minimum 30m needs setup/retry headroom');
    return { ...await create(p,o), client_reference_id: 'other_order' };
  };
  await assert.rejects(f.api.createCheckout(request(),f.context), { code: 'failed-precondition' });
  assert.equal([...f.db.docs.values()].filter(x => x.session).length,0);
});

for (const pending of [false,true]) for (const revoke of [p => { p.enabled = false; }, p => { p.tax.ready = false; }]) test(`retry rechecks current authorization (pending=${pending}, ${revoke})`, async () => {
  const f = fixture();
  if (pending) {
    f.stripe.checkout.sessions.create = async () => { f.calls.push({ attempted: true }); throw Error('lost response'); };
    await assert.rejects(f.api.createCheckout(request(),f.context));
  } else await f.api.createCheckout(request(),f.context);
  const count = f.calls.length; revoke(f.db.docs.get('settings/subscriptionDelivery'));
  await assert.rejects(f.api.createCheckout(request(),f.context),{ code: 'failed-precondition' });
  assert.equal(f.calls.length,count);
});

test('catalog uses the existing mushroom identifier, not a newly invented product ID', async () => {
  const f = fixture();
  const result = await f.api.createCheckout({ ...request(), cart: { mushroom: 6 } }, f.context);
  assert.equal(result.amountPerDelivery,25000);
});

test('paid invoice, even before checkout event, atomically creates one immutable shipment and binds customer/subscription', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(),f.context);
  const p = paidProvider(f,result);
  const one = await f.api.processStripeEvent(p.event);
  assert.equal(one.created,true);
  const shipment = f.db.docs.get(`subscriptionShipments/${p.invoice.id}`);
  assert.equal(shipment.paymentStatus,'paid');
  assert.equal(shipment.fulfillmentStatus,'scheduled');
  assert.equal(shipment.amountPaid,15000);
  assert.equal(shipment.deliveryAddress.zip,'32204');
  assert.deepEqual(shipment.cart,request().cart);
  const snapshots = structuredClone(f.db.docs);
  const duplicates = await Promise.all(Array.from({ length: 8 }, (_,i) => f.api.processStripeEvent({ ...p.event, id: `evt_retry_${i}`, type: i%2 ? 'invoice.payment_succeeded' : 'invoice.paid' })));
  assert.ok(duplicates.every(r => !r.created));
  assert.deepEqual(f.db.docs,snapshots);
  const saved = f.db.docs.get(`deliverySubscriptions/${result.subscriptionOrderId}`);
  assert.equal(saved.subscriptionId,'sub_test_1'); assert.equal(saved.customerId,'cus_test_1');
});

test('checkout rejects client pricing fields and never returns an expired hosted session', async () => {
  const f = fixture();
  await assert.rejects(f.api.createCheckout({ ...request(), amount: 1 }, f.context), { code: 'invalid-argument' });
  const result = await f.api.createCheckout(request(), f.context);
  f.setClock(result.expiresAt + 1);
  await assert.rejects(f.api.createCheckout(request(), f.context), { code: 'failed-precondition' });
});

test('checkout freezes authoritative mixed-jar recurring prices and shipping before provider work', async () => {
  const f = fixture(); const result = await f.api.createCheckout(request(), f.context);
  assert.equal(result.amountPerDelivery, 15000);
  assert.equal(result.currency, 'usd');
  const { params, opts } = f.calls[0];
  assert.equal(params.mode, 'subscription');
  assert.equal(params.allow_promotion_codes, false);
  assert.equal(params.automatic_tax.enabled, false);
  assert.equal(opts.apiVersion, '2024-06-20');
  assert.equal(params.line_items.length, 4);
  assert.deepEqual(params.line_items.map(x => [x.price_data.unit_amount, x.quantity]), [[4000,1],[2000,2],[2000,3],[1000,1]]);
  for (const item of params.line_items) assert.deepEqual(item.price_data.recurring, { interval: 'week', interval_count: 2 });
  assert.equal(params.subscription_data.metadata.delivery_order_id, result.subscriptionOrderId);
  const saved = f.db.docs.get(`deliverySubscriptions/${result.subscriptionOrderId}`);
  assert.equal(saved.capabilityHash.length, 64);
  assert.ok(!JSON.stringify(saved).includes(request().capability));
  assert.equal(saved.terms.zoneId, 'test-zone');
});
