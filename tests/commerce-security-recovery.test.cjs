const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { fixture, base } = require('./commerce-fixture.cjs');

test('new guest creation rejects spoofed forwarding, App Check headers and body context without verified app', async () => {
  for (const method of ['createPreorder', 'createPaymentIntent']) {
    const f = fixture();
    await assert.rejects(f.api[method]({ ...base, receiptToken: randomBytes(32).toString('hex'), paymentMethod: 'pickup', app: { appId: 'forged' } }, {
      app: undefined,
      rawRequest: { ip: 'attacker-controlled', headers: { 'x-forwarded-for': '192.0.2.22', 'x-firebase-appcheck': 'forged' } },
    }), e => e.code === 'unauthenticated');
    assert.equal([...f.records.keys()].filter(k => k.startsWith('orders/')).length, 0);
    assert.equal(f.payments.length, 0);
  }
});

test('provider failure then unchanged capability-proven retry recovers the same usable receipt without leaking a stored secret', async () => {
  const f = fixture();
  const receiptToken = randomBytes(32).toString('hex');
  const input = { ...base, receiptToken };
  f.setFailPayment(true);
  await assert.rejects(f.api.createPaymentIntent(input), e => e.code === 'unavailable');
  assert.ok(!JSON.stringify([...f.records]).includes(receiptToken));
  f.setFailPayment(false);
  const result = await f.api.createPaymentIntent(input);
  assert.ok(result.receiptToken === receiptToken, 'retry echoes only the supplied capability');
  assert.equal((await f.api.getGuestReceipt({ orderId: result.orderId, token: receiptToken })).status, 'awaiting_payment');
  assert.ok((await f.api.createPaymentIntent(input)).receiptToken === receiptToken, 'committed replay proves the same capability');
  assert.equal(f.payments.length, 2);
  assert.equal(f.payments[0].o.idempotencyKey, f.payments[1].o.idempotencyKey);
});

test('creation entrypoints mandate SDK App Check even for authenticated requests; other operations remain unchanged', async () => {
  const { load } = require('./commerce-vm-fixture.cjs');
  const f = load(false);
  for (const name of ['createPreorder', 'createPaymentIntent']) {
    assert.equal(f.handlers[name].options.enforceAppCheck, true);
  }
  for (const name of ['getGuestReceipt', 'getDeliveryQuote', 'reviewSpecialOrder', 'resumePaymentSetup', 'retryOrderEmail']) {
    assert.notEqual(f.handlers[name].options.enforceAppCheck, true);
  }
  await assert.rejects(f.api.createPreorder({ ...base, paymentMethod: 'pickup' }, { app: undefined, auth: { uid: 'real-user' } }), e => e.code === 'unauthenticated');
});

test('actual v1 HTTP callable SDK rejects missing/forged App Check despite trust-proxy and forged context', async t => {
  const express = require('../firebase/functions/node_modules/express');
  const adminSdk = require('../firebase/functions/node_modules/firebase-admin');
  const localRequire = require('node:module').createRequire(require('node:path').resolve(__dirname, '../firebase/functions/index.js'));
  const sdkLogger = localRequire('firebase-functions/logger');
  // Expected SDK verification warnings are asserted through HTTP outcomes, not printed.
  t.mock.method(sdkLogger, 'warn', () => {});
  t.mock.method(sdkLogger, 'debug', () => {});
  if (!adminSdk.apps.length) adminSdk.initializeApp({ projectId: 'local-security-test' });
  const f = require('./commerce-vm-fixture.cjs').load(true, { realCallableRuntime: true });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/preorder', f.handlers.createPreorder);
  app.post('/payment', f.handlers.createPaymentIntent);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (const route of ['preorder', 'payment']) {
    for (const token of [null, 'forged-not-a-jwt']) {
      const headers = { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.123, 203.0.113.3' };
      if (token) headers['x-firebase-appcheck'] = token;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/${route}`, {
        method: 'POST', headers,
        body: JSON.stringify({ data: { ...base, paymentMethod: 'pickup', app: { appId: 'forged' }, context: { app: { appId: 'forged' } } } }),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.status, 'UNAUTHENTICATED');
    }
  }
  assert.equal([...f.records.keys()].filter(k => k.startsWith('orders/')).length, 0);
  assert.equal(f.payments.length, 0);
});

test('existing order replay requires capability plus unchanged payload and authenticated owner binding', async () => {
  for (const method of ['createPaymentIntent', 'createPreorder']) {
    const f = fixture();
    const input = { ...base, paymentMethod: 'pickup' };
    const ctx = { auth: { uid: 'buyer', token: {} } };
    const result = await f.api[method](input, ctx);
    for (const receiptToken of [undefined, '', 'b'.repeat(64)]) {
      await assert.rejects(f.api[method]({ ...input, receiptToken }, ctx), e => ['invalid-argument', 'permission-denied'].includes(e.code));
    }
    await assert.rejects(f.api[method]({ ...input, cart: { mushroom: 2 } }, ctx), e => e.code === 'failed-precondition');
    await assert.rejects(f.api[method](input, { auth: { uid: 'other-buyer' } }), e => e.code === 'failed-precondition');
    await assert.rejects(f.api[method](input, { auth: undefined }), e => e.code === 'failed-precondition');
    assert.equal((await f.api[method](input, ctx)).orderId, result.orderId);
    assert.equal([...f.records.keys()].filter(k => k.startsWith('orders/')).length, 1);
  }
});

test('legacy capability receipt reads still work but legacy creations never reissue or replace a capability', async () => {
  const f = fixture();
  const result = await f.api.createPaymentIntent(base);
  const order = f.records.get(`orders/${result.orderId}`);
  const token = 'z'.repeat(43); // old server-generated base64url fixture, not a credential
  order.receiptTokenHash = require('node:crypto').createHash('sha256').update(token).digest('hex');
  assert.equal((await f.api.getGuestReceipt({ orderId: result.orderId, token })).status, 'awaiting_payment');
  await assert.rejects(f.api.createPaymentIntent(base), e => e.code === 'permission-denied');
  delete order.receiptTokenHash;
  await assert.rejects(f.api.createPaymentIntent(base), e => e.code === 'permission-denied');
  assert.equal(f.payments.length, 1);
});

test('receipt and creation replay fail closed for revoked, expired or incomplete historical capability metadata', async () => {
  for (const change of [o => { o.receiptRevoked = true; }, o => { o.receiptExpiresAt = 0; }, o => { delete o.receiptExpiresAt; }, o => { o.receiptTokenHash = 'malformed'; }]) {
    const f = fixture();
    const result = await f.api.createPaymentIntent(base);
    change(f.records.get(`orders/${result.orderId}`));
    await assert.rejects(f.api.getGuestReceipt({ orderId: result.orderId, token: base.receiptToken }), e => e.code === 'permission-denied');
    await assert.rejects(f.api.createPaymentIntent(base), e => e.code === 'permission-denied');
  }
});
