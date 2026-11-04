'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createPolicy = require('../firebase/functions/subscription-refund-policy.cjs');
const target = { subscriptionOrderId: `ds_${'a'.repeat(64)}`, invoiceId: 'in_cycle1' };
function evidence() {
  return {
    payment: { ...target, paymentStatus: 'paid', amountPaid: 15400, currency: 'usd', deliveryFeeCents: 1000, deliveryFeeRecurring: true },
    cancellation: { ...target, recordedAt: Date.parse('2026-03-07T20:00:00Z') },
    delivery: { ...target, civilDate: '2026-03-08', timeZone: 'America/New_York' },
  };
}
function needsReview(result) {
  assert.equal(result.feeEligibility, 'needs_review');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.maximumFeeRefundCents, null);
  assert.equal(result.automaticRefundAuthorized, false);
  assert.equal(result.requiresAdminApproval, true);
  assert.equal(result.providerExecuted, false);
}
test('missing trusted verifier and client verified flags cannot establish evidence', () => {
  needsReview(createPolicy()(target));
  needsReview(createPolicy({ verifyServerEvidence: () => ({ verified: true, ...target }) })(target));
  needsReview(createPolicy({ verifyServerEvidence: () => { throw Error('unavailable'); } })(target));
  needsReview(createPolicy({ verifyServerEvidence: async () => evidence() })(target));
});
const unsafeEvidence = [
  r => { delete r.delivery; }, r => { delete r.cancellation; }, r => { delete r.payment; },
  r => { delete r.delivery.timeZone; }, r => { r.delivery.timeZone = ''; },
  r => { r.delivery.timeZone = 'Invalid/Zone'; }, r => { r.delivery.timeZone = '+05:00'; },
  r => { r.delivery.civilDate = '2026-02-30'; }, r => { r.delivery.civilDate = '2025-02-29'; },
  r => { r.delivery.civilDate = '2026-04-31'; }, r => { r.delivery.civilDate = '2026-13-01'; },
  r => { r.delivery.civilDate = '2026-03-00'; }, r => { r.delivery.civilDate = '2026-3-08'; },
  r => { r.delivery.civilDate = '2026-03-08T00:00:00Z'; },
  r => { delete r.cancellation.recordedAt; }, r => { r.cancellation.recordedAt = null; },
  r => { r.cancellation.recordedAt = NaN; }, r => { r.cancellation.recordedAt = Infinity; },
  r => { r.cancellation.recordedAt = Number.MAX_SAFE_INTEGER; },
  r => { r.cancellation.recordedAt = '2026-03-07T00:00:00Z'; },
  r => { r.cancellation.recordedAt = new Date('2026-03-07'); },
  r => { r.cancellation.recordedAt = 1800000000000.5; },
  r => { r.payment.paymentStatus = 'unpaid'; }, r => { r.payment.deliveryFeeRecurring = false; },
  r => { delete r.payment.deliveryFeeCents; }, r => { r.payment.deliveryFeeCents = -1; },
  r => { r.payment.deliveryFeeCents = 1.5; }, r => { r.payment.deliveryFeeCents = '1000'; },
  r => { r.payment.deliveryFeeCents = Number.MAX_SAFE_INTEGER; },
  r => { r.payment.amountPaid = 999; }, r => { r.payment.amountPaid = NaN; },
  r => { r.payment.currency = 'eur'; },
  ...['payment', 'cancellation', 'delivery'].flatMap(k => [
    r => { r[k].invoiceId = 'in_other'; }, r => { r[k].subscriptionOrderId = `ds_${'b'.repeat(64)}`; },
  ]),
];
for (const instant of ['2026-03-07T20:00:00Z', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z']) {
  unsafeEvidence.forEach((mutate, i) => test(`unsafe or unknown server evidence ${i} at ${instant} requires review, not zero refund`, () => {
    const record = evidence(); record.cancellation.recordedAt = Date.parse(instant);
    mutate(record); const before = structuredClone(record);
    needsReview(decide(record)); assert.deepEqual(record, before);
  }));
}
test('client amounts, dates, admin flags and malformed identifiers are rejected before verifier', () => {
  let calls = 0; const policy = createPolicy({ verifyServerEvidence: () => { calls++; return evidence(); } });
  for (const input of [null, [], {}, { ...target, amount: 1 }, { ...target, taxCents: 0 },
    { ...target, recordedAt: 0 }, { ...target, timeZone: 'UTC' }, { ...target, admin: true },
    { ...target, verified: true }, { ...target, invoiceId: '../in_cycle1' },
    { ...target, subscriptionOrderId: target.subscriptionOrderId.toUpperCase() },
    Object.create(target), { ...target, invoiceId: { toString: () => 'in_cycle1' } },
    Object.assign(Object.create({ admin: true }), target),
    Object.defineProperty({ ...target }, 'invoiceId', { get() { throw Error('getter must not execute'); }, enumerable: true }),
  ]) assert.throws(() => policy(input), { code: 'invalid-argument' });
  assert.equal(calls, 0);
});
test('historical frozen cycle fee is preserved without mutation or tax/product inference', () => {
  const record = evidence(); record.payment.deliveryFeeCents = 750;
  const before = structuredClone(record);
  Object.values(record).forEach(Object.freeze); Object.freeze(record);
  const result = decide(record); assert.equal(result.maximumFeeRefundCents, 750);
  assert.deepEqual(record, before); assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { result.maximumFeeRefundCents = 1; }, TypeError);
  assert.equal(decide({ ...record, payment: { ...record.payment, deliveryFeeCents: 0 } }).maximumFeeRefundCents, 0);
});
test('valid leap day and explicit UTC are accepted without host-timezone defaults', () => {
  const record = evidence(); record.delivery.civilDate = '2028-02-29'; record.delivery.timeZone = 'UTC';
  record.cancellation.recordedAt = Date.parse('2028-02-28T23:59:59.999Z');
  assert.equal(decide(record).feeEligibility, 'eligible');
});
test('east-of-UTC local delivery day cannot be treated as the previous UTC day', () => {
  const record = evidence(); record.delivery.timeZone = 'Pacific/Auckland';
  record.cancellation.recordedAt = Date.parse('2026-03-07T12:00:00Z');
  const result = decide(record);
  assert.equal(result.cancellationCivilDate, '2026-03-08');
  assert.equal(result.feeEligibility, 'ineligible');
  assert.equal(result.status, 'not_eligible');
  assert.equal(result.maximumFeeRefundCents, 0);
});
test('untrusted evidence getters are not executed; history target is immutable', () => {
  const record = evidence();
  Object.defineProperty(record.delivery, 'timeZone', { get() { throw Error('getter executed'); }, enumerable: true });
  needsReview(decide(record));
  const input = Object.freeze({ ...target });
  const result = createPolicy({ verifyServerEvidence: ids => {
    assert.deepEqual(ids, input); assert.equal(Object.isFrozen(ids), true); return evidence();
  } })(input);
  assert.equal(result.feeEligibility, 'eligible');
  assert.deepEqual(input, target);
});
function decide(record = evidence(), input = target) {
  return createPolicy({ verifyServerEvidence: () => record })(input);
}
test('strictly pre-delivery-day paid recurring fee is eligible only for prior admin approval', () => {
  const result = decide();
  assert.equal(result.feeEligibility, 'eligible');
  assert.equal(result.status, 'pending_admin_approval');
  assert.equal(result.maximumFeeRefundCents, 1000);
  assert.equal(result.currency, 'usd');
  assert.equal(result.cancellationCivilDate, '2026-03-07');
  assert.equal(result.requiresAdminApproval, true);
  assert.equal(result.automaticRefundAuthorized, false);
  assert.equal(result.providerExecuted, false);
  assert.equal(result.productRefundCents, undefined);
  assert.equal(result.taxRefundCents, undefined);
});

for (const [deliveryDay, instant, day, eligibility] of [
  ['2026-03-08', '2026-03-08T04:59:59.999Z', '2026-03-07', 'eligible'],
  ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-08', 'ineligible'],
  ['2026-03-08', '2026-03-08T06:59:59Z', '2026-03-08', 'ineligible'],
  ['2026-03-08', '2026-03-08T07:00:00Z', '2026-03-08', 'ineligible'],
  ['2026-03-08', '2026-03-09T03:59:59Z', '2026-03-08', 'ineligible'],
  ['2026-03-08', '2026-03-09T03:59:59.999Z', '2026-03-08', 'ineligible'],
  ['2026-03-08', '2026-03-09T04:00:00Z', '2026-03-09', 'ineligible'],
  ['2026-11-01', '2026-11-01T03:59:59.999Z', '2026-10-31', 'eligible'],
  ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-01', 'ineligible'],
  ['2026-11-01', '2026-11-01T05:30:00Z', '2026-11-01', 'ineligible'],
  ['2026-11-01', '2026-11-01T06:30:00Z', '2026-11-01', 'ineligible'],
  ['2026-11-01', '2026-11-02T04:59:59Z', '2026-11-01', 'ineligible'],
  ['2026-11-01', '2026-11-02T04:59:59.999Z', '2026-11-01', 'ineligible'],
  ['2026-11-01', '2026-11-02T05:00:00Z', '2026-11-02', 'ineligible'],
  ['2026-07-15', '2026-07-15T03:59:59.999Z', '2026-07-14', 'eligible'],
  ['2026-07-15', '2026-07-15T04:00:00Z', '2026-07-15', 'ineligible'],
  ['2026-07-15', '2026-07-16T03:59:59Z', '2026-07-15', 'ineligible'],
  ['2026-07-15', '2026-07-16T03:59:59.999Z', '2026-07-15', 'ineligible'],
  ['2026-07-15', '2026-07-16T04:00:00Z', '2026-07-16', 'ineligible'],
]) test(`delivery fee civil-day boundary ${deliveryDay} at ${instant}`, () => {
  const record = evidence(); record.delivery.civilDate = deliveryDay;
  record.cancellation.recordedAt = Date.parse(instant);
  const before = structuredClone(record);
  Object.values(record).forEach(Object.freeze); Object.freeze(record);
  const result = decide(record);
  assert.equal(result.cancellationCivilDate, day);
  assert.equal(result.feeEligibility, eligibility);
  assert.equal(result.maximumFeeRefundCents, eligibility === 'eligible' ? 1000 : 0);
  assert.equal(result.status, eligibility === 'eligible' ? 'pending_admin_approval' : 'not_eligible');
  assert.equal(result.requiresAdminApproval, true);
  assert.equal(result.automaticRefundAuthorized, false);
  assert.equal(result.providerExecuted, false);
  assert.equal(result.productRefundCents, undefined);
  assert.equal(result.taxRefundCents, undefined);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(record, before);
});
