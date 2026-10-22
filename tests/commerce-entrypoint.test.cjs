const { test } = require("node:test");
const assert = require("node:assert/strict");
const { base } = require("./commerce-fixture.cjs");
const { load } = require("./commerce-vm-fixture.cjs");
const response = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  send(body) {
    this.body = body;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});
test("v1 entrypoint verifies actual Stripe signature over raw bytes before durable confirmation", async () => {
  const f = load();
  const r = await f.handlers.createPaymentIntent(base, {}),
    o = f.records.get(`orders/${r.orderId}`);
  const payload = Buffer.from(
    JSON.stringify({
      id: "evt_signed",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: o.paymentIntentId,
          status: "succeeded",
          amount: 2500,
          amount_received: 2500,
          currency: "usd",
          metadata: { orderId: r.orderId, binding: o.paymentBinding },
        },
      },
    }),
  );
  const signature = f.signing.webhooks.generateTestHeaderString({
    payload: payload.toString(),
    secret: "whsec_mock",
  });
  const rejected = response();
  await f.handlers.stripeWebhook(
    {
      method: "POST",
      rawBody: Buffer.from("{}"),
      headers: { "stripe-signature": signature },
    },
    rejected,
  );
  assert.equal(rejected.statusCode, 400);
  assert.equal(f.records.get(`orders/${r.orderId}`).status, "awaiting_payment");
  const ok = response();
  await f.handlers.stripeWebhook(
    {
      method: "POST",
      rawBody: payload,
      body: { malicious: "not the raw payload" },
      headers: { "stripe-signature": signature },
    },
    ok,
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(f.records.get(`orders/${r.orderId}`).status, "paid");
  assert.equal(f.constructCalls(), 2);
  assert.deepEqual(
    [...f.handlers.createPaymentIntent.options.secrets],
    ["STRIPE_SECRET"],
  );
  assert.deepEqual(
    [...f.handlers.stripeWebhook.options.secrets],
    ["STRIPE_SECRET", "STRIPE_WEBHOOK_SECRET"],
  );
});
test("missing payment and mail configuration disables only those boundaries; pickup still works", async () => {
  const f = load(false);
  await assert.rejects(
    f.handlers.createPaymentIntent(base, {}),
    /configured|disabled/i,
  );
  assert.deepEqual([...f.handlers.createPreorder.options.secrets], []);
  assert.deepEqual([...f.handlers.createPaymentIntent.options.secrets], []);
  const r = await f.handlers.createPreorder(
    { ...base, paymentMethod: "pickup" },
    {},
  );
  assert.equal(f.records.get(`orders/${r.orderId}`).status, "pending");
  assert.equal(
    r.emailState,
    "pending",
    "saving an order must not claim email delivery",
  );
  await f.handlers.sendOrderConfirmationEmail(
    {},
    { params: { orderId: r.orderId } },
  );
  assert.equal(f.mails.length, 0);
  assert.equal(f.records.get(`orders/${r.orderId}`).emailState, "pending");
});
