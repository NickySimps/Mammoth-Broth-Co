const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./commerce-vm-fixture.cjs");
const { base } = require("./commerce-fixture.cjs");
const pickup = { ...base, paymentMethod: "pickup" };
test("resumePaymentSetup callable enforces admin and binds payment and mail secrets", async () => {
  const f = load();
  assert.equal(typeof f.handlers.resumePaymentSetup, "function");
  await assert.rejects(f.handlers.resumePaymentSetup({ orderId: 'a'.repeat(64) }, {}), /admin|owner/i);
  assert.deepEqual([...f.handlers.resumePaymentSetup.options.secrets], ["STRIPE_SECRET", "GMAIL_PASS"]);
  const { admin } = require('./commerce-fixture.cjs');
  const r = await f.handlers.createPreorder({ ...base, paymentMethod: 'special_order', fulfillmentMethod: 'special_order', specialNotes: 'A custom negotiated order.' }, {});
  const createSession = f.stripe.checkout.sessions.create;
  f.stripe.checkout.sessions.create = async () => { throw Error('outage'); };
  await assert.rejects(f.handlers.reviewSpecialOrder({ orderId: r.orderId, decision: 'approve', items: [{ productId: 'custom', name: 'Custom', quantity: 1, price: 5000 }], totalAmount: 5000 }, admin), /unavailable/i);
  f.stripe.checkout.sessions.create = createSession;
  const result = await f.handlers.resumePaymentSetup({ orderId: r.orderId }, admin);
  assert.match(result.checkoutUrl, /checkout.stripe.com/);
});
// Real exported v1 handlers in VM; Firestore/Stripe/SMTP boundaries only are mocked.
// Migrates legacy config/amount-only mocks without dropping previous regressions.
test("callables reject mismatched receiving/payment methods and invalid quantities", async () => {
  const f = load();
  for (const request of [
    { ...pickup, fulfillmentMethod: "teleport" },
    {
      ...pickup,
      fulfillmentMethod: "local_delivery",
      cart: { mushroom: 5 },
      deliveryAddress: {
        street: "1 Main",
        city: "Jacksonville",
        state: "FL",
        zip: "32202",
      },
    },
    { ...pickup, paymentMethod: "special_order" },
  ])
    await assert.rejects(f.handlers.createPreorder(request, {}));
  await assert.rejects(
    f.handlers.createPaymentIntent(
      { ...base, cart: { mushroom: 3, other: -1 } },
      {},
    ),
    /quantit|whole/i,
  );
  f.records.get("products/mushroom").available = false;
  await assert.rejects(f.handlers.createPaymentIntent(base, {}), /available/i);
});
test("PaymentIntent uses configured promotions rather than a separate bundle formula", async () => {
  const f = load();
  await f.handlers.createPaymentIntent({ ...base, cart: { mushroom: 4 } }, {});
  assert.equal(f.payments[0].p.amount, 10000);
});
test("PaymentIntent supports canonical priceCents even without legacy price", async () => {
  const f = load();
  f.records.set("products/mushroom", {
    name: "Mushroom Broth",
    priceCents: 2500,
  });
  await f.handlers.createPaymentIntent(base, {});
  assert.equal(f.payments[0].p.amount, 2500);
});
test("preorder reads the latest market inside its atomic reservation transaction", async () => {
  const f = load();
  const run = f.db.runTransaction;
  f.db.runTransaction = (callback) => {
    f.records.get("markets/atlantic").active = false;
    return run(callback);
  };
  await assert.rejects(
    f.handlers.createPreorder(pickup, {}),
    /market|accepting/i,
  );
  assert.equal(
    [...f.records.keys()].filter((p) => p.startsWith("orders/")).length,
    0,
  );
});
test("concurrent preorder retries create one durable order with authoritative items and pending status", async () => {
  const f = load();
  const results = await Promise.all([
    f.handlers.createPreorder(pickup, {}),
    f.handlers.createPreorder(pickup, {}),
  ]);
  assert.equal(results[0].orderId, results[1].orderId);
  assert.equal(
    [...f.records.keys()].filter((p) => p.startsWith("orders/")).length,
    1,
  );
  const o = f.records.get(`orders/${results[0].orderId}`);
  assert.equal(o.totalAmount, 2500);
  assert.equal(o.items[0].productId, "mushroom");
  assert.equal(o.status, "pending");
});
test("environment-only mail config sends customer and operations confirmation without promising reservation", async () => {
  const f = load();
  const r = await f.handlers.createPreorder(
    {
      ...pickup,
      fulfillmentMethod: "special_order",
      paymentMethod: "special_order",
      specialNotes: "Please prepare a custom batch.",
    },
    {},
  );
  await f.handlers.sendOrderConfirmationEmail(
    { data: () => f.records.get(`orders/${r.orderId}`) },
    { params: { orderId: r.orderId } },
  );
  assert.equal(f.mails.length, 2);
  assert.equal(f.mails[0].to.address, "alex@example.com");
  assert.equal(f.mails[1].to, "ops@example.com");
  assert.doesNotMatch(f.mails[0].subject, /reserved/i);
  assert.match(f.mails[0].text, /approval/i);
  await f.handlers.sendOrderConfirmationEmail(
    {},
    { params: { orderId: r.orderId } },
  );
  assert.equal(f.mails.length, 2);
});
