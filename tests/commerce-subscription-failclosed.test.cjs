const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { fixture, base } = require("./commerce-fixture.cjs");

const delivery = {
  ...base,
  cart: { mushroom: 6 },
  fulfillmentMethod: "local_delivery",
  deliveryAddress: { street: "1 Main St", city: "Jacksonville", state: "FL", zip: "32204" },
};
function configureDelivery(f) {
  f.records.set("settings/delivery", {
    enabled: true, state: "FL", minimumJars: 6, cutoffHours: 48,
    zones: [
      { id: "jacksonville", feeCents: 1000, allowedZips: ["32204", "32205"] },
      { id: "surrounding", feeCents: 1500, allowedZips: ["32233", "32082"] },
    ],
  });
}

test("new one-time delivery fails closed without persistence or provider calls even with valid delivery policy", async () => {
  const f = fixture();
  configureDelivery(f);
  const before = structuredClone([...f.records]);
  await assert.rejects(f.api.createPaymentIntent(delivery), {
    code: "failed-precondition",
    message: "Delivery requires subscription checkout, which is not available yet.",
  });
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 0);
  assert.equal(f.sessions.length, 0);
  assert.equal(f.mails.length, 0);
});

// Seed an actual pre-policy order shape instead of creating a new delivery order
// through the now-disabled endpoint. Its fingerprint is the original normalized input.
function historicalDelivery(f, overrides = {}) {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const input = {
    requestId: delivery.requestId, cart: delivery.cart,
    customerName: delivery.customerName, customerEmail: delivery.customerEmail,
    customerUid: null, fulfillmentMethod: "local_delivery", marketId: null,
    pickupDate: null, specialNotes: "", deliveryAddress: delivery.deliveryAddress,
    paymentMethod: "stripe",
  };
  const fingerprint = hash(JSON.stringify(input, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
      : value));
  const orderId = hash(delivery.requestId);
  f.records.set(`orders/${orderId}`, {
    ...input, fingerprint, orderName: "Historical delivery", status: "awaiting_payment",
    items: [{ productId: "mushroom", name: "Mushroom Broth", quantity: 6, price: 2500, itemTotal: 15000 }],
    subtotal: 15000, discountAmount: 0, deliveryFee: 1000, totalAmount: 16000,
    currency: "usd", deliveryDate: "2026-10-26", paymentBinding: "historical-binding",
    receiptTokenHash: hash(delivery.receiptToken), receiptRevoked: false,
    receiptExpiresAt: Date.parse("2026-11-21T12:00:00Z"),
    createdAt: Date.parse("2026-10-22T12:00:00Z"),
    paymentIntentId: "pi_historical", clientSecret: "historical_secret", ...overrides,
  });
  return orderId;
}

test("new delivery is rejected before pricing and clients cannot claim subscription support", async () => {
  const f = fixture();
  const runTransaction = f.db.runTransaction;
  f.db.runTransaction = (callback) => runTransaction((tx) => callback({
    ...tx,
    get: (ref) => {
      assert.match(ref.path, /^orders\//, "new delivery must not reach pricing or rate limit reads");
      return tx.get(ref);
    },
    set: () => assert.fail("must not schedule persistence"),
    update: () => assert.fail("must not schedule persistence"),
  }));
  for (const claims of [{}, { subscription: true, paymentMethod: "subscription", mode: "subscription", subscriptionId: "sub_forged" }]) {
    await assert.rejects(f.api.createPaymentIntent({ ...delivery, ...claims }), {
      code: "failed-precondition",
      message: "Delivery requires subscription checkout, which is not available yet.",
    });
  }
  assert.equal(f.payments.length, 0);
});

test("historical delivery payment retries return the existing intent without writes or App Check", async () => {
  const f = fixture();
  const orderId = historicalDelivery(f);
  const before = structuredClone([...f.records]);
  const result = await f.api.createPaymentIntent(delivery, { app: null });
  assert.equal(result.orderId, orderId);
  assert.equal(result.clientSecret, "historical_secret");
  assert.equal(result.totalAmount, 16000);
  assert.equal(result.receiptToken, delivery.receiptToken);
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 0);
  const receipt = await f.api.getGuestReceipt({ orderId, token: delivery.receiptToken });
  assert.equal(receipt.fulfillmentMethod, "local_delivery");
  assert.equal(receipt.deliveryFee, 1000);
});

test("historical delivery with interrupted provider setup can recover idempotently", async () => {
  const f = fixture();
  const orderId = historicalDelivery(f, { paymentIntentId: null, clientSecret: null });
  f.setFailPayment(true);
  await assert.rejects(f.api.createPaymentIntent(delivery, { app: null }), { code: "unavailable" });
  f.setFailPayment(false);
  const result = await f.api.createPaymentIntent(delivery, { app: null });
  assert.equal(result.orderId, orderId);
  assert.equal(result.totalAmount, 16000);
  assert.equal(f.payments.length, 2);
  for (const call of f.payments) {
    assert.equal(call.o.idempotencyKey, `order-${orderId}`);
    assert.equal(call.p.amount, 16000);
    assert.equal(call.p.metadata.binding, "historical-binding");
  }
  await f.api.createPaymentIntent(delivery, { app: null });
  assert.equal(f.payments.length, 2);
});

test("historical delivery retries still enforce fingerprint and receipt capability", async () => {
  for (const [change, code] of [
    [{ cart: { mushroom: 7 } }, "failed-precondition"],
    [{ receiptToken: "b".repeat(64) }, "permission-denied"],
  ]) {
    const f = fixture();
    historicalDelivery(f);
    const before = structuredClone([...f.records]);
    await assert.rejects(f.api.createPaymentIntent({ ...delivery, ...change }), { code });
    assert.deepEqual([...f.records], before);
    assert.equal(f.payments.length, 0);
  }
  for (const invalid of [{ receiptRevoked: true }, { receiptExpiresAt: 0 }]) {
    const f = fixture();
    historicalDelivery(f, invalid);
    await assert.rejects(f.api.createPaymentIntent(delivery), { code: "permission-denied" });
    assert.equal(f.payments.length, 0);
  }
});

test("delivery quotes stay available and read-only while checkout fails closed", async () => {
  const f = fixture();
  configureDelivery(f);
  const before = structuredClone([...f.records]);
  const quote = await f.api.getDeliveryQuote({ cart: delivery.cart, address: delivery.deliveryAddress });
  assert.equal(quote.deliveryFee, 1000);
  assert.equal(quote.totalAmount, 16000);
  assert.equal(quote.deliveryDate, "2026-10-26");
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 0);
});

test("market card checkout and special-order approval intake remain available", async () => {
  const f = fixture();
  const market = await f.api.createPaymentIntent(base);
  assert.equal(f.records.get(`orders/${market.orderId}`).fulfillmentMethod, "market_pickup");
  assert.equal(f.payments.length, 1);
  const special = await f.api.createPreorder({
    ...base, requestId: "special-subscription-regression", fulfillmentMethod: "special_order",
    paymentMethod: "special_order", specialNotes: "Please arrange a custom batch.",
  });
  assert.equal(f.records.get(`orders/${special.orderId}`).status, "awaiting_approval");
  assert.equal(f.payments.length, 1);
  assert.equal(f.sessions.length, 0);
});
