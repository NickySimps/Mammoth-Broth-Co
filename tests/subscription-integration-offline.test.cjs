'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, policy, selection, ms } = require('./fixtures/subscription-integration-offline.cjs');
const START = ms('2026-11-09T05:00:00Z');
const END = ms('2026-11-16T05:00:00Z');
const paid = (f, invoice, suffix = 'paid') => f.event('invoice.paid', { object: 'invoice', id: invoice.id }, suffix);
const shipment = (f, id) => f.read(`subscriptionShipments/${id}`);

// Other scenarios use a test-only clock bridge; the final regression proves
// direct composition supplies its own trusted server evaluation clock.
// Provider is real SDK serialization/signature verification, entirely synthetic
// HTTP responses. Persistence is a restartable local transaction fixture only.
for (const cadence of ['weekly', 'every_two_weeks', 'monthly']) {
  for (const zip of ['32204', '32205', '32233', '32082']) {
    for (const count of [6, 12]) test(`offline checkout -> signed paid invoice -> persisted schedule: ${cadence}, ${zip}, ${count} mixed jars`, async t => {
      const f = await fixture(t);
      const input = selection({ cadence, zip, count });
      const result = await f.checkout(input);
      const fee = ['32204', '32205'].includes(zip) ? 1000 : 1500;
      const amount = (count - 2) * 2000 + 2 * 4000 + fee;
      assert.equal(result.amountPerDelivery, amount);
      assert.equal(result.currency, 'usd');
      const call = f.calls[0];
      assert.equal(call.method, 'POST');
      assert.equal(call.endpoint, '/v1/checkout/sessions');
      assert.equal(call.idempotencyKey, `delivery:${result.subscriptionOrderId}`);
      assert.equal(call.params.get('mode'), 'subscription');
      const interval = cadence === 'monthly' ? 'month' : 'week';
      const intervalCount = cadence === 'every_two_weeks' ? '2' : '1';
      for (let i = 0; i < 4; i++) {
        assert.equal(call.params.get(`line_items[${i}][price_data][recurring][interval]`), interval);
        assert.equal(call.params.get(`line_items[${i}][price_data][recurring][interval_count]`), intervalCount);
      }
      assert.equal(call.params.get('line_items[3][price_data][unit_amount]'), String(fee));
      assert.equal(call.params.get('line_items[3][quantity]'), '1');
      assert.equal(shipment(f, 'in_first'), undefined, 'checkout is NOT payment or shipment evidence');
      const end = cadence === 'monthly' ? ms('2026-12-09T05:00:00Z') : cadence === 'weekly' ? END : ms('2026-11-23T05:00:00Z');
      const invoice = f.invoice('in_first', START, end);
      const req = f.signed(paid(f, invoice));
      req.body = { livemode: true, data: { object: { amount_paid: 1 } } }; // raw bytes own authority
      assert.equal((await f.request(req)).statusCode, 200);
      const record = shipment(f, invoice.id);
      assert.equal(record.paymentStatus, 'paid');
      assert.equal(record.fulfillmentStatus, 'scheduled');
      assert.equal(record.amountPaid, amount);
      assert.equal(record.feeCents, fee);
      assert.deepEqual(record.cart, input.cart);
      assert.equal(record.periodStart, START);
      assert.equal(record.periodEnd, end);
      assert.equal(record.deliveryAt, ms(zip === '32082' ? '2026-11-10T15:00:00Z' : '2026-11-13T15:00:00Z'));
      assert.equal(record.deliveryAt - record.cutoffAt, 24 * 3600000, 'synthetic exact 24h deadline, not a real delivery-time promise');
      assert.equal(f.scheduled.length, 1);
      f.restart();
      assert.deepEqual(shipment(f, invoice.id), record, 'read back durable fixture state after adapter/DB recreation');
      assert.deepEqual(f.read('subscriptionPeriods/sub_offline').periods, [{ invoiceId: invoice.id, start: START / 1000, end: end / 1000 }]);
      assert.equal(f.entries().some(([key]) => key.startsWith('orders/')), false);
    });
  }
}

for (const cadence of ['weekly', 'every_two_weeks', 'monthly']) test(`per-invoice renewal, concurrent duplicate webhooks and restart replay: ${cadence}`, async t => {
  const f = await fixture(t);
  const data = selection({ cadence, zip: '32082' });
  const checkout = await f.checkout(data);
  assert.deepEqual(await f.checkout(data), checkout);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1, 'same attempt never starts another subscription');
  const end = cadence === 'monthly' ? ms('2026-12-09T05:00:00Z') : cadence === 'weekly' ? END : ms('2026-11-23T05:00:00Z');
  const nextEnd = cadence === 'monthly' ? ms('2027-01-09T05:00:00Z') : end + (end - START);
  const first = f.invoice('in_initial', START, end);
  assert.equal((await f.post(paid(f, first))).statusCode, 200);
  const original = shipment(f, first.id);
  f.setClock(end);
  const renewal = f.invoice('in_renewal', end, nextEnd, { reason: 'subscription_cycle' });
  const events = [paid(f, renewal, 'renewalA'), f.event('invoice.payment_succeeded', { object: 'invoice', id: renewal.id }, 'renewalB'), paid(f, renewal, 'renewalC')];
  const results = await Promise.all(events.map(event => f.post(event)));
  assert.deepEqual(results.map(r => r.statusCode), [200, 200, 200]);
  assert.equal(shipment(f, renewal.id).fulfillmentStatus, 'scheduled');
  assert.equal(shipment(f, renewal.id).amountPaid, original.amountPaid, 'fee and jars charged on EACH invoice');
  assert.equal(shipment(f, renewal.id).periodStart, end);
  assert.equal(shipment(f, renewal.id).periodEnd, nextEnd);
  assert.equal(new Date(shipment(f, renewal.id).deliveryAt).getUTCDay(), 2, 'same shared Tuesday 32082 route');
  assert.equal(shipment(f, renewal.id).deliveryAt - shipment(f, renewal.id).cutoffAt, 86400000);
  assert.deepEqual(shipment(f, first.id), original, 'renewal never overwrites first invoice');
  assert.equal(f.entries().filter(([key]) => key.startsWith('subscriptionShipments/')).length, 2);
  assert.equal(f.read('subscriptionPeriods/sub_offline').periods.length, 2);
  f.restart();
  const persisted = f.entries();
  assert.equal((await f.post(paid(f, renewal, 'restartReplay'))).statusCode, 200);
  assert.deepEqual(f.entries(), persisted);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

for (const beforePaid of [false, true]) test(`signed refund ${beforePaid ? 'before' : 'after'} paid event establishes durable hold that clean paid replays cannot release`, async t => {
  const f = await fixture(t);
  await f.checkout();
  const invoice = f.invoice('in_refundable', START, END);
  if (!beforePaid) assert.equal((await f.post(paid(f, invoice))).statusCode, 200);
  const refund = { object: 'refund', id: 're_offline', charge: invoice.charge.id, payment_intent: invoice.payment_intent.id, amount: 1000, currency: 'usd', status: 'succeeded' };
  assert.equal(Object.hasOwn(refund, 'livemode'), false, 'real Refund schema does not have livemode');
  f.objects.set('/v1/refunds/re_offline', refund);
  const refunded = f.event('refund.created', refund, 'refund');
  assert.equal((await f.post(refunded)).statusCode, 200);
  assert.equal(f.read(`subscriptionPaymentHolds/${invoice.id}`).held, true);
  if (beforePaid) assert.equal(shipment(f, invoice.id), undefined);
  assert.equal((await f.post(paid(f, invoice, 'cleanReplay'))).statusCode, 200);
  const held = shipment(f, invoice.id);
  assert.equal(held.fulfillmentStatus, 'needs_reconciliation');
  assert.equal(held.reconciliationReason, 'refund_or_dispute');
  assert.equal(held.deliveryAt, null);
  assert.equal(held.cutoffAt, null);
  assert.equal(held.amountPaid, invoice.amount_paid);
  f.restart();
  assert.equal((await f.post(refunded)).statusCode, 200);
  assert.equal((await f.post(paid(f, invoice, 'anotherCleanReplay'))).statusCode, 200);
  assert.deepEqual(shipment(f, invoice.id), held);
  assert.equal(f.entries().filter(([key]) => key.startsWith('subscriptionShipments/')).length, 1);
  assert.equal(f.read(`subscriptionPaymentHolds/${invoice.id}`).held, true);
});

test('commit failure returns retryable HTTP 500; retry creates exactly one persistent paid shipment', async t => {
  const f = await fixture(t);
  await f.checkout();
  const invoice = f.invoice('in_commit', START, END);
  f.beforeCommit(draft => { if (draft.has('subscriptionShipments/in_commit')) throw Error('synthetic disk failure'); });
  assert.equal((await f.post(paid(f, invoice))).statusCode, 500);
  assert.equal(shipment(f, invoice.id), undefined);
  assert.equal(f.read('subscriptionPeriods/sub_offline'), undefined);
  f.beforeCommit(() => {});
  f.restart();
  assert.equal((await f.post(paid(f, invoice))).statusCode, 200);
  assert.equal(shipment(f, invoice.id).fulfillmentStatus, 'scheduled');
  assert.equal(f.read('subscriptionPeriods/sub_offline').periods.length, 1);
});

test('different invoices for an overlapping paid period cannot create a second scheduled renewal', async t => {
  const f = await fixture(t);
  await f.checkout();
  const first = f.invoice('in_original', START, END);
  assert.equal((await f.post(paid(f, first))).statusCode, 200);
  const snapshot = shipment(f, first.id);
  const other = f.invoice('in_overlap', START, END, { reason: 'subscription_cycle' });
  assert.equal((await f.post(paid(f, other))).statusCode, 200);
  assert.equal(shipment(f, other.id).fulfillmentStatus, 'needs_reconciliation');
  assert.equal(shipment(f, other.id).reconciliationReason, 'overlapping_billing_period');
  assert.equal(shipment(f, other.id).deliveryAt, null);
  assert.deepEqual(shipment(f, first.id), snapshot);
  assert.equal(f.read('subscriptionPeriods/sub_offline').periods.length, 1);
});

test('missing monthly mapping retains paid evidence for reconciliation, never invents a 28-day delivery', async t => {
  const p = policy(); delete p.scheduling.monthly;
  const f = await fixture(t, { businessPolicy: p });
  await f.checkout(selection({ cadence: 'monthly' }));
  const invoice = f.invoice('in_unmapped', START, ms('2026-12-09T05:00:00Z'));
  assert.equal((await f.post(paid(f, invoice))).statusCode, 200);
  assert.equal(shipment(f, invoice.id).fulfillmentStatus, 'needs_reconciliation');
  assert.equal(shipment(f, invoice.id).deliveryAt, null);
  assert.equal(shipment(f, invoice.id).amountPaid, 17000);
});

for (const [name, options] of [
  ['transport disabled', { config: { enabled: false } }],
  ['checkout disabled', { config: { checkoutEnabled: false } }],
  ['policy absent', { businessPolicy: null }],
  ['tax unresolved', { businessPolicy: { ...policy(), tax: { ready: false } } }],
]) test(`fail closed before provider checkout: ${name}`, async t => {
  const f = await fixture(t, options);
  const before = f.entries();
  await assert.rejects(f.checkout(), { code: 'failed-precondition' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.entries(), before);
  if (name === 'transport disabled') assert.equal((await f.post(f.event('invoice.paid', { object: 'invoice', id: 'in_disabled' }))).statusCode, 503);
});

test('tampered raw-body signature cannot reach provider reads or persist shipments', async t => {
  const f = await fixture(t); await f.checkout();
  const invoice = f.invoice('in_tampered', START, END);
  const req = f.signed(paid(f, invoice));
  req.rawBody = Buffer.concat([req.rawBody, Buffer.from(' ')]);
  const before = f.calls.length;
  assert.equal((await f.request(req)).statusCode, 400);
  assert.equal(f.calls.length, before);
  assert.equal(shipment(f, invoice.id), undefined);
});

test('provider amount mismatch is not acknowledged and creates neither shipment nor ledger', async t => {
  const f = await fixture(t); await f.checkout();
  const invoice = f.invoice('in_mismatch', START, END);
  invoice.amount_paid -= 1000;
  assert.equal((await f.post(paid(f, invoice))).statusCode, 500);
  assert.equal(shipment(f, invoice.id), undefined);
  assert.equal(f.read('subscriptionPeriods/sub_offline'), undefined);
});

test('frontend delivery selection never calls legacy one-time payment, quote or special-order transports', async () => {
  const { browserHarness } = require('./fixtures/subscription-integration-offline.cjs');
  const h = await browserHarness();
  for (const cadence of ['weekly', 'every_two_weeks', 'monthly']) {
    h.node('subscription-interval').value = cadence;
    assert.equal(h.context.validateOrderDetails().length, 0);
    assert.equal(await h.context.preparePaymentElement(), false);
    await h.context.handleOrderSubmit({ preventDefault() {} });
    await h.context.requestDeliveryQuote();
    await h.context.handleSpecialOrder();
    assert.equal(h.node('checkout-button').disabled, true);
    assert.match(h.node('payment-message').textContent, /subscription checkout unavailable/i);
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.context.window.location.href, '');
  assert.deepEqual(JSON.parse(h.storage.get('mammothCart')), { prod_beef: 2, prod_chicken: 2, mushroom: 2 });
});

test('legacy commerce backend independently rejects a direct one-time delivery fallback with zero effects', async () => {
  const { fixture: commerceFixture, base } = require('./commerce-fixture.cjs');
  const f = commerceFixture();
  const before = structuredClone([...f.records]);
  await assert.rejects(f.api.createPaymentIntent({ ...base, cart: selection().cart, fulfillmentMethod: 'local_delivery', deliveryAddress: selection().deliveryAddress, subscriptionInterval: 'weekly' }), { code: 'failed-precondition' });
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length + f.sessions.length + f.mails.length, 0);
});

for (const atCutoff of [false, true]) test(`24h synthetic order deadline ${atCutoff ? 'at cutoff reconciles' : 'one second before schedules'}`, async t => {
  const f = await fixture(t); await f.checkout();
  const cutoff = ms('2026-11-12T15:00:00Z');
  const paidAt = atCutoff ? cutoff : cutoff - 1000;
  f.setClock(paidAt);
  const invoice = f.invoice('in_deadline', START, END, { paidAt });
  assert.equal((await f.post(paid(f, invoice))).statusCode, 200);
  assert.equal(shipment(f, invoice.id).fulfillmentStatus, atCutoff ? 'needs_reconciliation' : 'scheduled');
  assert.equal(shipment(f, invoice.id).deliveryAt, atCutoff ? null : ms('2026-11-13T15:00:00Z'));
});

test('spring-DST one-calendar-day route must reconcile rather than allow less than 24 elapsed hours', async t => {
  const p = policy();
  // Entirely synthetic Sunday 10:00 route; NOT a proposed business delivery time.
  p.scheduling.routes = [{ id: 'synthetic-dst', weekday: 0, deliveryTime: '10:00', cutoff: { daysBefore: 1, time: '10:00' }, calendar: { from: '2027-03-08', through: '2027-03-15', dates: [{ date: '2027-03-14', open: true }] } }];
  p.scheduling.zones.forEach(zone => { zone.allowedRouteIds = ['synthetic-dst']; });
  delete p.scheduling.monthly;
  const f = await fixture(t, { businessPolicy: p });
  const start = ms('2027-03-08T05:00:00Z'), end = ms('2027-03-15T04:00:00Z');
  f.setClock(start);
  await f.checkout();
  const invoice = f.invoice('in_dst', start, end);
  assert.equal((await f.post(paid(f, invoice))).statusCode, 200);
  const record = shipment(f, invoice.id);
  assert.equal(record.fulfillmentStatus, 'needs_reconciliation', 'March 14 synthetic 10:00 minus March 13 10:00 is only 23 elapsed hours');
  assert.equal(record.deliveryAt, null);
  assert.equal(record.cutoffAt, null);
});

test('direct adapter/domain/scheduler composition schedules with a trusted server evaluation clock', async t => {
  const f = await fixture(t, { bridgeClock: false });
  await f.checkout();
  const invoice = f.invoice('in_direct', START, END);
  assert.equal((await f.post(paid(f, invoice))).statusCode, 200);
  assert.equal(shipment(f, invoice.id).fulfillmentStatus, 'scheduled', 'domain supplies the server evaluation clock required by the scheduler');
});
