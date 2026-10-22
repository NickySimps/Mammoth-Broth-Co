const { test } = require("node:test");
const assert = require("node:assert/strict");
const { base, admin } = require("./commerce-fixture.cjs");
const { load } = require("./commerce-vm-fixture.cjs");
const create = f => f.handlers.createPreorder({ ...base, paymentMethod: "pickup" });
const deliver = (f, orderId) => f.handlers.sendOrderConfirmationEmail({}, { params: { orderId } });

test("real entrypoint checkpoints customer before operations failure and admin retries operations only", async () => {
  const attempts = [];
  let failOps = true;
  const f = load(true, { sendMail: async message => {
    attempts.push(message);
    if (message.to === "ops@example.com" && failOps) throw Error("operations SMTP unavailable");
  } });
  const { orderId } = await create(f);
  await assert.rejects(deliver(f, orderId), e => e.code === "unavailable");
  const order = f.records.get(`orders/${orderId}`);
  assert.equal(order.emailCustomerSentVersion, 1);
  assert.equal(order.emailOperationsSentVersion, 0);
  assert.equal(order.emailSentVersion, 0);
  assert.equal(order.emailState, "pending");
  assert.equal(order.emailLeaseUntil, 0);
  failOps = false;
  await f.handlers.retryOrderEmail({ orderId }, admin);
  assert.equal(attempts.filter(m => m.to.address === "alex@example.com").length, 1);
  assert.equal(attempts.filter(m => m.to === "ops@example.com").length, 2);
  const sent = f.records.get(`orders/${orderId}`);
  assert.equal(sent.emailCustomerSentVersion, 1);
  assert.equal(sent.emailOperationsSentVersion, 1);
  assert.equal(sent.emailSentVersion, 1);
  assert.equal(sent.emailState, "sent");
  await f.handlers.retryOrderEmail({ orderId }, admin);
  assert.equal(attempts.length, 3);
  for (const message of attempts) {
    assert.equal(message.cc, undefined);
    assert.equal(message.bcc, undefined);
    assert.equal(message.recipient, undefined, "internal recipient selector must not leak into SMTP options");
  }
  assert.match(attempts[1].subject, /operations/);
});

test("customer rejection never attempts operations; admin retry sends each outstanding recipient", async () => {
  const attempts = [];
  let reject = true;
  const f = load(true, { sendMail: async message => {
    attempts.push(message);
    if (reject) throw Error("SMTP rejected customer");
  } });
  const { orderId } = await create(f);
  await assert.rejects(deliver(f, orderId), e => e.code === "unavailable");
  assert.equal(attempts.length, 1);
  assert.equal(f.records.get(`orders/${orderId}`).emailCustomerSentVersion, 0);
  reject = false;
  await assert.rejects(f.handlers.retryOrderEmail({ orderId }, {}), e => e.code === "permission-denied");
  await f.handlers.retryOrderEmail({ orderId }, admin);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[2].to, "ops@example.com");
});

test("live lease excludes concurrent trigger/admin delivery while SMTP is in flight", async () => {
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const mails = [];
  const f = load(true, { sendMail: async message => {
    mails.push(message);
    if (message.to.address) { started(); await blocked; }
  } });
  const { orderId } = await create(f);
  const first = deliver(f, orderId);
  await entered;
  await assert.rejects(f.handlers.retryOrderEmail({ orderId }, admin), e => e.code === "unavailable");
  assert.equal(mails.length, 1);
  release();
  await first;
  await f.handlers.retryOrderEmail({ orderId }, admin);
  assert.equal(mails.length, 2);
  assert.equal(f.records.get(`orders/${orderId}`).emailAttempts, 1);
});

test("a newer email version during SMTP remains pending and sends fresh messages to both recipients", async () => {
  const mails = [];
  let f, orderId;
  f = load(true, { sendMail: async message => {
    mails.push(message);
    if (mails.length === 1) {
      const order = f.records.get(`orders/${orderId}`);
      order.emailVersion = 2;
      order.status = "paid";
    }
  } });
  ({ orderId } = await create(f));
  await deliver(f, orderId);
  const first = f.records.get(`orders/${orderId}`);
  assert.equal(first.emailSentVersion, 1);
  assert.equal(first.emailCustomerSentVersion, 1);
  assert.equal(first.emailOperationsSentVersion, 1);
  assert.equal(first.emailState, "pending");
  await f.handlers.sendOrderEmailOnUpdate({
    before: { data: () => ({ emailVersion: 1 }) },
    after: { data: () => ({ emailVersion: 2 }) },
  }, { params: { orderId } });
  assert.equal(mails.length, 4);
  assert.match(mails[2].text, /payment received/i);
  assert.match(mails[3].text, /payment received/i);
  const sent = f.records.get(`orders/${orderId}`);
  assert.equal(sent.emailSentVersion, 2);
  assert.equal(sent.emailCustomerSentVersion, 2);
  assert.equal(sent.emailOperationsSentVersion, 2);
  assert.equal(sent.emailState, "sent");
});

test("legacy aggregate sent versions migrate lazily without replaying an already delivered version", async () => {
  const f = load();
  const { orderId } = await create(f);
  const legacy = f.records.get(`orders/${orderId}`);
  delete legacy.emailCustomerSentVersion;
  delete legacy.emailOperationsSentVersion;
  legacy.emailSentVersion = 1;
  legacy.emailState = "sent";
  await f.handlers.retryOrderEmail({ orderId }, admin);
  assert.equal(f.mails.length, 0);
  legacy.emailVersion = 2;
  legacy.emailState = "pending";
  await f.handlers.retryOrderEmail({ orderId }, admin);
  const migrated = f.records.get(`orders/${orderId}`);
  assert.equal(f.mails.length, 2);
  assert.equal(migrated.emailCustomerSentVersion, 2);
  assert.equal(migrated.emailOperationsSentVersion, 2);
  assert.equal(migrated.emailSentVersion, 2);
});

test("independent checkpoints allow customer-only recovery when operations is already delivered", async () => {
  const f = load();
  const { orderId } = await create(f);
  f.records.get(`orders/${orderId}`).emailOperationsSentVersion = 1;
  await f.handlers.retryOrderEmail({ orderId }, admin);
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0].to.address, "alex@example.com");
  assert.equal(f.records.get(`orders/${orderId}`).emailState, "sent");
});

test("expired worker cannot checkpoint SMTP acceptance or continue operations under a replacement lease", async () => {
  let clock = Date.parse("2026-10-22T12:00:00Z");
  let f, orderId;
  const mails = [];
  f = load(true, { now: () => clock, sendMail: async message => {
    mails.push(message);
    clock += 120001;
    const order = f.records.get(`orders/${orderId}`);
    order.emailLease = "replacement-worker";
    order.emailLeaseUntil = clock + 120000;
    order.emailState = "sending";
  } });
  ({ orderId } = await create(f));
  await assert.rejects(deliver(f, orderId), e => e.code === "unavailable");
  const order = f.records.get(`orders/${orderId}`);
  assert.equal(mails.length, 1, "stale worker must not attempt operations");
  assert.equal(order.emailCustomerSentVersion, 0, "acceptance without checkpoint remains ambiguous");
  assert.equal(order.emailLease, "replacement-worker");
  assert.equal(order.emailState, "sending");
  await assert.rejects(f.handlers.retryOrderEmail({ orderId }, admin), e => e.code === "unavailable");
});

test("retry after aggregate bookkeeping failure uses both durable checkpoints without SMTP replay", async () => {
  const f = load();
  const { orderId } = await create(f);
  const run = f.db.runTransaction;
  let fail = true;
  f.db.runTransaction = cb => run(tx => cb({ ...tx, update: (ref, value) => {
    if (fail && value.emailSentVersion === 1) {
      fail = false;
      throw Error("aggregate write interrupted");
    }
    tx.update(ref, value);
  } }));
  await assert.rejects(deliver(f, orderId), e => e.code === "unavailable");
  assert.equal(f.records.get(`orders/${orderId}`).emailState, "pending");
  assert.equal(f.mails.length, 2);
  await f.handlers.retryOrderEmail({ orderId }, admin);
  assert.equal(f.mails.length, 2);
  assert.equal(f.records.get(`orders/${orderId}`).emailState, "sent");
});
