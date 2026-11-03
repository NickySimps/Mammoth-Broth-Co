'use strict';
const API_VERSION = '2024-06-20';
function reject() { throw new Error('Subscription tax policy or verified result is invalid.'); }
/** ISOLATED TEST-ONLY mapper. Inputs are trusted SERVER policy/prices, never client authority.
 * No rates, exemptions, registration or product classifications are inferred.
 * policy.behavior applies to JARS: the new business case explicitly supplies
 * 'exclusive' (tax is added to jar prices); 'inclusive' is legacy support only.
 * deliveryTax is a separate mandatory owner-approved Stripe classification and
 * price behavior, NOT a declaration that delivery is taxable or exempt. Stripe
 * calculates its tax independently; missing approval/configuration blocks plans.
 * Both jars and the delivery fee recur at the same approved cadence.
 * registration is an owner approval record, NOT a raw Stripe Registration object.
 * Versioned primary references:
 * https://docs.stripe.com/api/checkout/sessions/create?api-version=2024-06-20
 * https://docs.stripe.com/api/checkout/sessions/object?api-version=2024-06-20
 * https://docs.stripe.com/api/tax/registrations/object?api-version=2024-06-20
 */
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const cents = v => Number.isSafeInteger(v) && v >= 0;
const code = v => typeof v === 'string' && /^txcd_\d{8}$/.test(v);
function record(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value'))) reject();
}
function array(v, max = 1000) {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || !v.length || v.length > max || Reflect.ownKeys(v).length !== v.length + 1) reject();
  for (let i = 0; i < v.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject();
  }
}
function freeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
const plans = new WeakSet();
function frozenPlan(plan) { plans.add(plan); return freeze(plan); }
function buildTaxPolicy(policy, terms) {
  record(policy, ['ready','version','approvalReference','behavior','registration','skuTaxCodes','deliveryTax','addressConstraints']);
  const delivery = policy.deliveryTax;
  record(delivery, ['approved','approvalReference','taxCode','behavior']);
  if (delivery.approved !== true || !text(delivery.approvalReference) || !code(delivery.taxCode) || !['inclusive','exclusive'].includes(delivery.behavior)) reject();
  if (policy.ready !== true || !text(policy.version) || !text(policy.approvalReference) || !['inclusive','exclusive'].includes(policy.behavior)) reject();
  const r = policy.registration;
  record(r, ['id','country','state','status','approved']);
  if (typeof r.id !== 'string' || !/^taxreg_[A-Za-z0-9_]+$/.test(r.id) || r.country !== 'US' || typeof r.state !== 'string' || !/^[A-Z]{2}$/.test(r.state) || r.status !== 'active' || r.approved !== true) reject();
  const codes = policy.skuTaxCodes;
  record(codes, Object.keys(codes || {}));
  if (!Object.keys(codes).length || Object.entries(codes).some(([k,v]) => !text(k) || ['__proto__','constructor','prototype','delivery_fee'].includes(k) || !code(v))) reject();
  array(policy.addressConstraints, 100);
  const seen = new Set();
  for (const zone of policy.addressConstraints) {
    record(zone, ['country','state','postalCodes']);
    if (zone.country !== r.country || zone.state !== r.state) reject();
    array(zone.postalCodes);
    for (const zip of zone.postalCodes) {
      if (typeof zip !== 'string' || !/^\d{5}$/.test(zip) || seen.has(zip)) reject();
      seen.add(zip);
    }
  }
  record(terms, ['id','currency','baseAmount','address','lines','recurring']);
  if (!text(terms.id) || terms.currency !== 'usd' || !cents(terms.baseAmount) || terms.baseAmount === 0) reject();
  const a = terms.address;
  record(a, ['line1','line2','city','state','postal_code','country']);
  if (!['line1','city','state','postal_code','country'].every(k => text(a[k])) || (a.line2 !== undefined && !text(a.line2)) || a.country !== r.country || a.state !== r.state || !seen.has(a.postal_code)) reject();
  record(terms.recurring, ['interval','interval_count']);
  if (!((terms.recurring.interval === 'week' && [1,2].includes(terms.recurring.interval_count)) || (terms.recurring.interval === 'month' && terms.recurring.interval_count === 1))) reject();
  array(terms.lines, 20);
  if (terms.lines.length < 2) reject();
  let base = 0;
  const skus = new Set();
  const lineItems = terms.lines.map(line => {
    record(line, ['sku','quantity','unitAmount']);
    if (!text(line.sku) || skus.has(line.sku) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 12 || !cents(line.unitAmount)) reject();
    skus.add(line.sku);
    if (line.sku === 'delivery_fee' ? line.quantity !== 1 : !Object.hasOwn(codes, line.sku)) reject();
    const amount = line.quantity * line.unitAmount;
    base += amount;
    if (!cents(amount) || !cents(base)) reject();
    return { quantity: line.quantity, price_data: { currency: terms.currency, unit_amount: line.unitAmount,
      tax_behavior: line.sku === 'delivery_fee' ? delivery.behavior : policy.behavior, recurring: { ...terms.recurring },
      product_data: { name: line.sku, metadata: { sku: line.sku }, tax_code: line.sku === 'delivery_fee' ? delivery.taxCode : codes[line.sku] } } };
  });
  if (!skus.has('delivery_fee') || base !== terms.baseAmount) reject();
  const deliveryFee = terms.lines.find(l => l.sku === 'delivery_fee').unitAmount;
  return frozenPlan({ policyVersion: policy.version, approvalReference: policy.approvalReference,
    jarSubtotal: base - deliveryFee, deliveryFee, deliveryTax: { ...delivery },
    registration: { ...r }, behavior: policy.behavior, baseAmount: base, currency: terms.currency,
    address: { ...a }, checkout: { mode: 'subscription', client_reference_id: terms.id,
      automatic_tax: { enabled: true }, billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['US'] }, allow_promotion_codes: false,
      line_items: lineItems } });
}
/**
 * Pure validation only: verification is a TRUSTED ADAPTER assertion, not proof.
 * Adapter must authenticate Stripe retrieval with TEST credentials, bind account,
 * pinned API version and persisted expected session ID, retrieve ALL expanded
 * line-item prices/products and independently verify the active registration.
 * Never pass client session JSON/booleans here. Rebuild a plan from trusted saved
 * terms/policy after restart; serialized/cloned plans are deliberately rejected.
 * Exact shipping AND billing address matching is intentionally restrictive.
 * Checkout-only guard: does not calculate rates or authorize recurring fulfillment.
 * Recurring invoice tax evidence has a separate isolated guard below.
 */
function validateTaxResult(plan, session, verification) {
  if (!plans.has(plan) || verification?.retrievedFromStripe !== true || verification.apiVersion !== API_VERSION || !text(verification.sessionId)) reject();
  if (!session || session.object !== 'checkout.session' || session.id !== verification.sessionId || session.livemode !== false || session.mode !== 'subscription' || session.status !== 'complete' || session.payment_status !== 'paid' || session.currency !== plan.currency || session.client_reference_id !== plan.checkout.client_reference_id || session.automatic_tax?.enabled !== true || session.automatic_tax.status !== 'complete') reject();
  const details = session.total_details;
  if (!details || !cents(details.amount_tax) || details.amount_discount !== 0 || details.amount_shipping !== 0 || !cents(session.amount_total)) reject();

  if (session.customer_details?.tax_exempt !== 'none') reject();
  for (const address of [session.customer_details?.address, session.shipping_details?.address]) {
    if (!address || ['line1','city','state','postal_code','country'].some(k => address[k] !== plan.address[k]) || (address.line2 || undefined) !== plan.address.line2) reject();
  }
  const list = session.line_items;
  if (!list || list.has_more !== false || !Array.isArray(list.data) || list.data.length !== plan.checkout.line_items.length) reject();
  const found = new Set();
  let jarTaxAmount = 0, deliveryTaxAmount = 0, addedTaxAmount = 0;
  for (const line of list.data) {
    const price = line?.price, product = price?.product;
    const sku = product?.metadata?.sku;
    const expected = plan.checkout.line_items.find(l => l.price_data.product_data.metadata.sku === sku);
    if (!expected || found.has(sku)) reject();
    found.add(sku);
    const p = expected.price_data;
    if (line.quantity !== expected.quantity || price.currency !== p.currency || price.unit_amount !== p.unit_amount || price.tax_behavior !== p.tax_behavior || product.tax_code !== p.product_data.tax_code || price.recurring?.interval !== p.recurring.interval || price.recurring?.interval_count !== p.recurring.interval_count) reject();
    const base = expected.quantity * p.unit_amount;
    if (!cents(line.amount_tax) || (p.tax_behavior === 'inclusive' && line.amount_tax > base) || line.amount_total !== base + (p.tax_behavior === 'exclusive' ? line.amount_tax : 0)) reject();
    if (sku === 'delivery_fee') deliveryTaxAmount += line.amount_tax;
    else jarTaxAmount += line.amount_tax;
    if (p.tax_behavior === 'exclusive') addedTaxAmount += line.amount_tax;
  }
  if (![jarTaxAmount, deliveryTaxAmount, addedTaxAmount, plan.baseAmount + addedTaxAmount].every(cents) || details.amount_tax !== jarTaxAmount + deliveryTaxAmount || session.amount_total !== plan.baseAmount + addedTaxAmount) reject();
  return freeze({ sessionId: session.id, policyVersion: plan.policyVersion, behavior: plan.behavior,
    jarSubtotal: plan.jarSubtotal, jarTaxAmount, jarTotal: plan.jarSubtotal + (plan.behavior === 'exclusive' ? jarTaxAmount : 0),
    deliveryFee: plan.deliveryFee, deliveryTaxAmount, addedTaxAmount,
    currency: plan.currency, baseAmount: plan.baseAmount, taxAmount: details.amount_tax,
    amountTotal: session.amount_total });
}
/** ISOLATED TEST-ONLY invoice guard; no SDK calls or fulfillment authorization.
 * Trusted adapter must retrieve the invoice, ALL expanded lines, active registration,
 * and bind invoice/customer/subscription/period to persisted expectations in the same
 * Stripe TEST account at API_VERSION. A boolean supplied by a client is NOT proof.
 * Narrow supported shape: full undiscounted recurring period, no prorations/credits.
 * Schema reference: stripe/stripe-node v16.2.0 types/Invoices.d.ts and
 * types/InvoiceLineItems.d.ts (2024-06-20). Never infer a rate from an amount.
 */
function validateInvoiceTaxResult(plan, invoice, verification) {
  if (!plans.has(plan) || verification?.retrievedFromStripe !== true || verification.apiVersion !== API_VERSION || verification.registrationActive !== true || verification.registrationId !== plan.registration.id || !['invoiceId','subscriptionId','customerId'].every(k => text(verification[k]))) reject();
  const period = verification.period;
  if (!period || !cents(period.start) || !cents(period.end) || period.start >= period.end) reject();
  if (!invoice || invoice.object !== 'invoice' || invoice.id !== verification.invoiceId || invoice.subscription !== verification.subscriptionId || invoice.customer !== verification.customerId || invoice.livemode !== false || invoice.status !== 'paid' || invoice.paid !== true || !['subscription_create','subscription_cycle'].includes(invoice.billing_reason) || invoice.currency !== plan.currency || invoice.automatic_tax?.enabled !== true || invoice.automatic_tax.status !== 'complete' || invoice.customer_tax_exempt !== 'none') reject();
  for (const address of [invoice.customer_address, invoice.customer_shipping?.address]) {
    if (!address || ['line1','city','state','postal_code','country'].some(k => address[k] !== plan.address[k]) || (address.line2 || undefined) !== plan.address.line2) reject();
  }
  if (!Array.isArray(invoice.total_discount_amounts) || invoice.total_discount_amounts.length !== 0) reject();
  const lines = invoice.lines;
  if (!lines || lines.has_more !== false || !Array.isArray(lines.data) || lines.data.length !== plan.checkout.line_items.length) reject();
  const found = new Set(), aggregate = new Map();
  let jarTaxAmount = 0, deliveryTaxAmount = 0, addedTaxAmount = 0;
  for (const line of lines.data) {
    const price = line?.price, product = price?.product, sku = product?.metadata?.sku;
    const expected = plan.checkout.line_items.find(l => l.price_data.product_data.metadata.sku === sku);
    if (!expected || found.has(sku)) reject();
    found.add(sku);
    const p = expected.price_data, base = p.unit_amount * expected.quantity;
    if (line.object !== 'line_item' || line.invoice !== invoice.id || line.livemode !== false || line.type !== 'subscription' || line.subscription !== verification.subscriptionId || line.proration !== false || line.currency !== plan.currency || line.period?.start !== period.start || line.period?.end !== period.end || line.quantity !== expected.quantity || line.amount !== base || price.currency !== p.currency || price.unit_amount !== p.unit_amount || price.tax_behavior !== p.tax_behavior || product.tax_code !== p.product_data.tax_code || price.recurring?.interval !== p.recurring.interval || price.recurring?.interval_count !== p.recurring.interval_count || !Array.isArray(line.discount_amounts) || line.discount_amounts.length !== 0) reject();
    const taxAmounts = readTaxAmounts(line.tax_amounts);
    let tax = 0;
    for (const [key, entry] of taxAmounts) {
      if (entry.inclusive !== (p.tax_behavior === 'inclusive')) reject();
      tax += entry.amount;
      const amount = (aggregate.get(key)?.amount || 0) + entry.amount;
      if (!cents(amount) || !cents(tax)) reject();
      aggregate.set(key, { amount, inclusive: entry.inclusive });
    }
    if (p.tax_behavior === 'inclusive' && tax > base) reject();
    if (line.amount_excluding_tax !== base - (p.tax_behavior === 'inclusive' ? tax : 0)) reject();
    if (sku === 'delivery_fee') deliveryTaxAmount += tax;
    else jarTaxAmount += tax;
    if (p.tax_behavior === 'exclusive') addedTaxAmount += tax;
  }
  const invoiceTaxes = readTaxAmounts(invoice.total_tax_amounts);
  if (invoiceTaxes.size !== aggregate.size || [...aggregate].some(([k,v]) => invoiceTaxes.get(k)?.amount !== v.amount)) reject();
  const taxAmount = jarTaxAmount + deliveryTaxAmount, amountTotal = plan.baseAmount + addedTaxAmount;
  const excluding = amountTotal - taxAmount;
  if (![taxAmount, addedTaxAmount, amountTotal, excluding].every(cents) || invoice.subtotal !== plan.baseAmount || invoice.subtotal_excluding_tax !== excluding || invoice.total_excluding_tax !== excluding || invoice.total !== amountTotal || invoice.amount_due !== amountTotal || invoice.amount_paid !== amountTotal || invoice.amount_remaining !== 0) reject();
  return freeze({ invoiceId: invoice.id, policyVersion: plan.policyVersion, behavior: plan.behavior,
    currency: plan.currency, baseAmount: plan.baseAmount, jarSubtotal: plan.jarSubtotal,
    jarTaxAmount, jarTotal: plan.jarSubtotal + (plan.behavior === 'exclusive' ? jarTaxAmount : 0),
    deliveryFee: plan.deliveryFee, deliveryTaxAmount, addedTaxAmount, taxAmount, amountTotal });
}
function readTaxAmounts(values) {
  if (!Array.isArray(values) || values.length > 100) reject();
  const result = new Map();
  for (const value of values) {
    if (!value || !cents(value.amount) || typeof value.inclusive !== 'boolean' || typeof value.tax_rate !== 'string' || !/^txr_[A-Za-z0-9_]+$/.test(value.tax_rate)) reject();
    const key = `${value.tax_rate}:${value.inclusive}`;
    if (result.has(key)) reject();
    result.set(key, { amount: value.amount, inclusive: value.inclusive });
  }
  return result;
}
module.exports = { API_VERSION, buildTaxPolicy, validateTaxResult, validateInvoiceTaxResult };
