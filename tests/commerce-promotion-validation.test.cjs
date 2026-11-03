const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, base } = require("./commerce-fixture.cjs");

const malformed = [
  ...[null, "false", "true", 0, 1, [], {}].map(brothBundleEnabled => ({ brothBundleEnabled })),
  ...[null, "4", 0, -1, 1.5, 13, Infinity, NaN, true].map(bundleMinimum => ({ bundleMinimum })),
  ...[null, "2000", 0, -1, 0.5, 100001, Number.MAX_SAFE_INTEGER, Infinity, NaN, true].map(bundlePriceCents => ({ bundlePriceCents })),
];
// Exercise explicit enabling as well as the default-enabled policy.
malformed.push(...malformed.filter(p => p.brothBundleEnabled === undefined)
  .map(p => ({ ...p, brothBundleEnabled: true })));

test("malformed enabled/default-enabled bundle policy rejects before order, budget, capacity or provider work", async () => {
  for (const promotion of malformed) {
    for (const method of ["createPreorder", "createPaymentIntent"]) {
      const f = fixture();
      f.records.set("settings/promotions", promotion);
      const before = structuredClone([...f.records]);
      await assert.rejects(
        f.api[method]({ ...base, cart: { mushroom: 4 }, ...(method === "createPreorder" ? { fulfillmentMethod: "special_order", paymentMethod: "special_order", specialNotes: "Custom requested batch." } : {}) }),
        e => e.code === "failed-precondition",
        `${method}: ${JSON.stringify(promotion)}`,
      );
      assert.deepEqual([...f.records], before);
      assert.equal(f.payments.length, 0);
      assert.equal(f.sessions.length, 0);
      assert.equal(f.mails.length, 0);
    }
  }
});

test("bundle defaults and valid boundaries preserve non-increasing broth-only discounts", async () => {
  for (const [promotion, quantity, expected] of [
    [{}, 3, 7500],
    [{}, 4, 10000],
    [undefined, 4, 10000],
    [{}, 6, 12000],
    [{ brothBundleEnabled: true, bundleMinimum: 1, bundlePriceCents: 1 }, 1, 2500],
    [{ bundleMinimum: 12, bundlePriceCents: 2000 }, 12, 24000],
    [{ bundleMinimum: 1, bundlePriceCents: 100000 }, 1, 2500],
    [{ brothBundleEnabled: false, bundleMinimum: 12, bundlePriceCents: 100000 }, 6, 12000],
  ]) {
    const f = fixture();
    f.records.set("products/prod_beef", { name: "Beef Broth", priceCents: 2500 });
    if (promotion === undefined) f.records.delete("settings/promotions");
    else f.records.set("settings/promotions", promotion);
    f.records.set("products/tea", { name: "Herbal Tea", priceCents: 900 });
    const cart = { prod_beef: quantity, ...(quantity < 12 ? { tea: 1 } : {}) };
    const { orderId } = await f.api.createPaymentIntent({ ...base, cart });
    const order = f.records.get(`orders/${orderId}`);
    assert.equal(order.totalAmount, expected + (quantity < 12 ? 900 : 0));
    assert.ok(order.discountAmount >= 0);
    assert.ok(order.discountAmount <= quantity * 2500);
    assert.ok(order.totalAmount <= order.subtotal);
  }
});

test("delivery quotes reject invalid promotion configuration before returning a price", async () => {
  const f = fixture();
  f.records.set("settings/delivery", {
    enabled: true, allowedZips: ["32202"], state: "FL", feeCents: 500,
    minimumJars: 5, cutoffHours: 48,
  });
  f.records.set("settings/promotions", { bundlePriceCents: -1 });
  const before = structuredClone([...f.records]);
  await assert.rejects(f.api.getDeliveryQuote({
    cart: { mushroom: 5 },
    address: { street: "1 Main St", city: "Jacksonville", state: "FL", zip: "32202" },
  }), e => e.code === "failed-precondition");
  assert.deepEqual([...f.records], before);
});
