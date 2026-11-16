const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./commerce-vm-fixture.cjs');
const { fixture, base, admin } = require('./commerce-fixture.cjs');
const operationId = '00000000-0000-4000-8000-000000000001';
const timestamp = Date.parse('2026-10-22T12:00:00Z');
const nextOperation = '00000000-0000-4000-8000-000000000002';
const auditEntries = f => [...f.records].filter(([key]) => key.startsWith('pickupActionAudits/'));

async function pending() {
  const f = fixture();
  const r = await f.api.createPreorder({ ...base, paymentMethod: 'pickup' });
  const request = { orderId: r.orderId, operationId, action: 'record_payment', expectedRevision: 0, expectedTotalAmount: 2500, expectedCurrency: 'usd' };
  // The general order revision may advance independently; pickup actions use their own ledger revision.
  f.records.get(`orders/${r.orderId}`).revision = 17;
  return { ...f, request, orderPath: `orders/${r.orderId}` };
}

test('callable is exported without provider/mail credentials and authorizes before DB access', async () => {
  const f = load(false);
  assert.equal(typeof f.handlers.recordMarketPickupAction, 'function');
  assert.deepEqual([...f.handlers.recordMarketPickupAction.options.secrets], []);
  let reads = 0;
  const run = f.db.runTransaction;
  f.db.runTransaction = (...args) => { reads++; return run(...args); };
  for (const context of [{}, { auth: { uid: 'owner', token: { admin: 'true' } } }, { auth: { uid: 'owner', token: { admin: false } } }, { auth: { token: { admin: true } } }]) {
    await assert.rejects(f.handlers.recordMarketPickupAction(null, context), e => e.code === 'permission-denied');
  }
  assert.equal(reads, 0);
  const r = await f.handlers.createPreorder({ ...base, paymentMethod: 'pickup' });
  const result = await f.handlers.recordMarketPickupAction({ orderId: r.orderId, operationId, action: 'record_payment_and_collection', expectedRevision: 0, expectedTotalAmount: 2500, expectedCurrency: 'usd' }, admin);
  assert.equal(result.fulfillmentStatus, 'collected');
  assert.equal(f.payments.length + f.sessions.length + f.mails.length, 0);
});

test('same-actor exact replay returns the original outcome even after later collection and changed order', async () => {
  const f = await pending();
  const first = await f.api.recordMarketPickupAction(f.request, admin);
  await f.api.recordMarketPickupAction({ ...f.request, operationId: nextOperation, action: 'record_collection', expectedRevision: 1 }, admin);
  f.setNow('2026-10-24T12:00:00Z');
  f.records.get(f.orderPath).totalAmount = 2600;
  const before = structuredClone([...f.records]);
  assert.deepEqual(await f.api.recordMarketPickupAction({ ...f.request }, admin), first);
  assert.deepEqual([...f.records], before);
});

test('conflicting operation reuse is rejected for different actor, fields or order', async () => {
  const f = await pending(); await f.api.recordMarketPickupAction(f.request, admin);
  const before = structuredClone([...f.records]);
  for (const patch of [{ action: 'record_collection' }, { expectedRevision: 1 }, { expectedTotalAmount: 2600 }, { expectedCurrency: 'eur' }, { orderId: 'f'.repeat(64) }]) {
    await assert.rejects(f.api.recordMarketPickupAction({ ...f.request, ...patch }, admin), e => e.code === 'failed-precondition');
  }
  await assert.rejects(f.api.recordMarketPickupAction(f.request, { auth: { uid: 'another-owner', token: { admin: true } } }), e => e.code === 'failed-precondition');
  assert.deepEqual([...f.records], before);
});

test('concurrent identical operations commit once; distinct operations race through revision check', async () => {
  const f = await pending();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.api.recordMarketPickupAction(f.request, admin)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(auditEntries(f).length, 1); assert.equal(f.records.get(f.orderPath).pickupAdminRevision, 1);
  assert.equal(f.records.get(f.orderPath).revision, 17, 'pickup actions must not advance the commerce lifecycle revision');
  const race = await pending();
  const outcomes = await Promise.allSettled([race.api.recordMarketPickupAction(race.request, admin), race.api.recordMarketPickupAction({ ...race.request, operationId: nextOperation, action: 'record_payment_and_collection' }, admin)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'rejected' && r.reason.code === 'failed-precondition').length, 1);
  assert.equal(auditEntries(race).length, 1); assert.equal(race.records.get(race.orderPath).pickupAdminRevision, 1);
  assert.equal(race.records.get(race.orderPath).revision, 17, 'pickup actions must not advance the commerce lifecycle revision');
});

test('strict input schema rejects credentials, coercions, invalid identifiers and weird values before any transaction', async () => {
  const f = await pending(); let calls = 0;
  f.db.runTransaction = () => { calls++; throw Error('must validate first'); };
  const invalid = [null, [], false, 'request', ...[
    { orderId: 'A'.repeat(64) }, { orderId: ['a'.repeat(64)] }, { orderId: '../orders/x' },
    { operationId: 'not-a-uuid' }, { operationId: ['00000000-0000-4000-8000-000000000001'] },
    { action: 'paid' }, { expectedRevision: '0' }, { expectedRevision: null }, { expectedRevision: NaN }, { expectedRevision: -1 }, { expectedRevision: 0.5 },
    { expectedTotalAmount: '2500' }, { expectedTotalAmount: 0 }, { expectedTotalAmount: Infinity }, { expectedTotalAmount: 100000000 },
    { expectedCurrency: 'USD' }, { expectedCurrency: ['usd'] }, { expectedCurrency: null },
    { cardNumber: 'do not store' }, { paymentIntentId: 'pi_forged' }, { paidAt: timestamp }, { actorUid: 'forged' },
  ].map(patch => ({ ...f.request, ...patch }))];
  for (const key of Object.keys(f.request)) { const request = { ...f.request }; delete request[key]; invalid.push(request); }
  for (const request of invalid) await assert.rejects(f.api.recordMarketPickupAction(request, admin), e => e.code === 'invalid-argument');
  assert.equal(calls, 0);
});

test('missing orders, stale revisions and changed authoritative totals cannot create audits or mutate state', async () => {
  for (const patch of [{ pickupAdminRevision: 1 }, { pickupAdminRevision: null }, { pickupAdminRevision: '0' }, { pickupAdminRevision: -1 }, { pickupAdminRevision: Number.MAX_SAFE_INTEGER }, { totalAmount: 2600 }, { currency: 'eur' }]) {
    const f = await pending(); Object.assign(f.records.get(f.orderPath), patch);
    const before = structuredClone([...f.records]);
    await assert.rejects(f.api.recordMarketPickupAction(f.request, admin), e => e.code === 'failed-precondition');
    assert.deepEqual([...f.records], before);
  }
  const f = await pending(); f.records.delete(f.orderPath);
  await assert.rejects(f.api.recordMarketPickupAction(f.request, admin), e => e.code === 'not-found');
  assert.equal(auditEntries(f).length, 0);
});

test('admin payment declaration is atomic, authoritative and leaves proof, email and capacity untouched', async () => {
  const f = await pending();
  const before = structuredClone(f.records.get(f.orderPath));
  const market = structuredClone(f.records.get('markets/atlantic'));
  const outcome = await f.api.recordMarketPickupAction(f.request, admin);
  assert.deepEqual(outcome, { orderId: f.request.orderId, operationId, action: 'record_payment', revision: 1, status: 'paid', fulfillmentStatus: 'uncollected', totalAmount: 2500, currency: 'usd', recordedAt: timestamp });
  const order = f.records.get(f.orderPath);
  assert.equal(order.paymentMethod, 'pickup');
  assert.deepEqual(order.paymentEvidence, { source: 'operator_declaration', actorUid: 'owner', operationId, recordedAt: timestamp, totalAmount: 2500, currency: 'usd' });
  assert.equal(order.paidAt, timestamp);
  assert.equal(order.pickupAdminRevision, 1);
  assert.equal(order.revision, before.revision, 'pickup ledger action preserves the commerce lifecycle revision');
  for (const key of Object.keys(before)) if (!['status'].includes(key)) assert.deepEqual(order[key], before[key], key);
  const audits = [...f.records].filter(([key]) => key.startsWith('pickupActionAudits/'));
  assert.equal(audits.length, 1);
  const audit = audits[0][1];
  assert.equal(audit.actorUid, 'owner');
  assert.match(audit.requestDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(audit.before, { status: 'pending', fulfillmentStatus: 'uncollected', revision: 0 });
  assert.deepEqual(audit.after, { status: 'paid', fulfillmentStatus: 'uncollected', revision: 1 });
  assert.deepEqual(audit.outcome, outcome);
  assert.equal(audit.totalAmount, 2500);
  assert.equal(audit.currency, 'usd');
  assert.equal(audit.recordedAt, timestamp);
  assert.deepEqual(f.records.get('markets/atlantic'), market);
  assert.equal(f.payments.length + f.sessions.length + f.mails.length, 0);
});

test('all three actions preserve payment truth and require auditable evidence for collection', async () => {
  const f = await pending();
  const paid = await f.api.recordMarketPickupAction(f.request, admin);
  const evidence = structuredClone(f.records.get(f.orderPath).paymentEvidence);
  const collected = await f.api.recordMarketPickupAction({ ...f.request, operationId: '00000000-0000-4000-8000-000000000002', action: 'record_collection', expectedRevision: paid.revision }, admin);
  assert.equal(collected.fulfillmentStatus, 'collected');
  assert.equal(collected.status, 'paid');
  assert.equal(collected.revision, 2);
  assert.deepEqual(f.records.get(f.orderPath).paymentEvidence, evidence);
  assert.deepEqual(f.records.get(f.orderPath).collectionEvidence, { actorUid: 'owner', operationId: collected.operationId, recordedAt: timestamp });
  const both = await pending();
  const result = await both.api.recordMarketPickupAction({ ...both.request, action: 'record_payment_and_collection' }, admin);
  assert.equal(result.revision, 1);
  assert.equal(result.status, 'paid');
  assert.equal(result.fulfillmentStatus, 'collected');
  assert.equal(both.records.get(both.orderPath).collectedAt, timestamp);
});

test('unsafe states, provider setup and prior evidence fail closed without any writes', async () => {
  const cases = [
    { fulfillmentMethod: 'special_order' }, { fulfillmentMethod: 'local_delivery' },
    ...['paid', 'awaiting_payment', 'paid_requires_review', 'refunded', 'cancelled', 'unknown'].map(status => ({ status })),
    { paymentMethod: 'stripe' }, { paymentMethod: 'unknown' },
    { paymentIntentId: 'pi_active' }, { checkoutSessionId: 'cs_active' }, { clientSecret: 'secret' }, { checkoutUrl: 'https://checkout.stripe.com/x' },
    { paymentLeaseUntil: timestamp + 1 }, { checkoutLeaseUntil: timestamp + 1 },
    { paymentLease: 'orphaned' }, { checkoutLease: 'orphaned' }, { paymentLeaseUntil: 'expired' },
    { paidAt: 0 }, { collectedAt: false }, { paymentEvidence: false },
    { paidAt: timestamp }, { paymentEvidence: {} }, { collectionEvidence: {} }, { collectedAt: timestamp },
    { fulfillmentStatus: 'collected' }, { fulfillmentStatus: 'cancelled' }, { fulfillmentStatus: 'unknown' },
    { reconciliationRequired: true }, { reviewReason: 'manual review' }, { refundStatus: 'pending' }, { refundedAt: timestamp }, { cancelledAt: timestamp },
  ];
  for (const patch of cases) {
    const f = await pending(); Object.assign(f.records.get(f.orderPath), patch);
    const before = structuredClone([...f.records]);
    await assert.rejects(f.api.recordMarketPickupAction(f.request, admin), e => e.code === 'failed-precondition', JSON.stringify(patch));
    assert.deepEqual([...f.records], before);
  }
  for (const patch of [{}, { status: 'paid' }, { status: 'paid', paymentMethod: 'unknown' }, { status: 'paid', paymentEvidence: { source: 'operator_declaration' } }]) {
    const f = await pending(); Object.assign(f.records.get(f.orderPath), patch);
    await assert.rejects(f.api.recordMarketPickupAction({ ...f.request, action: 'record_collection' }, admin), e => e.code === 'failed-precondition');
  }
});

test('only verified Stripe settlement can collect an online order; collection never overwrites provider payment', async () => {
  const f = fixture(); const r = await f.api.createPaymentIntent(base);
  const orderPath = `orders/${r.orderId}`; const order = f.records.get(orderPath);
  const event = { id: 'evt_collect', type: 'payment_intent.succeeded', data: { object: { id: order.paymentIntentId, amount: order.totalAmount, amount_received: order.totalAmount, currency: 'usd', status: 'succeeded', metadata: { orderId: r.orderId, binding: order.paymentBinding } } } };
  await f.api.processStripeEvent(event);
  const before = structuredClone(f.records.get(orderPath));
  const request = { orderId: r.orderId, operationId, action: 'record_collection', expectedRevision: before.pickupAdminRevision ?? 0, expectedTotalAmount: 2500, expectedCurrency: 'usd' };
  const result = await f.api.recordMarketPickupAction(request, admin);
  assert.equal(result.fulfillmentStatus, 'collected'); assert.equal(result.status, 'paid');
  const after = f.records.get(orderPath);
  assert.equal(after.revision, before.revision, 'collection must preserve the commerce lifecycle revision');
  for (const key of ['paidAt', 'paymentMethod', 'paymentIntentId', 'paymentBinding', 'paymentEvidence', 'emailVersion']) assert.deepEqual(after[key], before[key], key);
  assert.equal(f.payments.length, 1); assert.equal(f.sessions.length + f.mails.length, 0);
  const bad = fixture(); const br = await bad.api.createPaymentIntent(base);
  Object.assign(bad.records.get(`orders/${br.orderId}`), { status: 'paid', paidAt: timestamp });
  await assert.rejects(bad.api.recordMarketPickupAction({ ...request, orderId: br.orderId }, admin), e => e.code === 'failed-precondition');
});

test('collection rejects adverse paid states, missing audit and altered declaration evidence', async () => {
  for (const mutate of [
    (f, o) => { o.status = 'paid_requires_review'; },
    (f, o) => { o.status = 'refunded'; },
    (f, o) => { o.status = 'cancelled'; },
    (f, o) => { o.status = 'unknown'; },
    (f, o) => { o.reconciliationRequired = true; },
    (f, o) => { o.reviewReason = 'review'; },
    (f, o) => { o.refundStatus = 'pending'; },
    (f, o) => { o.fulfillmentStatus = 'collected'; },
    (f, o) => { o.paymentEvidence.totalAmount = 1; },
    (f, o) => { o.paymentEvidence.actorUid = 'different'; },
    (f, o) => { o.paymentEvidence.recordedAt++; },
    (f, o) => { f.records.delete(auditEntries(f)[0][0]); },
  ]) {
    const f = await pending(); await f.api.recordMarketPickupAction(f.request, admin);
    mutate(f, f.records.get(f.orderPath));
    const before = structuredClone([...f.records]);
    await assert.rejects(f.api.recordMarketPickupAction({ ...f.request, operationId: nextOperation, action: 'record_collection', expectedRevision: 1 }, admin), e => e.code === 'failed-precondition');
    assert.deepEqual([...f.records], before);
  }
});

test('failed audit write rolls back payment and a later unchanged retry succeeds', async () => {
  const f = await pending(); const run = f.db.runTransaction;
  f.db.runTransaction = callback => run(tx => callback({ ...tx, set: () => { throw Error('fixture audit storage failure'); } }));
  const before = structuredClone([...f.records]);
  await assert.rejects(f.api.recordMarketPickupAction(f.request, admin), /audit storage failure/);
  assert.deepEqual([...f.records], before);
  f.db.runTransaction = run;
  assert.equal((await f.api.recordMarketPickupAction(f.request, admin)).revision, 1);
});

test('expired setup lease alone is not active and customer receipt proof is preserved', async () => {
  const f = await pending(); Object.assign(f.records.get(f.orderPath), { paymentLease: 'stale', paymentLeaseUntil: timestamp - 1 });
  await f.api.recordMarketPickupAction(f.request, admin);
  const receipt = await f.api.getGuestReceipt({ orderId: f.request.orderId, token: base.receiptToken });
  assert.equal(receipt.status, 'paid'); assert.equal(receipt.paymentMethod, 'pickup');
  assert.equal(receipt.paymentEvidence, undefined); assert.equal(receipt.collectionEvidence, undefined);
  assert.equal(f.mails.length, 0);
});

test('Stripe webhook cannot turn a pickup declaration into provider payment', async () => {
  for (const settled of [false, true]) {
    const f = await pending();
    if (settled) await f.api.recordMarketPickupAction(f.request, admin);
    const order = f.records.get(f.orderPath);
    const before = structuredClone([...f.records]);
    await assert.rejects(f.api.processStripeEvent({ id: 'evt_wrong_method', type: 'payment_intent.succeeded', data: { object: { id: 'pi_wrong', status: 'succeeded', amount: 2500, amount_received: 2500, currency: 'usd', metadata: { orderId: f.request.orderId, binding: order.paymentBinding } } } }), e => e.code === 'failed-precondition');
    assert.deepEqual([...f.records], before);
  }
});
