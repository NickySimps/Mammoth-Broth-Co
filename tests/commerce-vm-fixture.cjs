const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { fixture } = require("./commerce-fixture.cjs");
const Stripe = require("../firebase/functions/node_modules/stripe");
function load(enabled = true, { realCallableRuntime = false } = {}) {
  const f = fixture(),
    exports = {};
  class HttpsError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const handler = (fn, options) => Object.assign(fn, { options });
  const functions = {
    https: { HttpsError },
    runWith: (options) => ({
      https: {
        onCall: (fn) => realCallableRuntime
          ? handler(require('node:module').createRequire(path.resolve(__dirname, '../firebase/functions/index.js'))('firebase-functions/v1').runWith(options).https.onCall(fn), options)
          : handler((data, context = {}) => fn(data, { app: { appId: "verified-fixture-app" }, rawRequest: { ip: "192.0.2.1" }, ...context }), options),
        onRequest: (fn) => handler(fn, options),
      },
      firestore: {
        document: () => ({
          onCreate: (fn) => handler(fn, options),
          onUpdate: (fn) => handler(fn, options),
        }),
      },
    }),
  };
  const signing = new Stripe("sk_test_mock");
  let constructCalls = 0;
  const stripe = {
    ...f.stripe,
    webhooks: {
      constructEvent: (...args) => {
        constructCalls++;
        return signing.webhooks.constructEvent(...args);
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../firebase/functions/index.js"),
      "utf8",
    ),
    {
      exports,
      Buffer,
      console,
      process: {
        env: enabled
          ? {
              COMMERCE_PAYMENTS_ENABLED: "true",
              COMMERCE_EMAIL_ENABLED: "true",
              STRIPE_SECRET: "sk_test_mock",
              STRIPE_WEBHOOK_SECRET: "whsec_mock",
              GMAIL_PASS: "mock",
              GMAIL_EMAIL: "ops@example.com",
              COMMERCE_ORIGIN: "https://mammoth.example",
            }
          : {},
      },
      require: (name) => {
        if (name === "firebase-functions/v1") return functions;
        if (name === "firebase-admin")
          return { initializeApp() {}, firestore: () => f.db };
        if (name === "stripe")
          return function () {
            return stripe;
          };
        if (name === "nodemailer")
          return {
            createTransport: () => ({
              sendMail: async (mail) => f.mails.push(mail),
            }),
          };
        if (name === "./commerce.cjs")
          return (options) =>
            require("../firebase/functions/commerce.cjs")({
              ...options,
              now: () => Date.parse("2026-10-22T12:00:00Z"),
            });
        throw Error(`Unexpected dependency ${name}`);
      },
    },
  );
  return {
    ...f,
    handlers: exports,
    signing,
    constructCalls: () => constructCalls,
  };
}
module.exports = { load };
