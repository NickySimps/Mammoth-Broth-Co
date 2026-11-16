const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, base } = require('./commerce-fixture.cjs');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function setup() {
  const f = fixture();
  f.records.set('products/prod_beef', { name: 'Beef', priceCents: 2500, active: true });
  f.records.set('products/prod_chicken', { name: 'Chicken', priceCents: 2500, active: true });
  f.records.set('products/mushroom', { name: 'Mushroom', priceCents: 4000, active: true });
  f.records.set('markets/alternate', { name: 'Friday Market', active: true, weekday: 5, timezone: 'America/New_York' });
  return f;
}

async function createMonthly(f, extra = {}) {
  return f.api.createPreorder({ ...base, pickupType: 'monthly', paymentMethod: 'pickup', ...extra });
}

test('monthly pickup stores and returns a server-generated 30-minute local window', async () => {
  const f = setup();
  const result = await createMonthly(f);
  assert.equal(result.pickupType, 'monthly');
  assert.equal(result.marketName, 'Atlantic');
  assert.equal(result.pickupDate, base.pickupDate);
  assert.equal(result.marketTimezone, 'America/New_York');
  assert.equal(result.pickupWindowStartAt, '2026-10-25T15:00:00.000Z');
  assert.equal(result.pickupWindowEndAt, '2026-10-25T15:30:00.000Z');
  const order = f.records.get(`orders/${result.orderId}`);
  assert.equal(order.pickupRevision, 0);
  assert.equal(order.pickupType, 'monthly');
  assert.equal(order.pickupWindowEndAt - order.pickupWindowStartAt, 30 * 60 * 1000);
  const receipt = await f.api.getGuestReceipt({ orderId: result.orderId, token: base.receiptToken });
  assert.equal(receipt.pickupWindowStartAt, result.pickupWindowStartAt);
  assert.equal(receipt.marketChangeEligible, true);
  assert.deepEqual(receipt.marketChangeOptions, [{ marketId: 'alternate', marketName: 'Friday Market' }]);
  await f.api.deliverOrderEmail({ orderId: result.orderId });
  assert.equal(f.mails.length, 2);
  assert.match(f.mails[0].text, /Pickup window: October 25, 2026 at 11:00 AM EDT to October 25, 2026 at 11:30 AM EDT/);
});

test('legacy market orders retain their historical fingerprint and cannot be rescheduled', async () => {
  const f = setup();
  const legacy = await f.api.createPreorder({ ...base, paymentMethod: 'pickup' });
  assert.equal(legacy.pickupType, undefined);
  assert.equal(f.records.get(`orders/${legacy.orderId}`).pickupType, undefined);
  await assert.rejects(f.api.reschedulePickup({ orderId: legacy.orderId, receiptToken: base.receiptToken, marketId: 'alternate', expectedPickupRevision: 0 }), /monthly|one-time/i);
  const normalized = { requestId: base.requestId, cart: base.cart, customerName: base.customerName, customerEmail: base.customerEmail.toLowerCase(), customerUid: null, fulfillmentMethod: 'market_pickup', marketId: base.marketId, pickupDate: base.pickupDate, specialNotes: '', deliveryAddress: null, paymentMethod: 'pickup' };
  assert.equal(f.records.get(`orders/${legacy.orderId}`).fingerprint, digest(stable(normalized)));
});

test('receipt capability can move one monthly order to a scheduled alternative once, idempotently', async () => {
  const f = setup();
  const created = await createMonthly(f);
  const payload = { orderId: created.orderId, receiptToken: base.receiptToken, marketId: 'alternate', expectedPickupRevision: 0 };
  const result = await f.api.reschedulePickup(payload);
  assert.equal(result.marketId, 'alternate');
  assert.equal(result.marketName, 'Friday Market');
  assert.equal(result.pickupDate, '2026-10-30');
  assert.equal(result.pickupWindowStartAt, '2026-10-30T15:00:00.000Z');
  assert.equal(result.pickupWindowEndAt, '2026-10-30T15:30:00.000Z');
  assert.equal(result.pickupRevision, 1);
  assert.deepEqual(await f.api.reschedulePickup(payload), result, 'same retry returns the already committed result');
  await assert.rejects(f.api.reschedulePickup({ ...payload, marketId: 'atlantic' }), /already|change/i);
  const order = f.records.get(`orders/${created.orderId}`);
  assert.equal(order.marketId, 'alternate');
  assert.equal(order.pickupDate, '2026-10-30');
  assert.equal(order.marketChangeUsed, true);
  assert.equal(order.emailVersion, 2, 'reschedule schedules updated customer and operations email');
  const receipt = await f.api.getGuestReceipt({ orderId: created.orderId, token: base.receiptToken });
  assert.equal(receipt.marketName, 'Friday Market');
  assert.equal(receipt.marketChangeEligible, false);
  await f.api.deliverOrderEmail({ orderId: created.orderId });
  assert.equal(f.mails.length, 2);
  assert.match(f.mails[0].text, /Market: Friday Market/);
  assert.match(f.mails[0].text, /Pickup window: October 30, 2026 at 11:00 AM EDT to October 30, 2026 at 11:30 AM EDT/);
  assert.match(f.mails[0].text, /market change has been used/);
});

test('reschedule rejects forged capabilities, stale revisions, invalid markets and a closed original window', async () => {
  const f = setup();
  const created = await createMonthly(f);
  const baseRequest = { orderId: created.orderId, receiptToken: base.receiptToken, marketId: 'alternate', expectedPickupRevision: 0 };
  for (const bad of [
    { ...baseRequest, receiptToken: 'b'.repeat(64) },
    { ...baseRequest, expectedPickupRevision: 1 },
    { ...baseRequest, marketId: 'missing' },
    { ...baseRequest, unexpected: true },
  ]) await assert.rejects(f.api.reschedulePickup(bad));
  f.setNow('2026-10-25T15:31:00Z');
  await assert.rejects(f.api.reschedulePickup(baseRequest), /window|eligible|expired/i);
  const order = f.records.get(`orders/${created.orderId}`);
  assert.equal(order.marketId, base.marketId);
  assert.equal(order.pickupRevision, 0);
  assert.equal(order.marketChangeUsed, undefined);
});

test('collected, disputed or reconciliation orders never expose a customer market-change control', async () => {
  for (const extra of [{ fulfillmentStatus: 'collected' }, { collectedAt: 0 }, { disputeStatus: 'open' }, { reconciliationRequired: true }]) {
    const f = setup();
    const created = await createMonthly(f);
    Object.assign(f.records.get(`orders/${created.orderId}`), extra);
    const receipt = await f.api.getGuestReceipt({ orderId: created.orderId, token: base.receiptToken });
    assert.equal(receipt.marketChangeEligible, false, JSON.stringify(extra));
    assert.deepEqual(receipt.marketChangeOptions, []);
    await assert.rejects(f.api.reschedulePickup({ orderId: created.orderId, receiptToken: base.receiptToken, marketId: 'alternate', expectedPickupRevision: 0 }));
  }
});

test('server defaults timezone and start time, but honors configured market-local pickup start', async () => {
  const f = setup();
  Object.assign(f.records.get('markets/atlantic'), { timezone: undefined, pickupWindowStartTime: '12:15' });
  const result = await createMonthly(f, { requestId: 'request-2345678901' });
  assert.equal(result.marketTimezone, 'America/New_York');
  assert.equal(result.pickupWindowStartAt, '2026-10-25T16:15:00.000Z');
  assert.equal(result.pickupWindowEndAt, '2026-10-25T16:45:00.000Z');
});
