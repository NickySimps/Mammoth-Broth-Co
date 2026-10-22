const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Run real callable handlers against isolated database/payment boundaries.
// These tests never access Firebase, Stripe, or a mail service.
function loadFunctions({ promotion, products, market = {}, freshMarket, config, environment = {} } = {}) {
  const records = new Map([
    ['products/mushroom', { name: 'Mushroom Broth', price: 2500, priceCents: 2500, active: true, available: true }],
    ['markets/market_atlantic', { name: 'Atlantic Beach', active: true, ...market }]
  ]);
  if (promotion) records.set('settings/promotions', promotion);
  for (const [id, product] of Object.entries(products || {})) records.set(`products/${id}`, product);
  const payments = [];
  const emails = [];
  let sequence = 0;
  let queue = Promise.resolve();
  const snapshot = (path, data = records.get(path)) => ({ id: path.split('/').at(-1), exists: data !== undefined, data: () => data });
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snapshot(path) });
  const db = {
    collection: name => ({
      doc: id => ref(`${name}/${id || `order_${++sequence}`}`),
      where: (field, op, value) => ({ limit: () => ({ get: async () => {
        const docs = [...records].filter(([path, data]) => path.startsWith(`${name}/`) && data[field] === value).map(([path]) => snapshot(path));
        return { empty: !docs.length, docs };
      } }) })
    }),
    getAll: async (...refs) => refs.map(item => snapshot(item.path)),
    runTransaction: callback => {
      const task = queue.then(() => callback({
        get: async item => snapshot(item.path, item.path.startsWith('markets/') && freshMarket ? freshMarket : records.get(item.path)),
        set: (item, value) => records.set(item.path, value),
        update: (item, value) => records.set(item.path, { ...records.get(item.path), ...value })
      }));
      queue = task.catch(() => {});
      return task;
    }
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const functions = {
    config: () => config || ({ stripe: { secret: 'test-only-fixture' }, gmail: { email: 'qa@example.com' } }),
    https: { onCall: handler => handler, HttpsError },
    firestore: { document: () => ({ onCreate: handler => handler }) }
  };
  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => 'test-server-timestamp' };
  const context = {
    exports: {}, process: { env: environment }, console,
    require: name => {
      if (name === 'firebase-functions') return functions;
      if (name === 'firebase-admin') return { initializeApp() {}, firestore };
      if (name === 'nodemailer') return { createTransport: () => ({ sendMail: async message => { emails.push(message); } }) };
      if (name === 'stripe') return () => ({ paymentIntents: {
        create: async request => { payments.push(request); return { client_secret: 'test-only-client-secret' }; },
        retrieve: async () => ({ status: 'succeeded', amount_received: 2500, currency: 'usd' })
      } });
      if (name === './email-template') return { confirmationEmail() {}, confirmationText() {} };
      if (name === 'crypto' || name === 'node:crypto') return crypto;
      throw new Error(`Unexpected dependency ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync('firebase/functions/index.js', 'utf8'), context);
  return { handlers: context.exports, payments, records, emails };
}
const pickup = {
  cart: { mushroom: 1 }, customerName: 'QA', customerEmail: 'qa@example.com',
  fulfillmentMethod: 'market_pickup', marketId: 'market_atlantic', pickupDate: '2099-01-04',
  paymentMethod: 'pickup', idempotencyKey: 'test-request-1', orderName: 'Test-Mammoth-1'
};
async function reject(handler, request, pattern) {
  await assert.rejects(handler(request, {}), error => pattern.test(error.message));
}
(async () => {
  const invalid = loadFunctions();
  await reject(invalid.handlers.createPreorder, { ...pickup, fulfillmentMethod: 'teleport' }, /receiv|fulfillment/i);
  await reject(invalid.handlers.createPreorder, { ...pickup, fulfillmentMethod: 'local_delivery', cart: { mushroom: 5 }, deliveryAddress: { street: '1 Main', city: 'Jacksonville', state: 'FL', zip: '32202' } }, /payment|pickup/i);
  await reject(invalid.handlers.createPreorder, { ...pickup, paymentMethod: 'special_order' }, /payment|special/i);

  const disabled = loadFunctions({ products: { mushroom: { name: 'Mushroom Broth', price: 2500, available: false } } });
  await reject(disabled.handlers.createPaymentIntent, pickup, /available/i);
  const quantities = loadFunctions();
  await reject(quantities.handlers.createPaymentIntent, { ...pickup, cart: { mushroom: 3, other: -1 } }, /quantit|whole/i);

  const promotion = loadFunctions({ promotion: { brothBundleEnabled: false } });
  await promotion.handlers.createPaymentIntent({ ...pickup, cart: { mushroom: 4 } }, {});
  assert.equal(promotion.payments[0].amount, 10000, 'PaymentIntent must use the configured promotion, not a separate hardcoded bundle');
  const cents = loadFunctions({ products: { mushroom: { name: 'Mushroom Broth', priceCents: 2500 } } });
  await cents.handlers.createPaymentIntent(pickup, {});
  assert.equal(cents.payments[0].amount, 2500, 'Canonical cents price must be supported by payment setup');

  const changedMarket = loadFunctions({ freshMarket: { name: 'Atlantic Beach', active: false } });
  await reject(changedMarket.handlers.createPreorder, pickup, /market|accepting/i);

  const concurrent = loadFunctions();
  const results = await Promise.all([
    concurrent.handlers.createPreorder(pickup, {}),
    concurrent.handlers.createPreorder(pickup, {})
  ]);
  assert.equal(results[0].orderId, results[1].orderId, 'Concurrent retries must return one durable order');
  assert.equal([...concurrent.records.keys()].filter(path => path.startsWith('orders/')).length, 1);
  const order = concurrent.records.get(`orders/${results[0].orderId}`);
  assert.equal(order.totalAmount, 2500);
  assert.equal(order.items[0].productId, 'mushroom');
  assert.equal(order.status, 'pending');
  const mail = loadFunctions({ config: {}, environment: { GMAIL_EMAIL: 'operations@example.com' } });
  await mail.handlers.sendOrderConfirmationEmail({ data: () => ({ ...pickup, fulfillmentMethod: 'special_order', paymentMethod: 'special_order' }) }, { params: { orderId: 'test-mail' } });
  assert.equal(mail.emails.length, 2);
  assert.equal(mail.emails[1].to, 'operations@example.com', 'Environment mail configuration must work without legacy config');
  assert.doesNotMatch(mail.emails[0].subject, /reserved/i, 'Special request subjects must not promise reservation');
  console.log('callable validation, pricing, concurrent retry, and confirmation regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
