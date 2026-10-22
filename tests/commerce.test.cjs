const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture, base, admin } = require("./commerce-fixture.cjs");
test("payment setup persists authoritative pending order and immutable idempotent binding", async () => {
  const f = fixture();
  const result = await f.api.createPaymentIntent(
    { ...base, totalAmount: 1, status: "paid" },
    {},
  );
  const order = f.records.get(`orders/${result.orderId}`);
  assert.equal(order.status, "awaiting_payment");
  assert.equal(order.totalAmount, 2500);
  assert.equal(order.paymentIntentId, "pi_1");
  assert.equal(f.payments[0].p.metadata.orderId, result.orderId);
  assert.equal(f.payments[0].p.metadata.binding, order.paymentBinding);
  assert.match(result.receiptToken, /^[a-f0-9]{64}$/);
  assert.equal(
    order.receiptTokenHash,
    crypto.createHash("sha256").update(result.receiptToken).digest("hex"),
  );
  assert.ok(!JSON.stringify([...f.records]).includes(result.receiptToken));
  const again = await f.api.createPaymentIntent(base, {});
  assert.equal(again.orderId, result.orderId);
  assert.equal(again.receiptToken, base.receiptToken);
  assert.equal(f.payments.length, 1);
  await assert.rejects(
    f.api.createPaymentIntent({ ...base, cart: { mushroom: 2 } }, {}),
    /conflict/i,
  );
});
test("only validated webhook confirms payment once; mismatches and replay cannot bind another order", async () => {
  const f = fixture();
  const r = await f.api.createPaymentIntent(base, {});
  const o = f.records.get(`orders/${r.orderId}`);
  const event = {
    id: "evt_1",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: o.paymentIntentId,
        status: "succeeded",
        amount: o.totalAmount,
        amount_received: o.totalAmount,
        currency: "usd",
        metadata: { orderId: r.orderId, binding: o.paymentBinding },
      },
    },
  };
  await assert.rejects(
    f.api.processStripeEvent({
      ...event,
      data: { object: { ...event.data.object, amount_received: 1 } },
    }),
    /mismatch/i,
  );
  assert.equal(f.records.get(`orders/${r.orderId}`).status, "awaiting_payment");
  assert.ok(!f.records.has("stripeEvents/evt_1"));
  const results = await Promise.all([
    f.api.processStripeEvent(event),
    f.api.processStripeEvent(event),
  ]);
  assert.equal(results.filter((r) => r.duplicate).length, 1);
  assert.equal(f.records.get(`orders/${r.orderId}`).status, "paid");
  await assert.rejects(
    f.api.processStripeEvent({
      ...event,
      data: { object: { ...event.data.object, currency: "eur" } },
    }),
    /replay|conflict/i,
  );
  await assert.rejects(
    f.api.processStripeEvent({
      ...event,
      id: "evt_2",
      data: {
        object: {
          ...event.data.object,
          metadata: { ...event.data.object.metadata, binding: "forged" },
        },
      },
    }),
    /mismatch/i,
  );
  const other = await f.api.createPaymentIntent(
    { ...base, requestId: "another-request-12345" },
    {},
  );
  const otherOrder = f.records.get(`orders/${other.orderId}`);
  await assert.rejects(
    f.api.processStripeEvent({
      ...event,
      id: "evt_3",
      data: {
        object: {
          ...event.data.object,
          metadata: {
            orderId: other.orderId,
            binding: otherOrder.paymentBinding,
          },
        },
      },
    }),
    /mismatch|conflict/i,
  );
});
test("pickup and special preorders never confirm client payment and issue safe revocable receipts", async () => {
  const f = fixture();
  await assert.rejects(
    f.api.createPreorder(
      { ...base, paymentMethod: "stripe", paymentIntentId: "pi_forged" },
      {},
    ),
    /payment|pickup/i,
  );
  const r = await f.api.createPreorder(
    { ...base, paymentMethod: "pickup" },
    {},
  );
  const receipt = await f.api.getGuestReceipt({
    orderId: r.orderId,
    token: r.receiptToken,
  });
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.totalAmount, 2500);
  assert.equal(f.payments.length, 0);
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "orderId",
      "orderName",
      "status",
      "paymentMethod",
      "fulfillmentMethod",
      "items",
      "subtotal",
      "discountAmount",
      "deliveryFee",
      "totalAmount",
      "currency",
      "marketName",
      "pickupDate",
      "deliveryDate",
      "checkoutUrl",
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(receipt.items[0]).sort(),
    ["productId", "name", "quantity", "price", "itemTotal"].sort(),
  );
  await assert.rejects(
    f.api.getGuestReceipt({ orderId: r.orderId, token: "wrong" }),
    /receipt/i,
  );
  await assert.rejects(
    f.api.revokeGuestReceipt({ orderId: r.orderId }, {}),
    /admin|owner/i,
  );
  await f.api.revokeGuestReceipt({ orderId: r.orderId }, admin);
  await assert.rejects(
    f.api.getGuestReceipt({ orderId: r.orderId, token: r.receiptToken }),
    /receipt/i,
  );
  const special = await f.api.createPreorder(
    {
      ...base,
      requestId: "special-request-123456",
      fulfillmentMethod: "special_order",
      paymentMethod: "special_order",
      specialNotes: "Please make a special broth.",
    },
    {},
  );
  assert.equal(
    f.records.get(`orders/${special.orderId}`).status,
    "awaiting_approval",
  );
  f.records.get(`orders/${special.orderId}`).receiptExpiresAt = 0;
  await assert.rejects(
    f.api.getGuestReceipt({
      orderId: special.orderId,
      token: special.receiptToken,
    }),
    /receipt/i,
  );
});
test("owner approval freezes negotiated terms, creates only one hosted checkout, and retries failed delivery", async () => {
  const f = fixture();
  const r = await f.api.createPreorder(
    {
      ...base,
      fulfillmentMethod: "special_order",
      paymentMethod: "special_order",
      specialNotes: "Requested special soup.",
    },
    {},
  );
  assert.equal(f.sessions.length, 0);
  const terms = {
    orderId: r.orderId,
    decision: "approve",
    items: [
      { productId: "custom", name: "Custom Broth", quantity: 2, price: 4000 },
    ],
    totalAmount: 8000,
  };
  await assert.rejects(f.api.reviewSpecialOrder(terms, {}), /admin|owner/i);
  f.setFailMail(true);
  const approval = await f.api.reviewSpecialOrder(terms, admin);
  assert.equal(approval.status, "awaiting_payment");
  assert.equal(
    approval.checkoutUrl,
    "https://checkout.stripe.com/c/pay_fixture",
  );
  const o = f.records.get(`orders/${r.orderId}`);
  assert.equal(o.totalAmount, 8000);
  assert.equal(o.emailState, "pending");
  assert.equal(f.sessions.length, 1);
  assert.equal(f.sessions[0].p.line_items[0].price_data.unit_amount, 4000);
  assert.equal(
    f.sessions[0].p.payment_intent_data.metadata.binding,
    o.paymentBinding,
  );
  assert.equal(
    new URL(f.sessions[0].p.success_url).origin,
    "https://mammoth.example",
  );
  assert.ok(!f.sessions[0].p.success_url.includes("token="));
  await f.api.reviewSpecialOrder(terms, admin);
  assert.equal(f.sessions.length, 1);
  await assert.rejects(
    f.api.reviewSpecialOrder({ ...terms, totalAmount: 8002 }, admin),
    /total|conflict/i,
  );
  await assert.rejects(
    f.api.reviewSpecialOrder(
      { orderId: r.orderId, decision: "decline" },
      admin,
    ),
    /conflict/i,
  );
  f.setFailMail(false);
  await f.api.retryOrderEmail({ orderId: r.orderId }, admin);
  assert.equal(f.mails.length, 2);
  assert.match(f.mails[0].text, /https:\/\/checkout.stripe.com/);
  assert.equal(f.records.get(`orders/${r.orderId}`).emailState, "sent");
  await f.api.retryOrderEmail({ orderId: r.orderId }, admin);
  assert.equal(f.mails.length, 2);
});
test("delivery fails closed and computes configured fee, geography, cutoff and Monday on server", async () => {
  const f = fixture();
  const address = {
    street: "1 Main St",
    city: "Jacksonville",
    state: "FL",
    zip: "32202",
  };
  const quoteInput = { cart: { mushroom: 5 }, address };
  await assert.rejects(
    f.api.getDeliveryQuote(quoteInput),
    /configured|delivery/i,
  );
  f.records.set("settings/delivery", {
    enabled: true,
    allowedZips: ["32202"],
    state: "FL",
    feeCents: 500,
    minimumJars: 5,
    cutoffHours: 48,
  });
  const q = await f.api.getDeliveryQuote(quoteInput);
  assert.equal(q.totalAmount, 13000);
  assert.equal(q.deliveryFee, 500);
  assert.equal(q.deliveryDate, "2026-10-26");
  await assert.rejects(
    f.api.getDeliveryQuote({
      ...quoteInput,
      address: { ...address, zip: "99999" },
    }),
    /area|geograph/i,
  );
  await assert.rejects(
    f.api.getDeliveryQuote({ ...quoteInput, cart: { mushroom: 4 } }),
    /minimum/i,
  );
  const r = await f.api.createPaymentIntent(
    {
      ...base,
      cart: { mushroom: 5 },
      fulfillmentMethod: "local_delivery",
      deliveryAddress: address,
      deliveryFee: 0,
      deliveryDate: "2001-01-01",
    },
    {},
  );
  assert.equal(f.payments[0].p.amount, 13000);
  assert.equal(f.records.get(`orders/${r.orderId}`).deliveryDate, "2026-10-26");
  f.records.get("settings/delivery").cutoffHours = 120;
  assert.equal(
    (await f.api.getDeliveryQuote(quoteInput)).deliveryDate,
    "2026-11-02",
  );
  delete f.records.get("settings/delivery").feeCents;
  await assert.rejects(
    f.api.getDeliveryQuote(quoteInput),
    /configured|policy/i,
  );
});
test("paid webhook queues one durable payment confirmation instead of another payment demand", async () => {
  const f = fixture();
  const r = await f.api.createPaymentIntent(base, {});
  const o = f.records.get(`orders/${r.orderId}`);
  const event = {
    id: "evt_email",
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
  };
  await f.api.processStripeEvent(event);
  assert.equal(f.records.get(`orders/${r.orderId}`).emailState, "pending");
  await f.api.deliverOrderEmail({ orderId: r.orderId });
  assert.equal(f.mails.length, 2);
  assert.match(f.mails[0].text, /payment received/i);
  await f.api.processStripeEvent({ ...event, id: "evt_email_second" });
  await f.api.deliverOrderEmail({ orderId: r.orderId });
  assert.equal(f.mails.length, 2);
});
test("malformed payloads and impossible pickup dates reject before persistence", async () => {
  const f = fixture();
  for (const payload of [
    null,
    [],
    { ...base, pickupDate: "2099-02-31" },
    { ...base, cart: { mushroom: 1.5 } },
    { ...base, cart: { mushroom: 13 } },
    { ...base, requestId: "short" },
  ]) {
    await assert.rejects(
      f.api.createPaymentIntent(payload, {}),
      (error) => error.code === "invalid-argument",
    );
  }
  assert.equal(f.payments.length, 0);
  assert.equal(
    [...f.records.keys()].filter((k) => k.startsWith("orders/")).length,
    0,
  );
});
test("parallel unpaid retries consume no market slot and create one provider object", async () => {
  const f = fixture();
  f.records.set("markets/atlantic", {
    name: "Atlantic",
    active: true,
    capacity: 10,
    day: 0,
    timezone: "America/New_York",
    occurrenceDate: base.pickupDate,
    reservedCount: 0,
  });
  const results = await Promise.allSettled([
    f.api.createPaymentIntent(base, {}),
    f.api.createPaymentIntent(base, {}),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.payments.length, 1);
  assert.equal(f.records.get("markets/atlantic").reservedCount, 0);
  assert.equal(
    [...f.records.keys()].filter((k) => k.startsWith("orders/")).length,
    1,
  );
  const retry = await f.api.createPaymentIntent(base, {});
  assert.equal(retry.clientSecret, "secret_fixture");
  assert.equal(f.payments.length, 1);
});
test("provider failures leave retryable pending orders and refuse creation beyond Stripe idempotency window", async () => {
  const f = fixture();
  f.setFailPayment(true);
  await assert.rejects(f.api.createPaymentIntent(base, {}), /unavailable/i);
  assert.equal(
    [...f.records].find(([k]) => k.startsWith("orders/"))[1].status,
    "awaiting_payment",
  );
  const key = f.payments[0].o.idempotencyKey;
  f.setFailPayment(false);
  await f.api.createPaymentIntent(base, {});
  assert.equal(f.payments[1].o.idempotencyKey, key);
  const expired = fixture();
  expired.setFailPayment(true);
  await assert.rejects(expired.api.createPaymentIntent(base, {}));
  expired.setFailPayment(false);
  expired.setNow("2026-10-23T12:00:00Z");
  await assert.rejects(
    expired.api.createPaymentIntent(base, {}),
    /expired|reconcil/i,
  );
  assert.equal(expired.payments.length, 1);
});
test("catalog availability, configured promotion, and market limits remain authoritative", async () => {
  for (const mutation of [
    (f) => {
      f.records.get("products/mushroom").available = false;
    },
    (f) => {
      f.records.get("products/mushroom").priceCents = 0;
    },
    (f) => {
      f.records.get("markets/atlantic").active = false;
    },
    (f) => {
      Object.assign(f.records.get("markets/atlantic"), {
        occurrenceDate: base.pickupDate,
        orderCutoffAt: "2026-10-20T00:00:00Z",
      });
    },
    (f) => {
      Object.assign(f.records.get("markets/atlantic"), {
        capacity: 1,
        occurrenceDate: base.pickupDate,
        reservedCount: 1,
      });
    },
  ]) {
    const f = fixture();
    mutation(f);
    await assert.rejects(f.api.createPaymentIntent(base, {}));
    assert.equal(f.payments.length, 0);
  }
  const f = fixture();
  f.records.set("settings/promotions", {
    brothBundleEnabled: true,
    bundleMinimum: 4,
    bundlePriceCents: 2000,
  });
  await f.api.createPaymentIntent({ ...base, cart: { mushroom: 4 } }, {});
  assert.equal(f.payments[0].p.amount, 8000);
});
test("special checkout requires explicit HTTPS origin, rejects unapproved transitions and verifies hosted payment", async () => {
  const input = {
    ...base,
    fulfillmentMethod: "special_order",
    paymentMethod: "special_order",
    specialNotes: "Request custom broth.",
  };
  const f = fixture();
  const r = await f.api.createPreorder(input, {});
  await assert.rejects(f.api.createPaymentIntent(input, {}), /approval/i);
  const terms = {
    orderId: r.orderId,
    decision: "approve",
    items: [
      { productId: "custom", name: "Custom Broth", quantity: 2, price: 4000 },
    ],
    totalAmount: 8000,
  };
  const results = await Promise.allSettled([
    f.api.reviewSpecialOrder(terms, admin),
    f.api.reviewSpecialOrder(terms, admin),
  ]);
  assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(f.sessions.length, 1);
  const o = f.records.get(`orders/${r.orderId}`);
  const event = {
    id: "evt_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        id: o.checkoutSessionId,
        mode: "payment",
        payment_intent: "pi_special",
        payment_status: "unpaid",
        amount_total: 8000,
        currency: "usd",
        metadata: { orderId: r.orderId, binding: o.paymentBinding },
      },
    },
  };
  await assert.rejects(f.api.processStripeEvent(event), /mismatch/i);
  event.data.object.payment_status = "paid";
  await f.api.processStripeEvent(event);
  assert.equal(f.records.get(`orders/${r.orderId}`).status, "paid");
  await assert.rejects(
    f.api.reviewSpecialOrder({ ...terms, decision: "decline" }, admin),
    /conflict/i,
  );
  for (const origin of [
    "http://mammoth.example",
    "https://mammoth.example/evil",
    "https://x:y@mammoth.example",
    "https://mammoth.example?evil=yes",
  ]) {
    const disabled = fixture({ origin });
    const request = await disabled.api.createPreorder(input, {});
    await assert.rejects(
      disabled.api.reviewSpecialOrder(
        { ...terms, orderId: request.orderId },
        admin,
      ),
      /origin/i,
    );
    assert.equal(disabled.sessions.length, 0);
  }
  const declined = fixture();
  const dr = await declined.api.createPreorder(input, {});
  await declined.api.reviewSpecialOrder(
    { orderId: dr.orderId, decision: "decline" },
    admin,
  );
  await assert.rejects(
    declined.api.reviewSpecialOrder({ ...terms, orderId: dr.orderId }, admin),
    /conflict/i,
  );
  assert.equal(declined.sessions.length, 0);
});
test("transaction retries never return an uncommitted receipt capability", async () => {
  const f = fixture();
  const run = f.db.runTransaction;
  let first = true;
  f.db.runTransaction = async (callback) => {
    if (!first) return run(callback);
    first = false;
    // Model another creation winning while Firestore re-runs our callback.
    await run(callback);
    const order = [...f.records].find(([key]) => key.startsWith("orders/"))[1];
    order.receiptTokenHash = crypto
      .createHash("sha256")
      .update("z".repeat(43))
      .digest("hex");
    return run(callback);
  };
  await assert.rejects(f.api.createPaymentIntent(base, {}),
    e => e.code === "permission-denied",
    "a conflicting committed hash never returns a token or payment secret");
  assert.equal(f.payments.length, 0);
});
