const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, base } = require("./commerce-fixture.cjs");

const malformed = [
  ...[null, "false", "true", 0, 1, [], {}].map(brothBundleEnabled => ({ brothBundleEnabled })),
  ...[null, "4", 0, -1, 1.5, 13, Infinity, NaN, true].map(bundleMinimum => ({ bundleMinimum })),
  ...[null, "2000", 0, -1, 0.5, 100001, Number.MAX_SAFE_INTEGER, Infinity, NaN, true].map(bundlePriceCents => ({ bundlePriceCents })),
];
malformed.push(...malformed.filter(p => p.brothBundleEnabled === undefined)
  .map(p => ({ ...p, brothBundleEnabled: true })));

function catalog(f) {
  f.records.set("products/prod_beef", { name: "Beef Broth", priceCents: 2500 });
  f.records.set("products/prod_chicken", { name: "Chicken Broth", priceCents: 2500 });
}

test("malformed legacy bundle drafts cannot alter fixed six-jar pickup prices on either creation path", async () => {
  for (const promotion of malformed) {
    for (const method of ["createPreorder", "createPaymentIntent"]) {
      const f = fixture();
      catalog(f);
      f.records.set("settings/promotions", promotion);
      const { orderId } = await f.api[method]({ ...base,
        cart: { prod_beef: 2, prod_chicken: 2, mushroom: 2 }, paymentMethod: "pickup" });
      const order = f.records.get(`orders/${orderId}`);
      assert.equal(order.subtotal, 15000);
      assert.equal(order.discountAmount, 2000);
      assert.equal(order.totalAmount, 13000);
      assert.equal(order.items.find(i => i.productId === "mushroom").price, 2500);
      assert.equal(f.payments.length, method === "createPaymentIntent" ? 1 : 0);
      if (f.payments.length) assert.equal(f.payments[0].p.amount, 13000);
      assert.equal(f.sessions.length, 0);
      assert.equal(f.mails.length, 0);
    }
  }
});

test("fixed six-jar boundaries count mushroom but discount only canonical beef/chicken without increasing prices", async () => {
  for (const promotion of [undefined, {}, { brothBundleEnabled: false },
    { brothBundleEnabled: true, bundleMinimum: 1, bundlePriceCents: 1 },
    { bundleMinimum: 12, bundlePriceCents: 100000 }]) {
    for (const [cart, expected] of [
      [{ prod_beef: 4, mushroom: 1 }, 12500],
      [{ prod_beef: 4, mushroom: 2 }, 13000],
      [{ mushroom: 6 }, 15000],
      [{ prod_chicken: 12 }, 24000],
    ]) {
      const f = fixture(); catalog(f);
      if (promotion === undefined) f.records.delete("settings/promotions");
      else f.records.set("settings/promotions", promotion);
      const { orderId } = await f.api.createPreorder({ ...base, cart, paymentMethod: "pickup" });
      const order = f.records.get(`orders/${orderId}`);
      assert.equal(order.totalAmount, expected);
      assert.ok(order.discountAmount >= 0);
      assert.equal(order.totalAmount, order.subtotal - order.discountAmount);
      assert.ok(order.totalAmount <= order.subtotal);
    }
  }
  const f = fixture(); catalog(f);
  f.records.get("products/prod_beef").priceCents = 1500;
  const { orderId } = await f.api.createPreorder({ ...base, cart: { prod_beef: 6 }, paymentMethod: "pickup" });
  assert.equal(f.records.get(`orders/${orderId}`).totalAmount, 9000, "offer never raises catalog price");
});

test("unsupported catalog products reject before order, budget, capacity or provider work", async () => {
  for (const method of ["createPreorder", "createPaymentIntent"]) {
    const f = fixture();
    f.records.set("products/tea", { name: "Herbal Tea", priceCents: 900 });
    const before = structuredClone([...f.records]);
    await assert.rejects(f.api[method]({ ...base, cart: { mushroom: 4, tea: 1 }, paymentMethod: "pickup" }),
      e => e.code === "failed-precondition" && /unsupported catalog/i.test(e.message));
    assert.deepEqual([...f.records], before);
    assert.equal(f.payments.length, 0);
    assert.equal(f.sessions.length, 0);
    assert.equal(f.mails.length, 0);
  }
});

test("delivery quotes stay unavailable despite enabled delivery and malformed legacy promotion", async () => {
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
  }), e => e.code === "failed-precondition" && /market pickup/i.test(e.message));
  assert.deepEqual([...f.records], before);
  assert.equal(f.payments.length, 0);
});
