const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickupEmailCopy } = require('../firebase/functions/pickup-email-copy.cjs');
const evidence = (source) => ({ source, actorUid: 'owner', operationId: '12345678-1234-4234-8234-123456789abc',
  eventId: 'evt_verified', paymentIntentId: 'pi_verified', recordedAt: 1793908800000, totalAmount: 14000, currency: 'usd' });
const order = (extra = {}) => ({
  fulfillmentMethod: 'market_pickup', orderName: 'Mammoth-12345678',
  status: 'pending', paymentMethod: 'pickup', marketName: 'Atlantic Beach Market',
  pickupDate: '2026-11-08', currency: 'usd', subtotal: 16500, discountAmount: 2500,
  deliveryFee: 0, totalAmount: 14000,
  items: [{ name: 'Beef', quantity: 5, price: 2500, itemTotal: 12500 },
    { name: 'Mushroom', quantity: 1, price: 4000, itemTotal: 4000 }], ...extra,
});

test('pending pickup includes stored market/date, quantities and discounted canonical total', () => {
  const o = order();
  const before = structuredClone(o);
  assert.equal(pickupEmailCopy(o), [
    'Pickup order: Mammoth-12345678',
    'Your order is recorded for pickup and will be ready at the selected market on the date below. Payment is due at pickup; bring your order reference.',
    'Market: Atlantic Beach Market', 'Pickup date: 2026-11-08',
    'Items:', '- 5 x Beef', '- 1 x Mushroom', 'Total: USD 140.00',
  ].join('\n'));
  assert.deepEqual(o, before);
});

test('monthly pickup email uses a valid server window, remains one-time, and explains the bounded receipt transfer', () => {
  const text = pickupEmailCopy(order({ pickupType: 'monthly', marketTimezone: 'America/New_York',
    pickupWindowStartAt: Date.parse('2026-11-08T16:00:00.000Z'), pickupWindowEndAt: Date.parse('2026-11-08T16:30:00.000Z') }));
  assert.match(text, /Monthly pickup is a one-time order; it does not renew/);
  assert.match(text, /Pickup window: November 8, 2026 at 11:00 AM EST to November 8, 2026 at 11:30 AM EST/);
  assert.match(text, /private receipt before this window closes/);
  assert.match(text, /no more than 7 days after the original pickup date/);
  const invalid = pickupEmailCopy(order({ pickupType: 'monthly', pickupWindowStartAt: 1, pickupWindowEndAt: 2 }));
  assert.match(invalid, /Pickup window: not confirmed/);
  assert.doesNotMatch(invalid, /1970|12:00/);
  const moved = pickupEmailCopy(order({ pickupType: 'monthly', marketChangeUsed: true }));
  assert.match(moved, /market change has been used/);
  const review = pickupEmailCopy(order({ pickupType: 'monthly', status: 'paid_requires_review',
    pickupWindowStartAt: Date.parse('2026-11-08T16:00:00.000Z'), pickupWindowEndAt: Date.parse('2026-11-08T16:30:00.000Z') }));
  assert.match(review, /Pickup details need review/);
  assert.match(review, /Do not travel/);
  assert.doesNotMatch(review, /November 8, 2026 at 11:00 AM|transfer to an eligible/);
});

test('online awaiting payment never requests payment at pickup or confirms payment', () => {
  const text = pickupEmailCopy(order({ status: 'awaiting_payment', paymentMethod: 'stripe' }));
  assert.match(text, /Online payment is pending\. Payment has not been confirmed\./);
  assert.doesNotMatch(text, /due at pickup|Payment received|pickup is confirmed/);
});

test('paid pickup distinguishes an operator record from provider verification', () => {
  const text = pickupEmailCopy(order({ status: 'paid', paidAt: 1793908800000, paymentEvidence: evidence('operator_declaration') }));
  assert.match(text, /marked paid \(operator record\)/);
  assert.match(text, /not a verified online payment/);
  assert.doesNotMatch(text, /Payment received|due at pickup/);
});

test('paid online requires the stored provider intent and settlement timestamp', () => {
  const paid = { status: 'paid', paymentMethod: 'stripe', paymentIntentId: 'pi_verified', paidAt: 1793908800000, paymentEvidence: evidence('stripe') };
  assert.match(pickupEmailCopy(order(paid)), /Online payment verified/);
  for (const extra of [{ paymentIntentId: null }, { paidAt: undefined }, { paidAt: -1 }, { paidAt: 'now' },
    { paymentIntentId: 'pi_bad\npaid' }, { paymentMethod: 'unknown' }]) {
    const text = pickupEmailCopy(order({ ...paid, ...extra }));
    assert.match(text, /Payment verification is unavailable/);
    assert.doesNotMatch(text, /Online payment verified|Payment received|due at pickup/);
  }
});

test('review, canceled and all unexpected states never fall through to payment due', () => {
  for (const status of ['paid_requires_review', 'canceled', 'cancelled', 'declined', 'awaiting_approval', 'fulfilled', '', null, {}, 'PAID', 'paid\n']) {
    const text = pickupEmailCopy(order({ status, paymentMethod: 'stripe', paymentIntentId: 'pi_verified', paidAt: 1793908800000 }));
    assert.match(text, /No pickup is confirmed/);
    assert.doesNotMatch(text, /Payment received|Online payment verified|due at pickup|No payment was collected/);
  }
  assert.match(pickupEmailCopy(order({ status: 'paid_requires_review' })), /manual review/);
  assert.match(pickupEmailCopy(order({ status: 'canceled' })), /canceled/);
  assert.match(pickupEmailCopy(order({ status: 'pending', paymentMethod: 'stripe' })), /verification is unavailable/);
});

test('paid requires amount-bound explicit provenance, never just a status flag', () => {
  for (const paymentMethod of ['pickup', 'stripe']) {
    for (const paymentEvidence of [undefined, {}, { ...evidence('stripe'), totalAmount: 1 },
      { ...evidence('operator_declaration'), currency: 'eur' }, { ...evidence('stripe'), eventId: 'evt_bad\n' }]) {
      const text = pickupEmailCopy(order({ status: 'paid', paymentMethod, paidAt: 1793908800000,
        paymentIntentId: paymentMethod === 'stripe' ? 'pi_verified' : null, paymentEvidence }));
      assert.match(text, /Payment verification is unavailable/);
      assert.doesNotMatch(text, /Online payment verified|operator record|due at pickup/);
    }
  }
});

test('missing or invalid market/date is explicit and never invents a schedule or time', () => {
  for (const extra of [{ marketName: null }, { marketName: {} }, { pickupDate: undefined },
    { pickupDate: '2026-02-30' }, { pickupDate: '2026-11-08T10:00:00Z' }, { pickupDate: '2026-11-08\n' }]) {
    const text = pickupEmailCopy(order({ ...extra, status: 'paid', paymentMethod: 'stripe', paymentIntentId: 'pi_verified', paidAt: 1793908800000 }));
    assert.match(text, /unavailable/);
    assert.match(text, /No pickup is confirmed/);
    assert.doesNotMatch(text, /10:00|UTC|9 AM|undefined|\[object Object\]/);
  }
  assert.match(pickupEmailCopy(order({ pickupDate: '2024-02-29' })), /Pickup date: 2024-02-29/);
});

test('canonical numeric fields fail closed without coercion or recalculation', () => {
  for (const extra of [{ totalAmount: '14000' }, { totalAmount: Infinity }, { totalAmount: -1 },
    { totalAmount: 100000000 }, { totalAmount: 14000.5 }, { currency: 'eur' }, { currency: 'usd\n' },
    { subtotal: 1 }, { discountAmount: -1 }, { deliveryFee: 500 },
    { items: [] }, { items: null }, { items: Array(51).fill({}) },
    { items: [{ name: 'Beef', quantity: '5', price: 2500, itemTotal: 12500 }] },
    { items: [{ name: 'Beef', quantity: 1001, price: 2500, itemTotal: 2502500 }] },
    { items: [{ name: 'Beef', quantity: 1, price: 2500, itemTotal: 1 }] }]) {
    const text = pickupEmailCopy(order({ ...extra, status: 'paid', paymentMethod: 'stripe', paymentIntentId: 'pi_verified', paidAt: 1793908800000 }));
    assert.match(text, /Order details need review/);
    assert.match(text, /Total: unavailable/);
    assert.doesNotMatch(text, /Online payment verified|Payment received|due at pickup|NaN|Infinity|Total: USD/);
  }
});

test('untrusted labels are bounded single lines, not executable templates or coercible objects', () => {
  const text = pickupEmailCopy(order({ orderName: 'O\r\nBcc: nobody@example.com',
    marketName: 'Market\u202e\u0000\nFake confirmation',
    items: [{ name: '${process.exit()} <b>Beef</b>\r\nTotal: 0', quantity: 5, price: 2500, itemTotal: 12500 },
      { name: 'Mushroom', quantity: 1, price: 4000, itemTotal: 4000 }] }));
  assert.equal(text.split('\n').length, 8);
  assert.doesNotMatch(text, /[\r\u202e\u0000]/);
  assert.match(text, /\$\{process\.exit\(\)\} <b>Beef<\/b> Total: 0/);
  const huge = pickupEmailCopy(order({ orderName: 'x'.repeat(100000), marketName: 'y'.repeat(100000) }));
  assert.ok(huge.length < 1000);
  const hostile = { toString() { throw Error('must not coerce'); } };
  assert.match(pickupEmailCopy(order({ orderName: hostile, marketName: hostile })), /unavailable/);
});

test('reconciliation flags override otherwise paid or pending records', () => {
  for (const extra of [{ reconciliationRequired: true }, { reviewReason: 'Market closed' }]) {
    const text = pickupEmailCopy(order(extra));
    assert.match(text, /manual review/);
    assert.match(text, /No pickup is confirmed/);
    assert.doesNotMatch(text, /due at pickup/);
  }
});

test('contradictory unpaid/payment and adverse records do not issue payment instructions', () => {
  for (const extra of [{ paidAt: 1 }, { paymentEvidence: evidence('operator_declaration') },
    { paymentIntentId: 'pi_pending' }, { refundStatus: 'refunded' }, { canceledAt: 1 }, { disputeStatus: 'open' }]) {
    const text = pickupEmailCopy(order(extra));
    assert.match(text, /No pickup is confirmed/);
    assert.doesNotMatch(text, /due at pickup|Online payment verified/);
  }
});

test('historical delivery/special and malformed fulfillment return null for existing handling', () => {
  for (const o of [undefined, null, [], {}, { fulfillmentMethod: 'local_delivery' }, { fulfillmentMethod: 'special_order' }]) {
    assert.equal(pickupEmailCopy(o), null);
  }
});
