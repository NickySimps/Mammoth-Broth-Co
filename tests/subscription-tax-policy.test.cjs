'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTaxPolicy, validateTaxResult, validateInvoiceTaxResult, API_VERSION } = require('../firebase/functions/subscription-tax-policy.cjs');
// Entirely synthetic fixtures, not tax advice or a Stripe calculation.
function fixture(behavior = 'exclusive') {
  return {
    policy: { ready: true, version: 'owner-v1', approvalReference: 'owner-approved-fixture', behavior,
      registration: { id: 'taxreg_fixture', country: 'US', state: 'CA', status: 'active', approved: true },
      skuTaxCodes: { broth: 'txcd_12345678' }, deliveryTax: { approved: true, approvalReference: 'owner-delivery-fixture', taxCode: 'txcd_87654321', behavior: 'exclusive' },
      addressConstraints: [{ country: 'US', state: 'CA', postalCodes: ['90001'] }] },
    terms: { id: 'attempt_fixture', currency: 'usd', baseAmount: 12000,
      address: { line1: '1 Fixture St', city: 'Fixture', state: 'CA', postal_code: '90001', country: 'US' },
      lines: [{ sku: 'broth', quantity: 6, unitAmount: 1900 }, { sku: 'delivery_fee', quantity: 1, unitAmount: 600 }],
      recurring: { interval: 'month', interval_count: 1 } }
  };
}
test('requires independent delivery classification approval even when jar tax is approved', () => {
  const { policy, terms } = fixture();
  delete policy.deliveryTax;
  assert.throws(() => buildTaxPolicy(policy, terms), /tax policy/i);
});
test('exclusive jars and independently approved recurring delivery preserve separate tax settings', () => {
  const { policy, terms } = fixture();
  policy.deliveryTax.behavior = 'inclusive';
  const plan = buildTaxPolicy(policy, terms);
  assert.equal(plan.jarSubtotal, 11400);
  assert.equal(plan.deliveryFee, 600);
  assert.equal(plan.checkout.line_items[0].price_data.tax_behavior, 'exclusive');
  assert.equal(plan.checkout.line_items[1].price_data.tax_behavior, 'inclusive');
  assert.deepEqual(plan.checkout.line_items[1].price_data.recurring, terms.recurring);
  assert.deepEqual(plan.deliveryTax, policy.deliveryTax);
});
test('defaults fail closed; owner must explicitly approve tax behavior', () => {
  assert.throws(() => buildTaxPolicy(), /tax policy/i);
  const { policy, terms } = fixture();
  for (const behavior of [undefined, 'automatic', 'approved_no_tax', false]) {
    assert.throws(() => buildTaxPolicy({ ...policy, behavior }, terms), /tax policy/i);
  }
});
test('maps both owner-approved behaviors without altering immutable base prices', () => {
  for (const behavior of ['inclusive', 'exclusive']) {
    const { policy, terms } = fixture(behavior);
    const before = structuredClone({ policy, terms });
    const plan = buildTaxPolicy(policy, terms);
    assert.equal(plan.baseAmount, 12000);
    assert.equal(plan.currency, 'usd');
    assert.deepEqual(plan.checkout.automatic_tax, { enabled: true });
    assert.equal(plan.checkout.line_items[0].price_data.tax_behavior, behavior);
    assert.equal(plan.checkout.line_items[0].price_data.product_data.tax_code, policy.skuTaxCodes.broth);
    assert.equal(plan.checkout.line_items[1].price_data.product_data.tax_code, policy.deliveryTax.taxCode);
    assert.equal(plan.checkout.billing_address_collection, 'required');
    assert.deepEqual({ policy, terms }, before);
    assert.ok(Object.isFrozen(plan.checkout.line_items[0].price_data));
    terms.lines[0].unitAmount = 1;
    policy.skuTaxCodes.broth = 'txcd_00000000';
    assert.equal(plan.checkout.line_items[0].price_data.unit_amount, 1900);
    assert.equal(plan.checkout.line_items[0].price_data.product_data.tax_code, 'txcd_12345678');
  }
});
test('rejects incomplete approval, rates, unsafe amounts, unknown SKUs and unapproved addresses', () => {
  const mutations = [
    f => { delete f.policy.registration; }, f => { f.policy.registration.status = 'scheduled'; },
    f => { f.policy.registration.approved = false; }, f => { f.policy.ready = false; },
    f => { f.policy.approvalReference = ''; }, f => { delete f.policy.skuTaxCodes.broth; },
    f => { f.policy.deliveryTax.taxCode = 'not-a-code'; }, f => { f.policy.rate = 0.1; },
    f => { f.policy.deliveryTax.approved = false; },
    f => { delete f.policy.deliveryTax.approvalReference; },
    f => { delete f.policy.deliveryTax.behavior; },
    f => { f.policy.deliveryTax.taxExempt = true; },
    f => { f.policy.deliveryTax.rate = 0; },
    f => { f.policy.deliveryTaxCode = 'txcd_87654321'; delete f.policy.deliveryTax; },
    f => { f.terms.lines[0].sku = '__proto__'; }, f => { f.terms.lines[0].quantity = 1.5; },
    f => { f.terms.lines[0].unitAmount = Number.MAX_SAFE_INTEGER; },
    f => { f.terms.baseAmount++; }, f => { f.terms.currency = 'USD'; },
    f => { f.terms.address.postal_code = '90002'; }, f => { f.terms.address.line1 = ''; },
    f => { f.policy.registration.state = 'NY'; }, f => { f.terms.tax = 0; },
    f => { f.terms.lines.push({ ...f.terms.lines[0] }); },
    f => { f.terms.lines = new Array(2); f.terms.lines[1] = { sku: 'delivery_fee', quantity: 1, unitAmount: 12000 }; },
    f => { f.terms.lines.extra = 'ignored-field'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.throws(() => buildTaxPolicy(f.policy, f.terms), /tax policy/i, mutate.toString());
  }
});
function resultFixture(behavior = 'exclusive', tax = 137) {
  const { policy, terms } = fixture(behavior);
  const plan = buildTaxPolicy(policy, terms);
  const session = { id: 'cs_test_fixture', object: 'checkout.session', livemode: false,
    mode: 'subscription', status: 'complete', payment_status: 'paid', currency: 'usd',
    client_reference_id: terms.id, automatic_tax: { enabled: true, status: 'complete' },
    customer_details: { tax_exempt: 'none', address: { ...terms.address } },
    shipping_details: { address: { ...terms.address } },
    amount_total: behavior === 'exclusive' ? 12000 + tax : 12000,
    total_details: { amount_tax: tax, amount_discount: 0, amount_shipping: 0 },
    line_items: { has_more: false, data: plan.checkout.line_items.map(l => ({ quantity: l.quantity,
      amount_tax: l.price_data.product_data.metadata.sku === 'broth' ? tax : 0,
      amount_total: l.quantity * l.price_data.unit_amount + (l.price_data.tax_behavior === 'exclusive' && l.price_data.product_data.metadata.sku === 'broth' ? tax : 0),
      price: { currency: l.price_data.currency, unit_amount: l.price_data.unit_amount,
        tax_behavior: l.price_data.tax_behavior, recurring: { ...l.price_data.recurring },
        product: { metadata: { ...l.price_data.product_data.metadata }, tax_code: l.price_data.product_data.tax_code } } })) } };
  const verification = { retrievedFromStripe: true, apiVersion: API_VERSION, sessionId: session.id };
  return { plan, session, verification };
}
test('reports provider jar tax on top of jar subtotal and does not add inclusive fee tax twice', () => {
  const { policy, terms } = fixture();
  policy.deliveryTax.behavior = 'inclusive';
  const f = resultFixture();
  f.plan = buildTaxPolicy(policy, terms);
  const fee = f.session.line_items.data[1];
  fee.price.tax_behavior = 'inclusive';
  fee.amount_tax = 23; // Synthetic provider evidence, never a configured rate.
  f.session.total_details.amount_tax = 160;
  const result = validateTaxResult(f.plan, f.session, f.verification);
  assert.equal(result.jarSubtotal, 11400);
  assert.equal(result.jarTaxAmount, 137);
  assert.equal(result.jarTotal, 11537);
  assert.equal(result.deliveryFee, 600);
  assert.equal(result.deliveryTaxAmount, 23);
  assert.equal(result.addedTaxAmount, 137);
  assert.equal(result.taxAmount, 160);
  assert.equal(result.amountTotal, 12137);
});
test('retains provider tax exactly for both behaviors, including a legitimate zero tax result', () => {
  for (const behavior of ['inclusive', 'exclusive']) for (const tax of [0, 137]) {
    const f = resultFixture(behavior, tax);
    const result = validateTaxResult(f.plan, f.session, f.verification);
    assert.equal(result.taxAmount, tax);
    assert.equal(result.baseAmount, 12000);
    assert.equal(result.amountTotal, f.session.amount_total);
    assert.equal(result.currency, 'usd');
    assert.ok(Object.isFrozen(result));
  }
});
test('rejects unverified, stale-schema, mismatched, incomplete or repriced provider evidence', () => {
  const mutations = [
    f => { f.verification.retrievedFromStripe = false; }, f => { f.verification.apiVersion = '2025-01-01'; },
    f => { f.verification.sessionId = 'cs_test_other'; }, f => { f.plan = structuredClone(f.plan); },
    f => { f.session.livemode = true; }, f => { f.session.automatic_tax.status = 'requires_location_inputs'; },
    f => { f.session.automatic_tax.status = 'failed'; }, f => { f.session.automatic_tax.enabled = false; },
    f => { f.session.payment_status = 'unpaid'; }, f => { f.session.currency = 'eur'; },
    f => { f.session.amount_total++; }, f => { f.session.total_details.amount_tax = -1; },
    f => { delete f.session.total_details.amount_tax; }, f => { f.session.total_details.amount_discount = 1; },
    f => { f.session.shipping_details.address.line1 = '2 Other St'; },
    f => { f.session.customer_details.address.postal_code = '90002'; },
    f => { f.session.customer_details.tax_exempt = 'exempt'; }, f => { f.session.line_items.has_more = true; },
    f => { f.session.line_items.data.pop(); }, f => { f.session.line_items.data[0].quantity = 7; },
    f => { f.session.line_items.data[0].price.unit_amount = 1800; },
    f => { f.session.line_items.data[0].price.product.tax_code = 'txcd_00000000'; },
    f => { f.session.line_items.data[0].price.tax_behavior = 'inclusive'; },
    f => { f.session.line_items.data[0].price.recurring.interval = 'year'; },
  ];
  for (const mutate of mutations) {
    const f = resultFixture(); mutate(f);
    assert.throws(() => validateTaxResult(f.plan, f.session, f.verification), /tax policy/i, mutate.toString());
  }
});
function invoiceFixture(jarBehavior = 'exclusive', deliveryBehavior = 'exclusive', jarTax = 137, feeTax = 23) {
  const { policy, terms } = fixture(jarBehavior);
  policy.deliveryTax.behavior = deliveryBehavior;
  const plan = buildTaxPolicy(policy, terms);
  const verification = { retrievedFromStripe: true, apiVersion: API_VERSION,
    invoiceId: 'in_fixture', subscriptionId: 'sub_fixture', customerId: 'cus_fixture',
    registrationId: policy.registration.id, registrationActive: true,
    period: { start: 100, end: 200 } };
  const lines = plan.checkout.line_items.map((l, i) => {
    const inclusive = l.price_data.tax_behavior === 'inclusive';
    const amount = l.quantity * l.price_data.unit_amount;
    const tax = i === 0 ? jarTax : feeTax;
    return { object: 'line_item', type: 'subscription', subscription: verification.subscriptionId,
      invoice: verification.invoiceId, livemode: false,
      currency: 'usd', quantity: l.quantity, proration: false, period: { ...verification.period },
      amount, amount_excluding_tax: amount - (inclusive ? tax : 0), discount_amounts: [],
      price: { currency: 'usd', unit_amount: l.price_data.unit_amount,
        tax_behavior: l.price_data.tax_behavior, recurring: { ...l.price_data.recurring },
        product: { metadata: { ...l.price_data.product_data.metadata }, tax_code: l.price_data.product_data.tax_code } },
      tax_amounts: [{ amount: tax, inclusive, tax_rate: `txr_fixture_${i}` }] };
  });
  const added = (jarBehavior === 'exclusive' ? jarTax : 0) + (deliveryBehavior === 'exclusive' ? feeTax : 0);
  const total = 12000 + added;
  const excluding = total - jarTax - feeTax;
  const invoice = { object: 'invoice', id: verification.invoiceId, livemode: false,
    subscription: verification.subscriptionId, customer: verification.customerId,
    status: 'paid', paid: true, currency: 'usd', billing_reason: 'subscription_cycle',
    automatic_tax: { enabled: true, status: 'complete' }, customer_tax_exempt: 'none',
    customer_address: { ...terms.address }, customer_shipping: { address: { ...terms.address } },
    subtotal: 12000, subtotal_excluding_tax: excluding, total_excluding_tax: excluding,
    total, amount_due: total, amount_paid: total, amount_remaining: 0,
    total_discount_amounts: [], total_tax_amounts: lines.flatMap(l => l.tax_amounts.map(t => ({ ...t }))),
    lines: { has_more: false, data: lines } };
  return { plan, invoice, verification };
}
test('invoice tax evidence fails closed on missing configuration, identity, line or tax discrepancies', () => {
  const mutations = [
    f => { f.verification.retrievedFromStripe = false; },
    f => { f.verification.apiVersion = 'wrong'; },
    f => { f.verification.registrationActive = false; },
    f => { f.verification.registrationId = 'taxreg_other'; },
    f => { f.verification.invoiceId = 'in_other'; },
    f => { f.verification.customerId = 'cus_other'; },
    f => { f.verification.subscriptionId = 'sub_other'; },
    f => { delete f.verification.period; },
    f => { f.plan = structuredClone(f.plan); },
    f => { f.invoice.livemode = true; },
    f => { f.invoice.automatic_tax.status = 'failed'; },
    f => { f.invoice.customer_tax_exempt = 'exempt'; },
    f => { f.invoice.status = 'open'; },
    f => { f.invoice.amount_paid--; },
    f => { f.invoice.total++; },
    f => { f.invoice.total_excluding_tax++; },
    f => { f.invoice.subtotal_excluding_tax++; },
    f => { f.invoice.customer_address.postal_code = '99999'; },
    f => { f.invoice.total_discount_amounts.push({ amount: 1 }); },
    f => { delete f.invoice.total_tax_amounts; },
    f => { f.invoice.total_tax_amounts[0].amount++; },
    f => { f.invoice.total_tax_amounts[0].inclusive = true; },
    f => { f.invoice.total_tax_amounts[0].tax_rate = 'txr_other'; },
    f => { f.invoice.lines.has_more = true; },
    f => { f.invoice.lines.data.pop(); },
    f => { f.invoice.lines.data[0].proration = true; },
    f => { f.invoice.lines.data[0].period.end++; },
    f => { f.invoice.lines.data[0].subscription = 'sub_other'; },
    f => { f.invoice.lines.data[0].invoice = 'in_other'; },
    f => { f.invoice.lines.data[0].livemode = true; },
    f => { f.invoice.lines.data[0].quantity++; },
    f => { f.invoice.lines.data[0].amount_excluding_tax--; },
    f => { f.invoice.lines.data[0].price.tax_behavior = 'inclusive'; },
    f => { f.invoice.lines.data[1].price.product.tax_code = 'txcd_00000000'; },
    f => { delete f.invoice.lines.data[0].tax_amounts; },
    f => { f.invoice.lines.data[0].tax_amounts[0].amount = -1; },
    f => { f.invoice.lines.data[0].tax_amounts[0].inclusive = true; },
    f => { f.invoice.lines.data[0].tax_amounts.push({ ...f.invoice.lines.data[0].tax_amounts[0] }); },
  ];
  for (const mutate of mutations) {
    const f = invoiceFixture(); mutate(f);
    assert.throws(() => validateInvoiceTaxResult(f.plan, f.invoice, f.verification), /tax policy/i, mutate.toString());
  }
});
test('validates recurring invoice provider taxes separately for exclusive jars and classified delivery', () => {
  for (const behavior of ['inclusive', 'exclusive']) for (const feeBehavior of ['inclusive', 'exclusive']) for (const tax of [0, 137]) {
    const f = invoiceFixture(behavior, feeBehavior, tax, tax === 0 ? 0 : 23);
    const result = validateInvoiceTaxResult(f.plan, f.invoice, f.verification);
    assert.equal(result.jarTaxAmount, tax);
    assert.equal(result.jarTotal, behavior === 'exclusive' ? 11400 + tax : 11400);
    assert.equal(result.amountTotal, f.invoice.total);
    assert.equal(result.invoiceId, f.invoice.id);
    assert.ok(Object.isFrozen(result));
  }
});
test('rejects prototype and getter policy injection without executing getters', () => {
  const f = fixture(); let executed = false;
  Object.defineProperty(f.policy, 'behavior', { enumerable: true, get() { executed = true; return 'exclusive'; } });
  assert.throws(() => buildTaxPolicy(f.policy, f.terms), /tax policy/i);
  assert.equal(executed, false);
  assert.throws(() => buildTaxPolicy(Object.create(fixture().policy), f.terms), /tax policy/i);
});
