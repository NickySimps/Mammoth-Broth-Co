import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const templates = ['../server/email-template.js', '../firebase/functions/email-template.js'];
const base = { id: 'order-1', orderName: 'Broth order', totalAmount: 2500, items: [], marketName: 'Saturday market', pickupDate: 'Saturday', fulfillmentMethod: 'market_pickup', paymentMethod: 'pickup', status: 'pending' };
async function accountHtml(order) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { addEventListener() {}, innerHTML: '' });
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({ document, window: {}, getUserOrders: async () => [order], watchUser() {} });
  const source = readFileSync(new URL('../account.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/, '');
  vm.runInContext(source, context);
  await vm.runInContext('renderOrders({ uid: "test-user" })', context);
  return elements.get('orders-list').innerHTML;
}

test('account renders delivery instead of pickup and never infers paid from Stripe', async () => {
  const html = await accountHtml({ ...base, fulfillmentMethod: 'local_delivery', paymentMethod: 'stripe', status: 'payment_processing', deliveryAddress: { street: '1 Main <Street>', city: 'Town', state: 'NC', zip: '28000' } });
  assert.match(html, /Local delivery/);
  assert.match(html, /1 Main &lt;Street&gt;/);
  assert.match(html, /Payment processing/);
  assert.doesNotMatch(html, /Paid online|<strong>Pickup<\/strong>|Saturday market|Upcoming pickup/);
});

test('account special requests await approval without reservation or payment promises', async () => {
  const html = await accountHtml({ ...base, fulfillmentMethod: 'special_order', paymentMethod: 'special_order', status: 'awaiting_approval', specialNotes: '<script>request</script>' });
  assert.match(html, /Awaiting approval/);
  assert.match(html, /Special request/);
  assert.match(html, /not reserved/i);
  assert.match(html, /payment.*not.*confirmed/i);
  assert.match(html, /&lt;script&gt;request&lt;\/script&gt;/);
  assert.doesNotMatch(html, /Paid online|Pay at pickup|<strong>Pickup<\/strong>/);
});

test('account distinguishes real payment and lifecycle statuses with safe unknown fallback', async () => {
  for (const [status, expected] of Object.entries({ paid: 'Payment received', cancelled: 'Cancelled', refunded: 'Refunded', ready_for_pickup: 'Ready for pickup', completed: 'Completed', mystery: 'Status unavailable' })) {
    const html = await accountHtml({ ...base, status, paymentMethod: 'stripe' });
    assert.ok(html.includes(expected), `${status}: ${html}`);
    if (status !== 'paid') assert.doesNotMatch(html, /Paid online/);
  }
  assert.match(await accountHtml(base), /Pay at pickup/);
  assert.match(await accountHtml({ ...base, paymentMethod: 'stripe' }), /Payment pending/);
});

for (const path of templates) {
  const { confirmationEmail, confirmationText } = require(path);
  const outputs = order => [confirmationEmail(order), confirmationText(order)];
  test(`${path}: delivery HTML and text show address, real status and no pickup instructions`, () => {
    for (const output of outputs({ ...base, fulfillmentMethod: 'local_delivery', paymentMethod: 'stripe', status: 'paid', deliveryAddress: { street: '1 Main Street', city: 'Town', state: 'NC', zip: '28000' } })) {
      assert.match(output, /Local delivery/i);
      assert.match(output, /1 Main Street, Town, NC, 28000/);
      assert.match(output, /Payment received/i);
      assert.match(output, /Paid online/);
      assert.doesNotMatch(output, /pickup|Saturday market|when you arrive|broth is reserved/i);
    }
  });
  test(`${path}: special HTML and text await approval without guaranteed stock or payment`, () => {
    for (const status of ['awaiting_approval', 'pending', undefined]) {
      for (const output of outputs({ ...base, fulfillmentMethod: 'special_order', paymentMethod: 'special_order', status, specialNotes: 'Please call first' })) {
        assert.match(output, /Awaiting approval/i);
        assert.match(output, /Special request/i);
        assert.match(output, /Please call first/);
        assert.match(output, /not reserved/i);
        assert.match(output, /Payment not confirmed/i);
        assert.doesNotMatch(output, /Paid online|Pay at pickup|broth is reserved|when you arrive|confirms your preorder|pickup/i);
      }
    }
  });
  test(`${path}: lifecycle statuses and Stripe pending are not labelled reserved or paid`, () => {
    for (const [status, label] of Object.entries({ payment_processing: 'Payment processing', cancelled: 'Cancelled', refunded: 'Refunded', ready_for_pickup: 'Ready for pickup', completed: 'Completed', mystery: 'Status unavailable' })) {
      for (const output of outputs({ ...base, paymentMethod: 'stripe', status })) {
        assert.ok(output.toLowerCase().includes(label.toLowerCase()), `${status} missing ${label}`);
        assert.doesNotMatch(output, /Paid online|broth is reserved/i);
      }
    }
    for (const output of outputs({ ...base, paymentMethod: 'stripe' })) assert.match(output, /Payment pending/);
    for (const output of outputs(base)) {
      assert.match(output, /Pickup/i);
      assert.match(output, /Saturday market/);
      assert.match(output, /Pay at pickup/);
    }
  });
  test(`${path}: HTML escapes delivery, request and customer fields and retains email layout`, () => {
    const hostile = '<img src=x onerror="alert(1)">';
    for (const fulfillmentMethod of ['market_pickup', 'local_delivery', 'special_order']) {
      const html = confirmationEmail({ ...base, fulfillmentMethod, customerName: hostile, orderName: hostile, marketName: hostile, specialNotes: hostile, deliveryAddress: { street: hostile }, items: [{ name: hostile, description: hostile, quantity: 1, itemTotal: 2500 }] });
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
      assert.match(html, /max-width:640px;background:#fffaf0/);
      assert.match(html, /QR code linking to order/);
      assert.match(html, /View your order ledger/);
    }
  });
}

test('both email implementations remain identical', () => {
  assert.equal(readFileSync(new URL(templates[0], import.meta.url), 'utf8'), readFileSync(new URL(templates[1], import.meta.url), 'utf8'));
});
