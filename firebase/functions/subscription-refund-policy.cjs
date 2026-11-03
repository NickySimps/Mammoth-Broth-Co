'use strict';

/** ISOLATED, pure policy, NOT an approval or a callable/executor.
 * verifyServerEvidence is a synchronous, pure TRUSTED SERVER dependency, never a
 * request callback. It must return identity-bound, previously verified immutable
 * {payment, cancellation, delivery} snapshots from server-only history, or null.
 * A client `verified`/`admin` flag, Object.freeze or a supplied digest is NOT proof.
 * payment.deliveryFeeCents is the actual provider-verified fee for THIS invoice,
 * not today's catalogue fee; deliveryFeeRecurring confirms this cycle was charged.
 * cancellation.recordedAt is server-recorded epoch milliseconds, not client time.
 * delivery.civilDate and timeZone are the frozen verified delivery civil schedule.
 * No default date, timezone, price, tax, full refund or approval is inferred.
 * A future adapter must verify the server-only records and approval independently;
 * a future executor must reverify remaining balance/disputes and idempotency.
 */
const isDataRecord = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
};
const validCivilDate = value => {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
module.exports = function createRefundPolicy({ verifyServerEvidence } = {}) {
  return function decideFeeRefund(input) {
    if (!isDataRecord(input) ||
        Reflect.ownKeys(input).some(k => !['subscriptionOrderId', 'invoiceId'].includes(k)) ||
        typeof input.subscriptionOrderId !== 'string' || !/^ds_[a-f0-9]{64}$/.test(input.subscriptionOrderId) ||
        typeof input.invoiceId !== 'string' || !/^in_[A-Za-z0-9_]{1,120}$/.test(input.invoiceId)) {
      const error = new Error('Only server-history target identifiers are accepted.');
      error.code = 'invalid-argument'; throw error;
    }
    const base = { requiresAdminApproval: true, automaticRefundAuthorized: false, providerExecuted: false };
    const review = reason => Object.freeze({ ...base, feeEligibility: 'needs_review', status: 'needs_review',
      maximumFeeRefundCents: null, reason });
    if (typeof verifyServerEvidence !== 'function') return review('verified_server_evidence_required');
    let record;
    try { record = verifyServerEvidence(Object.freeze({ ...input })); }
    catch { return review('verified_server_evidence_unavailable'); }
    if (!isDataRecord(record)) return review('verified_server_evidence_required');
    const { payment, cancellation, delivery } = record;
    if (![payment, cancellation, delivery].every(value => isDataRecord(value) &&
        value.subscriptionOrderId === input.subscriptionOrderId && value.invoiceId === input.invoiceId)) {
      return review('identity_bound_server_history_required');
    }
    if (payment.paymentStatus !== 'paid' || payment.currency !== 'usd' ||
        !Number.isSafeInteger(payment.amountPaid) || payment.amountPaid <= 0 ||
        payment.deliveryFeeRecurring !== true || !Number.isSafeInteger(payment.deliveryFeeCents) ||
        payment.deliveryFeeCents < 0 || payment.deliveryFeeCents > payment.amountPaid) {
      return review('verified_cycle_fee_required');
    }
    if (!validCivilDate(delivery.civilDate) || typeof delivery.timeZone !== 'string' ||
        !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(delivery.timeZone) ||
        !Number.isSafeInteger(cancellation.recordedAt) || cancellation.recordedAt <= 0 ||
        !Number.isFinite(new Date(cancellation.recordedAt).getTime())) {
      return review('verified_delivery_date_timezone_and_cancellation_required');
    }
    let cancellationCivilDate;
    try {
      const parts = new Intl.DateTimeFormat('en-US', { calendar: 'iso8601', numberingSystem: 'latn',
        timeZone: delivery.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(cancellation.recordedAt));
      const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      cancellationCivilDate = `${date.year.padStart(4, '0')}-${date.month}-${date.day}`;
      if (!validCivilDate(cancellationCivilDate)) return review('invalid_cancellation_civil_date');
    } catch { return review('invalid_delivery_timezone'); }
    const feeEligibility = cancellationCivilDate < delivery.civilDate ? 'eligible' : cancellationCivilDate > delivery.civilDate ? 'ineligible' : 'needs_review';
    return Object.freeze({ ...base, feeEligibility,
      status: feeEligibility === 'eligible' ? 'pending_admin_approval' : feeEligibility === 'ineligible' ? 'not_eligible' : 'needs_review',
      maximumFeeRefundCents: feeEligibility === 'eligible' ? payment.deliveryFeeCents : feeEligibility === 'ineligible' ? 0 : null,
      currency: payment.currency, cancellationCivilDate });
  };
};
