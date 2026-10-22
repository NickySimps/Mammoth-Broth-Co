const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, base, admin } = require('./commerce-fixture.cjs');

test('both creation paths and retries return the persisted authoritative orderName', async () => {
  for (const method of ['createPreorder', 'createPaymentIntent']) {
    const f = fixture();
    const input = method === 'createPreorder' ? { ...base, paymentMethod: 'pickup' } : base;
    const r = await f.api[method](input, {});
    assert.equal(r.orderName, f.records.get(`orders/${r.orderId}`).orderName);
    assert.equal((await f.api[method](input, {})).orderName, r.orderName);
  }
});

test('pickup accepts only approved occurrences in the configured timezone and scopes legacy limits to one date', async () => {
  for (const mutation of [
    m => { delete m.timezone; },
    m => { delete m.day; delete m.weekday; delete m.pickupDates; },
    m => { m.timezone = 'Not/A_Zone'; },
    m => { m.pickupDates = ['2026-10-26']; },
    m => { m.weekday = 2; delete m.day; },
    m => { Object.assign(m, { capacity: 2, reservedCount: 0, occurrenceDate: '2026-11-01' }); },
    m => { m.orderCutoffAt = '2026-10-24T00:00:00Z'; delete m.occurrenceDate; },
  ]) {
    const f = fixture(); mutation(f.records.get('markets/atlantic'));
    await assert.rejects(f.api.createPaymentIntent({ ...base, pickupDate: '2026-10-25' }, {}), /schedule|occurrence|timezone/i);
    assert.equal(f.payments.length, 0);
  }
  const f = fixture();
  Object.assign(f.records.get('markets/atlantic'), { day: 0, timezone: 'America/New_York' });
  await assert.rejects(f.api.createPaymentIntent({ ...base, pickupDate: '2026-11-01' }, {}), /occurrence/i);
  await f.api.createPaymentIntent({ ...base, pickupDate: '2026-10-25' }, {});
  const explicit = fixture();
  Object.assign(explicit.records.get('markets/atlantic'), { pickupDates: ['2026-11-01'], timezone: 'America/New_York' });
  await explicit.api.createPaymentIntent({ ...base, pickupDate: '2026-11-01' }, {});
  const boundary = fixture();
  boundary.setNow('2026-10-25T00:30:00Z'); // still Saturday in New York
  await boundary.api.createPaymentIntent({ ...base, pickupDate: '2026-10-25' }, {});
});

function paidEvent(f, r, id) {
  const o = f.records.get(`orders/${r.orderId}`);
  return { id, type: 'payment_intent.succeeded', data: { object: { id: o.paymentIntentId, status: 'succeeded', amount: o.totalAmount, amount_received: o.totalAmount, currency: 'usd', metadata: { orderId: r.orderId, binding: o.paymentBinding } } } };
}

test('unpaid card attempts never consume capacity; settlement race holds excess paid orders for reconciliation', async () => {
  const f = fixture();
  Object.assign(f.records.get('markets/atlantic'), { capacity: 1, reservedCount: 0, occurrenceDate: base.pickupDate });
  f.setFailPayment(true);
  await assert.rejects(f.api.createPaymentIntent(base, {}), /unavailable/i);
  assert.equal(f.records.get('markets/atlantic').reservedCount, 0, 'provider outage cannot hold capacity');
  f.setFailPayment(false);
  const first = await f.api.createPaymentIntent(base, {});
  const second = await f.api.createPaymentIntent({ ...base, requestId: 'second-card-request-123' }, {});
  assert.equal(f.records.get('markets/atlantic').reservedCount, 0, 'abandonment cannot hold capacity');
  await Promise.all([f.api.processStripeEvent(paidEvent(f, first, 'evt_race1')), f.api.processStripeEvent(paidEvent(f, second, 'evt_race2'))]);
  assert.equal(f.records.get('markets/atlantic').reservedCount, 1);
  assert.equal(f.records.get(`orders/${first.orderId}`).status, 'paid');
  assert.equal(f.records.get(`orders/${second.orderId}`).status, 'paid_requires_review');
  await f.api.deliverOrderEmail({ orderId: second.orderId });
  assert.match(f.mails[0].text, /payment received.*manual review/i);
  assert.doesNotMatch(f.mails[0].text, /payment is due|pay securely/i);
  await f.api.processStripeEvent(paidEvent(f, second, 'evt_race3'));
  assert.equal(f.records.get('markets/atlantic').reservedCount, 1);
  assert.equal(f.records.get(`orders/${second.orderId}`).emailVersion, 1);
});

test('transactional limits cap fresh attempts by bounded email buckets and global circuit breaker without trusting IP', async () => {
  const { createHash } = require('node:crypto');
  for (const kind of ['email', 'global']) {
    const f = fixture();
    if (kind === 'global') f.records.set('commerceRateLimits/v2-global', { windowStart: Date.parse('2026-10-22T12:00:00Z'), count: 999 });
    const limit = kind === 'email' ? 3 : 1;
    for (let i = 0; i < limit; i++) {
      const input = { ...base, requestId: `rate-request-${kind}-${String(i).padStart(5, '0')}` };
      await f.api.createPaymentIntent(input, { rawRequest: {} });
      await f.api.createPaymentIntent(input, { rawRequest: { ip: `spoof-${i}` } });
    }
    await assert.rejects(f.api.createPaymentIntent({ ...base, requestId: `rate-rejected-${kind}-12345` }, { rawRequest: { ip: 'spoofed-new', headers: { 'x-forwarded-for': 'spoofed-new' } } }), e => e.code === 'resource-exhausted');
    assert.equal(f.payments.length, limit);
    const emailBucket = createHash('sha256').update(base.customerEmail).digest('hex').slice(0, 4);
    assert.ok(f.records.has(`commerceRateLimits/v2-email-${emailBucket}`));
    f.setNow('2026-10-22T12:16:00Z');
    await f.api.createPaymentIntent({ ...base, requestId: `rate-after-window-${kind}-123` }, { rawRequest: {} });
  }
});

test('failed special approval suppresses mail and admin resumes frozen payment setup without resubmitting terms', async () => {
  const f = fixture();
  const r = await f.api.createPreorder({ ...base, fulfillmentMethod: 'special_order', paymentMethod: 'special_order', specialNotes: 'Custom negotiated broth please.' }, {});
  const createSession = f.stripe.checkout.sessions.create;
  f.stripe.checkout.sessions.create = async () => { throw Error('provider down'); };
  const terms = { orderId: r.orderId, decision: 'approve', items: [{ productId: 'custom', name: 'Frozen negotiated broth', quantity: 2, price: 4100 }], totalAmount: 8200 };
  await assert.rejects(f.api.reviewSpecialOrder(terms, admin), /unavailable/i);
  await f.api.retryOrderEmail({ orderId: r.orderId }, admin);
  assert.equal(f.mails.length, 0, 'do not send pickup copy or payment demand without session');
  assert.equal(f.records.get(`orders/${r.orderId}`).emailState, 'blocked_payment_setup');
  await assert.rejects(f.api.resumePaymentSetup({ orderId: r.orderId }, {}), /admin|owner/i);
  f.stripe.checkout.sessions.create = createSession;
  const resumed = await f.api.resumePaymentSetup({ orderId: r.orderId, totalAmount: 1, items: [] }, admin);
  assert.match(resumed.checkoutUrl, /^https:\/\/checkout.stripe.com\//);
  assert.equal(f.sessions[0].p.line_items[0].price_data.unit_amount, 4100);
  assert.equal(f.sessions[0].o.idempotencyKey, `approval-${r.orderId}`);
  assert.equal(f.mails.length, 2);
  assert.match(f.mails[0].text, /pay securely/i);
  assert.doesNotMatch(f.mails[0].text, /pickup/i);
  await f.api.resumePaymentSetup({ orderId: r.orderId }, admin);
  assert.equal(f.sessions.length, 1);
});

test('pickup reservations win atomically and late paid events never consume another occurrence', async () => {
  const f = fixture();
  Object.assign(f.records.get('markets/atlantic'), { capacity: 1, reservedCount: 0, occurrenceDate: base.pickupDate });
  const card = await f.api.createPaymentIntent(base, {});
  const pickup = { ...base, paymentMethod: 'pickup', requestId: 'pickup-capacity-request-1' };
  const result = await Promise.allSettled([f.api.createPreorder(pickup, {}), f.api.createPreorder({ ...pickup, requestId: 'pickup-capacity-request-2' }, {})]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  await f.api.processStripeEvent(paidEvent(f, card, 'evt_pickup_won'));
  assert.equal(f.records.get(`orders/${card.orderId}`).status, 'paid_requires_review');
  assert.equal(f.records.get('markets/atlantic').reservedCount, 1);
  const late = fixture();
  Object.assign(late.records.get('markets/atlantic'), { capacity: 1, reservedCount: 0, occurrenceDate: base.pickupDate });
  const r = await late.api.createPaymentIntent(base, {});
  late.setNow('2026-10-26T12:00:00Z');
  Object.assign(late.records.get('markets/atlantic'), { occurrenceDate: '2026-11-01', reservedCount: 0 });
  await late.api.processStripeEvent(paidEvent(late, r, 'evt_late'));
  assert.equal(late.records.get(`orders/${r.orderId}`).status, 'paid_requires_review');
  assert.equal(late.records.get('markets/atlantic').reservedCount, 0);
});

test('rate budgets cap concurrent preorders atomically and do not expose raw identity', async () => {
  const f = fixture();
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => f.api.createPreorder({ ...base, paymentMethod: 'pickup', requestId: `concurrent-preorder-${i}-123` }, {})));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'resource-exhausted').length, 2);
  const budgets = [...f.records].filter(([k]) => k.startsWith('commerceRateLimits/'));
  assert.equal(budgets.length, 2);
  assert.doesNotMatch(JSON.stringify(budgets), /alex@example.com|192\.0\.2\.1/);
});

test('cutoff rejection is occurrence-bound and malformed schedule never falls back to a name', async () => {
  for (const mutate of [
    m => { Object.assign(m, { occurrenceDate: base.pickupDate, orderCutoffAt: '2026-10-22T12:00:00Z' }); },
    m => { Object.assign(m, { occurrenceDate: base.pickupDate, orderCutoffAt: '2026-10-24T12:00:00' }); },
  ]) {
    const f = fixture(); mutate(f.records.get('markets/atlantic'));
    await assert.rejects(f.api.createPaymentIntent(base, {}), /cutoff/i);
  }
  for (const schedule of [
    { name: 'Atlantic (Sundays)' },
    { name: 'Atlantic', timezone: 'America/New_York', day: '0' },
    { name: 'Atlantic', timezone: 'America/New_York', day: 0, weekday: 2 },
    { name: 'Atlantic', timezone: 'America/New_York', pickupDates: ['2026-02-31', base.pickupDate] },
  ]) {
    const f = fixture(); f.records.set('markets/atlantic', schedule);
    await assert.rejects(f.api.createPreorder({ ...base, paymentMethod: 'pickup' }, {}), /schedule|timezone/i);
  }
});

test('customer email is exactly one mailbox; SMTP receives a structured single recipient', async () => {
  for (const customerEmail of ['first@example.com,second@example.com', 'a@example.com;b@example.com', 'Alex <a@example.com>', 'a@b.com\r\nBcc: x@y.com', 'a@@example.com']) {
    const f = fixture();
    await assert.rejects(f.api.createPreorder({ ...base, customerEmail, paymentMethod: 'pickup' }, {}), /email/i);
    assert.equal([...f.records.keys()].filter(k => k.startsWith('orders/')).length, 0);
  }
  const f = fixture();
  const r = await f.api.createPreorder({ ...base, paymentMethod: 'pickup' }, {});
  await f.api.deliverOrderEmail({ orderId: r.orderId });
  assert.deepEqual(f.mails[0].to, { address: 'alex@example.com' });
});
