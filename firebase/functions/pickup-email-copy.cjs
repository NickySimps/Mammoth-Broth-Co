'use strict';

const MAX_CENTS = 99999999;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function label(value, limit) {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, limit * 4)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
  return text || null;
}

function storedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.length !== 10) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? value : null;
}

function validAmounts(order) {
  if (order.currency !== 'usd' || !integer(order.totalAmount, 1, MAX_CENTS) ||
      !integer(order.subtotal, 1, MAX_CENTS) || !integer(order.discountAmount, 0, MAX_CENTS) ||
      order.discountAmount > order.subtotal || order.deliveryFee !== 0 ||
      order.subtotal - order.discountAmount !== order.totalAmount ||
      !Array.isArray(order.items) || order.items.length < 1 || order.items.length > 50) return false;
  let subtotal = 0;
  for (const item of order.items) {
    if (!item || !label(item.name, 120) || !integer(item.quantity, 1, 1000) ||
        !integer(item.price, 1, MAX_CENTS) || !integer(item.itemTotal, 1, MAX_CENTS) ||
        item.price * item.quantity !== item.itemTotal) return false;
    subtotal += item.itemTotal;
  }
  return subtotal === order.subtotal;
}

/** Format only a server-stored, exact 30-minute pickup window. */
function monthlyPickupLines(order, validDate, pickupConfirmed) {
  if (order.pickupType !== 'monthly') return [];
  let windowLine = 'Pickup window: not confirmed. Contact us with your reference before traveling.';
  const start = order.pickupWindowStartAt;
  const end = order.pickupWindowEndAt;
  const timezone = typeof order.marketTimezone === 'string' && order.marketTimezone ? order.marketTimezone : 'America/New_York';
  if (pickupConfirmed && validDate && Number.isFinite(start) && Number.isFinite(end) && end - start === 30 * 60 * 1000) {
    try {
      const format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      windowLine = `Pickup window: ${format.format(new Date(start))} to ${format.format(new Date(end))} (30 minutes).`;
    } catch { /* keep the fail-closed copy */ }
  }
  return [
    'Monthly pickup is a one-time order; it does not renew or charge again.',
    windowLine,
    !pickupConfirmed
      ? 'Pickup details need review; contact us with your reference. Do not travel based on this email.'
      : order.marketChangeUsed === true
      ? 'Your one alternative-market change has been used; check this receipt for the current schedule.'
      : 'If plans change, check your private receipt before this window closes; one transfer to an eligible scheduled market may be available, with the new date no more than 7 days after the original pickup date.',
  ];
}
function paymentSource(order) {
  const e = order.paymentEvidence;
  const token = (value, pattern, max = 200) => typeof value === 'string' && value.length <= max &&
    !/[\r\n]/.test(value) && pattern.test(value);
  if (!e || typeof e !== 'object' || Array.isArray(e) ||
      !integer(order.paidAt, 1, Number.MAX_SAFE_INTEGER) ||
      !integer(e.recordedAt, 1, Number.MAX_SAFE_INTEGER) ||
      e.totalAmount !== order.totalAmount || e.currency !== order.currency) return null;
  if (order.paymentMethod === 'pickup' && e.source === 'operator_declaration' &&
      label(e.actorUid, 128) && token(e.operationId, /^[0-9a-f-]{36}$/i) &&
      !order.paymentIntentId && !order.checkoutSessionId && !order.clientSecret && !order.checkoutUrl) return 'operator';
  if (order.paymentMethod === 'stripe' && e.source === 'stripe' &&
      token(order.paymentIntentId, /^pi_[-\w]+$/) && e.paymentIntentId === order.paymentIntentId &&
      token(e.eventId, /^evt_[-\w]+$/)) return 'stripe';
  return null;
}

/**
 * Trusted stored Firestore order -> bounded plain text; non-pickup -> null.
 * No network, credentials, time-of-day inference, mutation, HTML or sending.
 * Provider wording relies on commerce's protected paid transition and its
 * amount-bound paymentEvidence. This function does not itself verify Stripe
 * or look up operator/provider audits; only pass a trusted stored order.
 * Pickup paid with operator_declaration is not provider attestation.
 * Use renderReceiptEmail(text, orderId) for HTML escaping; never re-template data.
 */
function pickupEmailCopy(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order) || order.fulfillmentMethod !== 'market_pickup') return null;
  const name = label(order.orderName, 80);
  const market = label(order.marketName, 160);
  const date = storedDate(order.pickupDate);
  const amountsOK = validAmounts(order);
  const detailsOK = name && market && date && amountsOK;
  const hasValue = (key) => order[key] !== undefined && order[key] !== null && order[key] !== '' && order[key] !== false && order[key] !== 0;
  const conflictingUnpaid = ['pending', 'awaiting_payment'].includes(order.status) &&
    (['paidAt', 'paymentEvidence'].some(hasValue) ||
      (order.paymentMethod === 'pickup' && ['paymentIntentId', 'checkoutSessionId', 'clientSecret', 'checkoutUrl'].some(hasValue)));
  const review = conflictingUnpaid || ['refundStatus', 'refundedAt', 'cancelledAt', 'canceledAt', 'refundId', 'refundAmount', 'amountRefunded', 'disputeStatus'].some(hasValue) || order.status === 'paid_requires_review' ||
    (order.reconciliationRequired !== undefined && order.reconciliationRequired !== false) ||
    (order.reviewReason !== undefined && order.reviewReason !== null && order.reviewReason !== '');
  let status = 'Payment verification is unavailable. No pickup is confirmed; please contact us.';
  if (order.status === 'canceled' || order.status === 'cancelled') {
    status = 'This order is canceled. No pickup is confirmed. Contact us about any payment or refund.';
  } else if (review) {
    status = 'This order needs manual review. No pickup is confirmed; please contact us about fulfillment or a refund.';
  } else if (!detailsOK) {
    status = 'Order details need review. No pickup is confirmed; please contact us.';
  } else if (order.status === 'pending' && order.paymentMethod === 'pickup') {
    status = 'Your order is recorded for pickup and will be ready at the selected market on the date below. Payment is due at pickup; bring your order reference.';
  } else if (order.status === 'awaiting_payment' && order.paymentMethod === 'stripe') {
    status = 'Online payment is pending. Payment has not been confirmed. No pickup confirmation is being issued.';
  } else if (order.status === 'paid' && paymentSource(order) === 'operator') {
    status = 'Order marked paid (operator record). This is not a verified online payment. Your order will be ready at the selected market on the date below; bring your order reference.';
  } else if (order.status === 'paid' && paymentSource(order) === 'stripe') {
    status = 'Online payment verified in the stored order record. Your order will be ready at the selected market on the date below; bring your order reference.';
  }
  if (!detailsOK && !status.startsWith('Order details need review')) status += ' Order details need review.';
  return [
    `Pickup order: ${name || 'unavailable'}`,
    status,
    `Market: ${market || 'unavailable; please contact us'}`,
    `Pickup date: ${date || 'unavailable; please contact us'}`,
    ...monthlyPickupLines(order, date, detailsOK && !review && !conflictingUnpaid &&
      ((order.status === 'pending' && order.paymentMethod === 'pickup') ||
       (order.status === 'paid' && paymentSource(order) !== null))),
    'Items:', ...(amountsOK ? order.items.map(i => `- ${i.quantity} x ${label(i.name, 120)}`) : ['- unavailable; please contact us']),
    amountsOK ? `Total: USD ${(order.totalAmount / 100).toFixed(2)}` : 'Total: unavailable; please contact us',
  ].join('\n');
}

module.exports = { pickupEmailCopy };
