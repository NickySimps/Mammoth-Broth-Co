const assert = require("node:assert/strict");
const path = require("node:path");
const modulePath = path.resolve(
  __dirname,
  "../firebase/functions/commerce.cjs",
);
function fixture({ origin = "https://mammoth.example" } = {}) {
  const records = new Map([
    [
      "products/mushroom",
      { name: "Mushroom Broth", priceCents: 2500, active: true },
    ],
    ["markets/atlantic", { name: "Atlantic", active: true, day: 0, timezone: "America/New_York" }],
    ["settings/promotions", { brothBundleEnabled: false }],
  ]);
  let queue = Promise.resolve();
  const snapshot = (p) => ({
    exists: records.has(p),
    data: () => structuredClone(records.get(p)),
  });
  const ref = (p) => ({
    path: p,
    id: p.split("/").at(-1),
    get: async () => snapshot(p),
  });
  const db = {
    collection: (n) => ({ doc: (id) => ref(`${n}/${id}`) }),
    runTransaction: (cb) => {
      const promise = queue.then(async () => {
        const writes = [];
        let writing = false;
        const result = await cb({
          get: async (r) => {
            assert.equal(
              writing,
              false,
              "Firestore requires all reads before writes",
            );
            return snapshot(r.path);
          },
          set: (r, v) => {
            writing = true;
            writes.push(() => records.set(r.path, structuredClone(v)));
          },
          update: (r, v) => {
            writing = true;
            writes.push(() =>
              records.set(r.path, {
                ...records.get(r.path),
                ...structuredClone(v),
              }),
            );
          },
        });
        writes.forEach((w) => w());
        return result;
      });
      queue = promise.catch(() => {});
      return promise;
    },
  };
  const payments = [],
    sessions = [],
    mails = [];
  const providerResults = new Map();
  let failPayment = false,
    failMail = false;
  let clock = Date.parse("2026-10-22T12:00:00Z");
  const stripe = {
    paymentIntents: {
      create: async (p, o) => {
        assert.ok(
          [...records].some(
            ([key, v]) =>
              key.startsWith("orders/") && v.status === "awaiting_payment",
          ),
          "order durable before provider",
        );
        payments.push({ p, o });
        if (failPayment) throw Error("provider down");
        if (!providerResults.has(o.idempotencyKey))
          providerResults.set(o.idempotencyKey, {
            id: `pi_${providerResults.size + 1}`,
            client_secret: "secret_fixture",
            ...p,
          });
        return providerResults.get(o.idempotencyKey);
      },
    },
    checkout: {
      sessions: {
        create: async (p, o) => {
          sessions.push({ p, o });
          if (!providerResults.has(o.idempotencyKey))
            providerResults.set(o.idempotencyKey, {
              id: `cs_${providerResults.size + 1}`,
              url: "https://checkout.stripe.com/c/pay_fixture",
              ...p,
            });
          return providerResults.get(o.idempotencyKey);
        },
      },
    },
  };
  class HttpsError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const api = require(modulePath)({
    db,
    stripe,
    HttpsError,
    now: () => clock,
    origin,
    sendEmail: async (m) => {
      if (failMail) throw Error("mail down");
      mails.push(m);
    },
  });
  for (const method of ["createPaymentIntent", "createPreorder"]) {
    const handler = api[method];
    api[method] = (data, context = {}) => handler(data, {
      app: { appId: "verified-fixture-app" }, rawRequest: { ip: "192.0.2.1" }, ...context,
    });
  }
  return {
    api,
    db,
    stripe,
    setNow: (value) => {
      clock = Date.parse(value);
    },
    records,
    payments,
    sessions,
    mails,
    setFailPayment: (v) => {
      failPayment = v;
    },
    setFailMail: (v) => {
      failMail = v;
    },
  };
}
const base = {
  requestId: "request-1234567890",
  receiptToken: "a".repeat(64),
  cart: { mushroom: 1 },
  customerName: "Alex",
  customerEmail: "alex@example.com",
  fulfillmentMethod: "market_pickup",
  marketId: "atlantic",
  pickupDate: "2026-10-25",
};
const admin = { auth: { uid: "owner", token: { admin: true } } };
module.exports = { fixture, base, admin };
