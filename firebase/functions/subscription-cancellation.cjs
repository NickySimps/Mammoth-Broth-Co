'use strict';
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');

/** ISOLATED REQUEST/APPROVAL DOMAIN ONLY: no callable exports or provider execution.
 * Dependencies are trusted server code, never deserialized request callbacks.
 * authorizeManagement must verify identity/ownership OR a scoped, unexpired,
 * non-revoked management capability; checkout capability is NOT management authority.
 * authorizeAdmin must independently verify a current admin identity (not a request
 * flag, supplied email, or unverified context). Both default to deny.
 * These pure authorizers can repeat inside Firestore transactions.
 *
 * Integration blockers: authenticated/App-Check transport; server-only rules for ALL
 * new collections; current management capability provisioning/revocation; dispatcher,
 * scheduler and billing workers must read this cancellation fence transactionally
 * with their own durable leases BEFORE external effects. An already leased provider
 * action/dispatch cannot be recalled. Existing subscription-delivery does NOT read
 * this fence. This module alone does not stop existing checkout/webhook/dispatch.
 * No lease expiry is permission to retry a provider mutation. No provider calls exist.
 * Never describe pending_provider_not_executed as a completed cancellation/refund.
 * selectRefundTarget is a pure server policy returning {amount,currency,
 * policyReference}; there is no default full/fee/tax refund assumption.
 * Approval is NOT executable financial authority: paid history is a snapshot, not
 * current provider refund balance/dispute state. A future executor must reverify
 * current provider objects, remaining refundable amount, adverse events, request
 * hash, admin authority and durable provider idempotency/recovery before any call.
 * Existing adverse-event handling may retain an earlier refund_request hold reason;
 * therefore even an approved record must NEVER bypass that future verification.
 * New server-only collections: subscriptionCancellationFences,
 * subscriptionCancellationOperations, subscriptionRefundRequests,
 * subscriptionRefundApprovals. Existing subscriptionPaymentHolds is shared.
 */
module.exports = function createCancellation({ db, now = Date.now, authorizeManagement = async () => null, authorizeAdmin = async () => null, selectRefundTarget } = {}) {
  const ref = (c, id) => db.collection(c).doc(id);
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  const validOrder = id => typeof id === 'string' && /^ds_[a-f0-9]{64}$/.test(id);
  function input(data, fields) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !fields.includes(k)) || !validOrder(data.subscriptionOrderId) || typeof data.requestId !== 'string' || !/^[-\w]{16,100}$/.test(data.requestId)) fail('invalid-argument', 'Invalid operation.');
  }
  async function management(data, context, subscription, action) {
    const principal = await authorizeManagement({ subscription: structuredClone(subscription), capability: data.capability, context, action });
    if (!subscription || typeof principal?.principalId !== 'string' || !principal.principalId) fail('permission-denied', 'Management authority required.');
    return principal.principalId;
  }
  async function assertOperationAllowed(tx, subscriptionOrderId, invoiceId) {
    if (!validOrder(subscriptionOrderId) || (invoiceId !== undefined && (typeof invoiceId !== 'string' || !/^in_[A-Za-z0-9_]{1,120}$/.test(invoiceId)))) fail('invalid-argument', 'Invalid subscription or invoice.');
    if ((await tx.get(ref('subscriptionCancellationFences', subscriptionOrderId))).data()) fail('failed-precondition', 'Cancellation fence prevents external work.');
    // A dispatcher must supply invoiceId and also verify its shipment status/lease.
    if (invoiceId !== undefined && (await tx.get(ref('subscriptionPaymentHolds', invoiceId))).data()) fail('failed-precondition', 'Payment hold prevents external work.');
  }
  async function requestCancellation(data, context) {
    input(data, ['requestId', 'subscriptionOrderId', 'capability']);
    return db.runTransaction(async tx => {
      const subscription = (await tx.get(ref('deliverySubscriptions', data.subscriptionOrderId))).data();
      const actor = await management(data, context, subscription, 'cancel');
      const fenceRef = ref('subscriptionCancellationFences', data.subscriptionOrderId);
      const fence = (await tx.get(fenceRef)).data();
      const opRef = ref('subscriptionCancellationOperations', hash(data.requestId));
      const old = (await tx.get(opRef)).data();
      const binding = { action: 'cancel', subscriptionOrderId: data.subscriptionOrderId, actor };
      if (old) return replay(old, binding);
      const result = { subscriptionOrderId: data.subscriptionOrderId, status: 'pending_provider_not_executed', providerExecuted: false };
      if (!fence) tx.create(fenceRef, { subscriptionOrderId: data.subscriptionOrderId, held: true, generation: 1, requestedAt: now(), requestedBy: actor });
      tx.create(opRef, { binding, createdAt: now(), result });
      return result;
    });
  }
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const paymentKeys = ['subscriptionOrderId', 'invoiceId', 'subscriptionId', 'customerId', 'paymentIntentId', 'chargeId', 'termsHash', 'currency', 'amountPaid', 'periodStart', 'periodEnd', 'paidAt'];
  const holdKeys = ['subscriptionOrderId', 'invoiceId', 'subscriptionId', 'customerId', 'paymentIntentId', 'chargeId', 'termsHash'];
  function paymentSnapshot(shipment, subscription, data) {
    const payment = Object.fromEntries(paymentKeys.map(k => [k, shipment?.[k]]));
    if (!subscription || shipment?.paymentStatus !== 'paid' || payment.subscriptionOrderId !== data.subscriptionOrderId || payment.invoiceId !== data.invoiceId || payment.subscriptionId !== subscription.subscriptionId || payment.customerId !== subscription.customerId || payment.termsHash !== subscription.termsHash || !Number.isSafeInteger(payment.amountPaid) || payment.amountPaid <= 0 || payment.currency !== 'usd' || !/^sub_[A-Za-z0-9_]+$/.test(payment.subscriptionId || '') || !/^cus_[A-Za-z0-9_]+$/.test(payment.customerId || '') || !/^pi_[A-Za-z0-9_]+$/.test(payment.paymentIntentId || '') || !/^ch_[A-Za-z0-9_]+$/.test(payment.chargeId || '') || !['periodStart', 'periodEnd', 'paidAt'].every(k => Number.isSafeInteger(payment[k]) && payment[k] > 0) || payment.periodEnd <= payment.periodStart || hash(stable(payment)) !== shipment.paymentHash) fail('failed-precondition', 'Verified paid history required.');
    return payment;
  }
  function refundInput(data, approving = false) {
    input(data, approving ? ['requestId', 'subscriptionOrderId', 'invoiceId'] : ['requestId', 'subscriptionOrderId', 'invoiceId', 'capability']);
    if (typeof data.invoiceId !== 'string' || !/^in_[A-Za-z0-9_]{1,120}$/.test(data.invoiceId)) fail('invalid-argument', 'Invalid invoice.');
  }
  function validateTarget(target, payment) {
    if (!target || !Number.isSafeInteger(target.amount) || target.amount <= 0 || target.amount > payment.amountPaid || target.currency !== payment.currency || typeof target.policyReference !== 'string' || !target.policyReference.trim() || target.policyReference.length > 200) fail('failed-precondition', 'Server refund policy required.');
    return { amount: target.amount, currency: target.currency, policyReference: target.policyReference };
  }
  function replay(old, binding) {
    if (!old) return null;
    if (stable(old.binding) !== stable(binding)) fail('already-exists', 'Operation key already bound.');
    return old.result;
  }
  async function requestRefund(data, context) {
    refundInput(data);
    return db.runTransaction(async tx => {
      const subscription = (await tx.get(ref('deliverySubscriptions', data.subscriptionOrderId))).data();
      const actor = await management(data, context, subscription, 'refund_request');
      const shipment = (await tx.get(ref('subscriptionShipments', data.invoiceId))).data();
      const requestRef = ref('subscriptionRefundRequests', data.invoiceId);
      const request = (await tx.get(requestRef)).data();
      const holdRef = ref('subscriptionPaymentHolds', data.invoiceId);
      const hold = (await tx.get(holdRef)).data();
      const opRef = ref('subscriptionCancellationOperations', hash(data.requestId));
      const old = (await tx.get(opRef)).data();
      const binding = { action: 'refund_request', subscriptionOrderId: data.subscriptionOrderId, invoiceId: data.invoiceId, actor };
      const payment = paymentSnapshot(shipment, subscription, data);
      if (hold && holdKeys.some(k => hold[k] !== payment[k])) fail('failed-precondition', 'Conflicting payment hold.');
      if (request && (request.requestedBy !== actor || stable(request.payment) !== stable(payment))) fail('failed-precondition', 'Refund request already bound.');
      const prior = replay(old, binding); if (prior) return prior;
      if (!request && typeof selectRefundTarget !== 'function') fail('failed-precondition', 'Server refund policy required.');
      // Pure server policy may repeat on transaction retry. No tax/fee default.
      const target = request ? validateTarget(request.target, payment) : validateTarget(await selectRefundTarget({ payment: structuredClone(payment), subscription: structuredClone(subscription) }), payment);
      const result = { subscriptionOrderId: data.subscriptionOrderId, invoiceId: data.invoiceId, status: 'pending_admin_approval', providerExecuted: false };
      if (!request) tx.create(requestRef, { payment, paymentHash: shipment.paymentHash, target, requestedBy: actor, requestedAt: now(), status: result.status });
      if (!hold) tx.create(holdRef, { ...Object.fromEntries(holdKeys.map(k => [k, payment[k]])), held: true, reason: 'refund_request', requestedAt: now() });
      tx.create(opRef, { binding, createdAt: now(), result });
      return result;
    });
  }
  async function approveRefund(data, context) {
    refundInput(data, true);
    return db.runTransaction(async tx => {
      const principal = await authorizeAdmin({ context, action: 'refund_approve' });
      if (principal?.admin !== true || typeof principal.uid !== 'string' || !principal.uid) fail('permission-denied', 'Verified administrator required.');
      const subscription = (await tx.get(ref('deliverySubscriptions', data.subscriptionOrderId))).data();
      const shipment = (await tx.get(ref('subscriptionShipments', data.invoiceId))).data();
      const request = (await tx.get(ref('subscriptionRefundRequests', data.invoiceId))).data();
      const hold = (await tx.get(ref('subscriptionPaymentHolds', data.invoiceId))).data();
      const approvalRef = ref('subscriptionRefundApprovals', data.invoiceId);
      const approval = (await tx.get(approvalRef)).data();
      const opRef = ref('subscriptionCancellationOperations', hash(data.requestId));
      const old = (await tx.get(opRef)).data();
      const payment = paymentSnapshot(shipment, subscription, data);
      if (!request || request.status !== 'pending_admin_approval' || request.paymentHash !== shipment.paymentHash || stable(request.payment) !== stable(payment) || !hold || hold.held !== true || hold.reason !== 'refund_request' || holdKeys.some(k => hold[k] !== payment[k])) fail('failed-precondition', 'Unresolved payment or request hold.');
      const target = validateTarget(request.target, payment);
      const requestHash = hash(stable(request));
      if (approval && approval.requestHash !== requestHash) fail('failed-precondition', 'Approval target changed.');
      const binding = { action: 'refund_approve', subscriptionOrderId: data.subscriptionOrderId, invoiceId: data.invoiceId, actor: principal.uid };
      const prior = replay(old, binding); if (prior) return prior;
      const result = { subscriptionOrderId: data.subscriptionOrderId, invoiceId: data.invoiceId, status: 'approved_not_executed', providerExecuted: false };
      if (!approval) tx.create(approvalRef, { requestHash, paymentHash: shipment.paymentHash, target, approvedBy: principal.uid, approvedAt: now(), status: result.status });
      tx.create(opRef, { binding, createdAt: now(), result });
      return result;
    });
  }
  return { requestCancellation, requestRefund, approveRefund, assertOperationAllowed };
};
