'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const factory = '../firebase/functions/subscription-cancellation.cjs';
const orderId = `ds_${'a'.repeat(64)}`;
function memoryDB() {
  const docs = new Map(); let tail = Promise.resolve(), failCommit = false;
  return { docs, failNextCommit() { failCommit = true; }, collection: c => ({ doc: id => ({ path: `${c}/${id}` }) }),
    runTransaction(fn) {
      const run = tail.then(async () => {
        const draft = structuredClone(docs); let writing = false;
        const result = await fn({
          get: async r => { assert.equal(writing, false, 'reads precede writes'); return { data: () => structuredClone(draft.get(r.path)) }; },
          create(r, value) { writing = true; assert.ok(!draft.has(r.path)); draft.set(r.path, structuredClone(value)); },
        });
        if (failCommit) { failCommit = false; throw Error('commit interrupted'); }
        docs.clear(); for (const [k,v] of draft) docs.set(k,v); return result;
      }); tail = run.catch(() => {}); return run;
    } };
}
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(options = {}) {
  const db = memoryDB();
  db.docs.set(`deliverySubscriptions/${orderId}`, { id: orderId, subscriptionId: 'sub_test', customerId: 'cus_test', termsHash: 'frozen', terms: { uid: 'buyer' } });
  const api = require(factory)({ db, now: () => 1800000000000,
    authorizeManagement: async ({ context, subscription, capability }) => context === buyer && subscription.terms.uid === 'buyer' || capability === 'server-verified-capability' ? { principalId: 'buyer' } : null,
    authorizeAdmin: async ({ context }) => context === admin ? { uid: 'operator', admin: true } : null,
    ...options });
  return { db, api };
}
const buyer = Object.freeze({ verified: 'buyer' }), admin = Object.freeze({ verified: 'admin' });
const cancel = requestId => ({ requestId: requestId || 'cancel-request-0001', subscriptionOrderId: orderId });
function paid(f, fulfillmentStatus = 'scheduled') {
  const payment = { subscriptionOrderId: orderId, invoiceId: 'in_test', subscriptionId: 'sub_test', customerId: 'cus_test', paymentIntentId: 'pi_test', chargeId: 'ch_test', termsHash: 'frozen', currency: 'usd', amountPaid: 15000, periodStart: 1800000000000, periodEnd: 1801209600000, paidAt: 1800000000000 };
  const record = { ...payment, paymentHash: hash(stable(payment)), paymentStatus: 'paid', fulfillmentStatus, feeCents: 1000 };
  f.db.docs.set('subscriptionShipments/in_test', record); return structuredClone(record);
}
const refund = requestId => ({ ...cancel(requestId || 'refund-request-0001'), invoiceId: 'in_test' });

test('paid refund requests freeze a server-selected amount and hold without changing paid history', async () => {
  const f = fixture({ selectRefundTarget: () => ({ amount: 12000, currency: 'usd', policyReference: 'approved-product-only-v1' }) });
  const original = paid(f, 'fulfilled');
  const result = await f.api.requestRefund(refund(), buyer);
  assert.equal(result.status, 'pending_admin_approval');
  assert.equal(result.providerExecuted, false);
  assert.deepEqual(f.db.docs.get('subscriptionShipments/in_test'), original);
  const request = f.db.docs.get('subscriptionRefundRequests/in_test');
  assert.deepEqual(request.target, { amount: 12000, currency: 'usd', policyReference: 'approved-product-only-v1' });
  assert.equal(request.payment.amountPaid, 15000);
  assert.equal(f.db.docs.get('subscriptionPaymentHolds/in_test').held, true);
  assert.equal(f.db.docs.get('subscriptionPaymentHolds/in_test').chargeId, 'ch_test');
  const approval = await f.api.approveRefund(refund('approve-request-0001'), admin);
  assert.equal(approval.status, 'approved_not_executed');
  assert.equal(approval.providerExecuted, false);
  assert.equal(f.db.docs.get('subscriptionRefundApprovals/in_test').approvedBy, 'operator');
  assert.deepEqual(f.db.docs.get('subscriptionShipments/in_test'), original);
  assert.equal(f.db.docs.get('subscriptionRefundRequests/in_test').status, 'pending_admin_approval');
});

test('refund hold rejects dispatch even without a subscription cancellation', async () => {
  const f = fixture({ selectRefundTarget: () => ({ amount: 12000, currency: 'usd', policyReference: 'server-v1' }) }); paid(f);
  await f.api.requestRefund(refund(), buyer);
  await assert.rejects(f.db.runTransaction(tx => f.api.assertOperationAllowed(tx, orderId, 'in_test')), { code: 'failed-precondition' });
});

const policy = () => ({ amount: 12000, currency: 'usd', policyReference: 'server-v1' });

test('default authorizers deny spoofed buyer/admin claims without writes', async () => {
  const f = fixture({ authorizeManagement: undefined, authorizeAdmin: undefined }); paid(f);
  const before = structuredClone(f.db.docs);
  for (const context of [undefined, {}, { auth: { uid: 'buyer', token: { admin: true } }, admin: true }]) {
    await assert.rejects(f.api.requestCancellation(cancel(), context), { code: 'permission-denied' });
    await assert.rejects(f.api.requestRefund(refund(), context), { code: 'permission-denied' });
    await assert.rejects(f.api.approveRefund(refund(), context), { code: 'permission-denied' });
  }
  assert.deepEqual(f.db.docs, before);
});

test('authorization is rechecked on every cancellation/refund/approval replay', async () => {
  let revoked = false;
  const f = fixture({ selectRefundTarget: policy,
    authorizeManagement: async () => revoked ? null : { principalId: 'buyer' },
    authorizeAdmin: async () => revoked ? null : { uid: 'operator', admin: true } }); paid(f);
  await f.api.requestCancellation(cancel(), buyer);
  await f.api.requestRefund(refund(), buyer);
  await f.api.approveRefund(refund('approve-request-0001'), admin);
  const before = structuredClone(f.db.docs); revoked = true;
  await assert.rejects(f.api.requestCancellation(cancel(), buyer), { code: 'permission-denied' });
  await assert.rejects(f.api.requestRefund(refund(), buyer), { code: 'permission-denied' });
  await assert.rejects(f.api.approveRefund(refund('approve-request-0001'), admin), { code: 'permission-denied' });
  assert.deepEqual(f.db.docs, before);
});

test('only the injected scoped management verifier can authorize a capability', async () => {
  const f = fixture();
  await assert.rejects(f.api.requestCancellation({ ...cancel(), capability: 'unverified' }, {}), { code: 'permission-denied' });
  await f.api.requestCancellation({ ...cancel(), capability: 'server-verified-capability' }, {});
  assert.ok(!JSON.stringify([...f.db.docs]).includes('server-verified-capability'));
});

for (const change of [r => { r.amount = 1; }, r => { r.admin = true; }, r => { r.currency = 'eur'; }, r => { r.requestId = '../bad'; }, r => { r.subscriptionOrderId = 'other'; }, r => { r.invoiceId = '../other'; }]) {
  test('client-controlled extra fields or malformed identifiers cannot target a refund', async () => {
    const f = fixture({ selectRefundTarget: policy }); paid(f); const r = refund(); change(r);
    const before = structuredClone(f.db.docs);
    await assert.rejects(f.api.requestRefund(r, buyer), { code: 'invalid-argument' });
    assert.deepEqual(f.db.docs, before);
  });
}

for (const target of [undefined, { amount: 15001, currency: 'usd', policyReference: 'v1' }, { amount: 0, currency: 'usd', policyReference: 'v1' }, { amount: 1.5, currency: 'usd', policyReference: 'v1' }, { amount: 100, currency: 'eur', policyReference: 'v1' }, { amount: 100, currency: 'usd' }]) {
  test('missing or invalid server refund policy fails atomically', async () => {
    const f = fixture({ selectRefundTarget: target ? () => target : undefined }); paid(f);
    const before = structuredClone(f.db.docs);
    await assert.rejects(f.api.requestRefund(refund(), buyer), { code: 'failed-precondition' });
    assert.deepEqual(f.db.docs, before);
  });
}

test('unpaid, corrupt or foreign payment evidence cannot create request/hold', async () => {
  for (const mutate of [p => { p.paymentStatus = 'unpaid'; }, p => { p.amountPaid--; }, p => { p.subscriptionOrderId = `ds_${'b'.repeat(64)}`; }, p => { p.chargeId = 'ch_other'; }, p => { p.paymentHash = 'wrong'; }]) {
    const f = fixture({ selectRefundTarget: policy }); paid(f); mutate(f.db.docs.get('subscriptionShipments/in_test'));
    await assert.rejects(f.api.requestRefund(refund(), buyer), { code: 'failed-precondition' });
    assert.ok(!f.db.docs.has('subscriptionPaymentHolds/in_test'));
    assert.ok(!f.db.docs.has('subscriptionRefundRequests/in_test'));
  }
  const f = fixture({ selectRefundTarget: policy });
  await assert.rejects(f.api.requestRefund(refund(), buyer), { code: 'failed-precondition' });
});

test('buyer and spoofed admin cannot approve; approval requires an existing request and hold', async () => {
  const f = fixture({ selectRefundTarget: policy }); paid(f);
  await assert.rejects(f.api.approveRefund(refund('approve-request-0001'), admin), { code: 'failed-precondition' });
  await f.api.requestRefund(refund(), buyer);
  for (const context of [buyer, {}, { auth: { uid: 'operator', token: { admin: true } } }]) await assert.rejects(f.api.approveRefund(refund('approve-request-0001'), context), { code: 'permission-denied' });
  f.db.docs.delete('subscriptionPaymentHolds/in_test');
  await assert.rejects(f.api.approveRefund(refund('approve-request-0001'), admin), { code: 'failed-precondition' });
});

test('adverse holds survive requests and block approval, never auto-release', async () => {
  const f = fixture({ selectRefundTarget: policy }); const original = paid(f);
  const hold = Object.fromEntries(['subscriptionOrderId','invoiceId','subscriptionId','customerId','paymentIntentId','chargeId','termsHash'].map(k => [k,original[k]]));
  Object.assign(hold, { held: true, reason: 'refund_or_dispute', firstEventId: 'evt_adverse' });
  f.db.docs.set('subscriptionPaymentHolds/in_test', hold);
  await f.api.requestRefund(refund(), buyer);
  await assert.rejects(f.api.approveRefund(refund('approve-request-0001'), admin), { code: 'failed-precondition' });
  assert.deepEqual(f.db.docs.get('subscriptionPaymentHolds/in_test'), hold);
  assert.deepEqual(f.db.docs.get('subscriptionShipments/in_test'), original);
});

test('concurrent retries deduplicate immutable requests/approvals and freeze policy target', async () => {
  let count = 0;
  const f = fixture({ selectRefundTarget: () => { count++; return { ...policy(), amount: count === 1 ? 12000 : 100 }; } }); const original = paid(f);
  await Promise.all(Array.from({ length: 12 }, () => f.api.requestCancellation(cancel(), buyer)));
  await Promise.all(Array.from({ length: 12 }, () => f.api.requestRefund(refund(), buyer)));
  await f.api.requestRefund(refund('refund-request-0002'), buyer);
  await Promise.all(Array.from({ length: 12 }, () => f.api.approveRefund(refund('approve-request-0001'), admin)));
  await f.api.approveRefund(refund('approve-request-0002'), admin);
  assert.equal(count, 1);
  assert.equal(f.db.docs.get('subscriptionRefundRequests/in_test').target.amount, 12000);
  assert.equal(f.db.docs.get('subscriptionRefundApprovals/in_test').target.amount, 12000);
  assert.equal([...f.db.docs.keys()].filter(k => k.startsWith('subscriptionRefundApprovals/')).length, 1);
  assert.deepEqual(f.db.docs.get('subscriptionShipments/in_test'), original);
  await assert.rejects(f.api.requestRefund(refund(cancel().requestId), buyer), { code: 'already-exists' });
});

test('interrupted commits roll back request and hold; exact retry recovers without provider actions', async () => {
  const forbiddenProvider = new Proxy({}, { get() { throw Error('NO PROVIDER EXECUTION'); } });
  const f = fixture({ selectRefundTarget: policy, stripe: forbiddenProvider }); paid(f);
  const before = structuredClone(f.db.docs); f.db.failNextCommit();
  await assert.rejects(f.api.requestRefund(refund(), buyer), /commit interrupted/);
  assert.deepEqual(f.db.docs, before);
  await f.api.requestRefund(refund(), buyer);
  const requested = structuredClone(f.db.docs); f.db.failNextCommit();
  await assert.rejects(f.api.approveRefund(refund('approve-request-0001'), admin), /commit interrupted/);
  assert.deepEqual(f.db.docs, requested);
  await f.api.approveRefund(refund('approve-request-0001'), admin);
  assert.equal(f.db.docs.get('subscriptionRefundApprovals/in_test').status, 'approved_not_executed');
});

test('cancellation winning lease race prevents future billing and dispatch claims', async () => {
  const f = fixture();
  await f.db.runTransaction(tx => f.api.assertOperationAllowed(tx, orderId, 'in_test'));
  const cancellation = f.api.requestCancellation(cancel(), buyer);
  const claim = f.db.runTransaction(async tx => { await f.api.assertOperationAllowed(tx, orderId, 'in_test'); tx.create(f.db.collection('testLeases').doc('dispatch'), { claimed: true }); });
  await cancellation;
  await assert.rejects(claim, { code: 'failed-precondition' });
  assert.ok(!f.db.docs.has('testLeases/dispatch'));
});

test('approval cannot be retargeted after the immutable request was approved', async () => {
  const f = fixture({ selectRefundTarget: policy }); paid(f);
  await f.api.requestRefund(refund(), buyer);
  await f.api.approveRefund(refund('approve-request-0001'), admin);
  const original = structuredClone(f.db.docs.get('subscriptionRefundApprovals/in_test'));
  f.db.docs.get('subscriptionRefundRequests/in_test').target.amount--;
  await assert.rejects(f.api.approveRefund(refund('approve-request-0002'), admin), { code: 'failed-precondition' });
  assert.deepEqual(f.db.docs.get('subscriptionRefundApprovals/in_test'), original);
});

test('cancellation after payment preserves paid delivery history and never creates automatic refund approval', async () => {
  const f = fixture(); const original = paid(f);
  await f.api.requestCancellation(cancel(), buyer);
  assert.deepEqual(f.db.docs.get('subscriptionShipments/in_test'), original);
  assert.equal([...f.db.docs.keys()].filter(k => k.startsWith('subscriptionRefund')).length, 0);
  await assert.rejects(f.db.runTransaction(tx => f.api.assertOperationAllowed(tx, orderId, 'in_test')), { code: 'failed-precondition' });
});

test('cancellation retry accepts reordered persisted binding keys without writes', async () => {
  const f = fixture();
  const result = await f.api.requestCancellation(cancel(), buyer);
  const operation = f.db.docs.get(`subscriptionCancellationOperations/${hash(cancel().requestId)}`);
  const originalBinding = operation.binding;
  operation.binding = Object.fromEntries(Object.entries(originalBinding).reverse());
  assert.notEqual(JSON.stringify(operation.binding), JSON.stringify(originalBinding));
  assert.deepEqual(operation.binding, originalBinding);
  const before = structuredClone(f.db.docs);
  assert.deepEqual(await f.api.requestCancellation(cancel(), buyer), result);
  assert.deepEqual(f.db.docs, before);
});

for (const [field, value] of [['action', 'refund_request'], ['subscriptionOrderId', `ds_${'b'.repeat(64)}`], ['actor', 'other-buyer'], ['extra', 'unexpected']]) {
  test(`cancellation retry rejects tampered persisted binding ${field} without writes`, async () => {
    const f = fixture();
    await f.api.requestCancellation(cancel(), buyer);
    const operation = f.db.docs.get(`subscriptionCancellationOperations/${hash(cancel().requestId)}`);
    operation.binding = { ...Object.fromEntries(Object.entries(operation.binding).reverse()), [field]: value };
    const before = structuredClone(f.db.docs);
    await assert.rejects(f.api.requestCancellation(cancel(), buyer), { code: 'already-exists' });
    assert.deepEqual(f.db.docs, before);
  });
}

test('cancellation interruption leaves no partial fence and retry remains immutable', async () => {
  const f = fixture(); const before = structuredClone(f.db.docs); f.db.failNextCommit();
  await assert.rejects(f.api.requestCancellation(cancel(), buyer), /commit interrupted/);
  assert.deepEqual(f.db.docs, before);
  await f.api.requestCancellation(cancel(), buyer); const committed = structuredClone(f.db.docs);
  await f.api.requestCancellation(cancel(), buyer);
  assert.deepEqual(f.db.docs, committed);
});

for (const principal of [null, true, { uid: 'operator', admin: 'true' }, { uid: '', admin: true }, { admin: true }]) {
  test('admin verifier must return an explicit verified identity with strict boolean authority', async () => {
    const f = fixture({ selectRefundTarget: policy, authorizeAdmin: async () => principal }); paid(f);
    await f.api.requestRefund(refund(), buyer);
    await assert.rejects(f.api.approveRefund(refund('approve-request-0001'), admin), { code: 'permission-denied' });
    assert.ok(!f.db.docs.has('subscriptionRefundApprovals/in_test'));
  });
}

test('cancellation durably fences billing/dispatch without claiming provider cancellation', async () => {
  const f = fixture();
  const result = await f.api.requestCancellation(cancel(), buyer);
  assert.equal(result.status, 'pending_provider_not_executed');
  assert.equal(result.providerExecuted, false);
  assert.equal(f.db.docs.get(`subscriptionCancellationFences/${orderId}`).held, true);
  await assert.rejects(f.db.runTransaction(tx => f.api.assertOperationAllowed(tx, orderId)), { code: 'failed-precondition' });
  assert.equal(f.db.docs.get(`deliverySubscriptions/${orderId}`).subscriptionId, 'sub_test');
});
