"use strict";
const { createHash, timingSafeEqual } = require('node:crypto');
const API_VERSION = '2024-06-20';
const CATALOG = Object.freeze({ prod_beef: 2000, prod_chicken: 2000, mushroom: 4000 });
const CADENCES = Object.freeze({ weekly: { interval: 'week', interval_count: 1 }, every_two_weeks: { interval: 'week', interval_count: 2 }, monthly: { interval: 'month', interval_count: 1 } });
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);

/**
 * Isolated domain; NOT wired to the existing one-time commerce entrypoint.
 * Transport MUST verify raw Stripe signatures and enforce callable App Check.
 * Persist these collections server-only; capability is supplied BEFORE first request.
 * Policy: settings/subscriptionDelivery, explicitly approved_no_tax ONLY in this version.
 * scheduleShipment is a PURE trusted server scheduling adapter, never a client callback.
 * It receives {paidAt, periodStart, periodEnd, cadence, policy, zoneId, ...binding}
 * and returns {cutoffAt, deliveryAt} in epoch milliseconds, or null for reconciliation.
 * Do not reserve inventory/send mail/dispatch inside it: concurrent webhook calls can repeat it.
 * All provider reads/writes are pinned to API_VERSION; newer invoice schemas fail closed.
 *
 * Integration contract (this file deliberately exports no deployed callable):
 * - createCheckout({requestId, capability, cart, cadence, deliveryAddress,
 *   customerName, customerEmail}, verifiedFirebaseContext).
 *   Capability: pre-generated cryptographically random 32 bytes, lowercase hex; persist
 *   in browser sessionStorage before first call and reuse the exact request on retry.
 * - processStripeEvent(verifiedEvent): invoke after existing raw-body signature verification;
 *   handle invoice.paid / invoice.payment_succeeded, never fulfill from checkout redirects.
 * - Inject the FULL Stripe SDK surface (sessions.create/list, subscriptions.retrieve,
 *   invoices.retrieve/listLineItems), not the existing one-time-only adapter.
 * - Use TEST credentials only. The injected client's key cannot be inspected here;
 *   policy.testMode and returned livemode checks do NOT make a live credential safe.
 * - Configure the webhook destination itself to 2024-06-20; per-request apiVersion
 *   does not change the destination event schema.
 * - settings/subscriptionDelivery must explicitly enable testMode, a version,
 *   tax:{ready:true, mode:'approved_no_tax', approvalReference},
 *   scheduling:{ready:true, version}, zones:[{id,state,allowedZips,feeCents}].
 *   No default geography, fee, tax exemption, scheduling rule or business approval exists.
 * - Deny ALL browser access to deliverySubscriptions / subscriptionShipments /
 *   subscriptionPaymentHolds / subscriptionPeriods.
 *   These are isolated collections, NOT the legacy orders/admin/email pipeline.
 * - Paid-invoice fields are immutable; verified adverse payments may move a scheduled
 *   outbox record to needs_reconciliation, never rewrite fulfilled history.
 *   A future dispatcher MUST transactionally check shipment status AND the absence of
 *   subscriptionPaymentHolds with its own dispatch lease, before any external action.
 *   Already-dispatched deliveries cannot be recalled here. Do not integrate without this fence.
 * - Refund/dispute events require charges/refunds/disputes.retrieve on the test adapter.
 *   Unresolved verification throws: transport MUST retry/escalate, never acknowledge it as handled.
 *   Holds never auto-release (even dispute closure/win); release requires operator policy.
 * - subscriptionPeriods atomically retains up to 512 disjoint paid periods per subscription.
 *   Missing legacy ledgers, malformed/full ledgers, overlaps and implausible cadences
 *   preserve paid invoices as reconciliation, never auto-prune history or promise dispatch.
 * - No customer portal/cancellation, tax calculation, capacity reservation, operator alert,
 *   financial refund/dispute resolution or browser UI is supplied. Reconciliation/verification errors
 *   require an operator-owned handling path before activation. Do not enable production.
 */
module.exports = function createSubscriptionDelivery({ db, stripe, HttpsError = Error, now = Date.now, origin, scheduleShipment }) {
  const fail = (code, message) => { const e = new HttpsError(code, message); e.code = code; throw e; };
  const ref = (collection, id) => db.collection(collection).doc(id);
  const text = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
  function normalize(data, context) {
    if (!context?.app?.appId) fail('unauthenticated', 'Verified application required.');
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['requestId','capability','cart','cadence','deliveryAddress','customerName','customerEmail'].includes(k))) fail('invalid-argument','Unsupported checkout fields.');
    if (!data || !/^[-\w]{16,100}$/.test(data.requestId || '') || !/^[a-f0-9]{64}$/.test(data.capability || '')) fail('invalid-argument', 'Request ID and pre-generated capability required.');
    const cart = data.cart;
    if (!cart || typeof cart !== 'object' || Array.isArray(cart)) fail('invalid-argument', 'Cart required.');
    const entries = Object.entries(cart).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length || entries.some(([id,q]) => !Object.hasOwn(CATALOG,id) || !Number.isSafeInteger(q) || q < 1 || q > 12)) fail('invalid-argument', 'Unsupported product or quantity.');
    const count = entries.reduce((sum,[,q]) => sum + q, 0);
    if (count < 6 || count > 12 || !Object.hasOwn(CADENCES,data.cadence)) fail('invalid-argument', 'Choose 6–12 jars and a supported cadence.');
    const a = data.deliveryAddress;
    if (!a || !['street','city','state','zip'].every(k => text(a[k],200) && a[k].trim()) || !/^\d{5}$/.test(a.zip)) fail('invalid-argument', 'Complete US delivery address required.');
    if (!text(data.customerName,120) || !data.customerName.trim() || !text(data.customerEmail,200) || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(data.customerEmail)) fail('invalid-argument', 'Name and single email address required.');
    return { cart: Object.fromEntries(entries), cadence: data.cadence, deliveryAddress: Object.fromEntries(['street','city','state','zip'].map(k => [k,a[k].trim()])), customerName: data.customerName.trim(), customerEmail: data.customerEmail.toLowerCase(), uid: context.auth?.uid || null };
  }
  function approvedPolicy(policy, input) {
    if (policy?.enabled !== true || policy.testMode !== true || !text(policy.version,100) || policy.tax?.ready !== true || policy.tax.mode !== 'approved_no_tax' || !text(policy.tax.approvalReference,200) || policy.scheduling?.ready !== true || !text(policy.scheduling.version,100) || typeof scheduleShipment !== 'function') fail('failed-precondition', 'Subscription delivery policy is not ready.');
    const zips = new Set(), zoneIds = new Set();
    if (!Array.isArray(policy.zones) || !policy.zones.length || policy.zones.some(z => {
      if (!z || !text(z.id,100) || zoneIds.has(z.id) || !/^[A-Z]{2}$/.test(z.state || '') || !Number.isSafeInteger(z.feeCents) || z.feeCents < 0 || z.feeCents > 100000 || !Array.isArray(z.allowedZips) || !z.allowedZips.length) return true;
      zoneIds.add(z.id);
      return z.allowedZips.some(zip => { if (typeof zip !== 'string' || !/^\d{5}$/.test(zip) || zips.has(zip)) return true; zips.add(zip); return false; });
    })) fail('failed-precondition', 'Delivery zones are not configured.');
    const zone = policy.zones.find(z => z.allowedZips.includes(input.deliveryAddress.zip));
    if (!zone || input.deliveryAddress.state !== zone.state) fail('failed-precondition', 'Address is outside configured delivery zones.');
    return zone;
  }
  function authorize(saved, data, input) {
    const supplied = Buffer.from(hash(data.capability),'hex');
    const expected = Buffer.from(saved.capabilityHash,'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected,supplied) || saved.inputHash !== hash(stable(input)) || saved.revokedAt || now() >= saved.capabilityExpiresAt) fail('permission-denied','Subscription attempt is unavailable.');
  }
  function response(saved) {
    if (saved.subscriptionId || saved.session.status !== 'open' || !Number.isSafeInteger(saved.session.expires_at) || saved.session.expires_at*1000 <= now()) fail('failed-precondition','Checkout is no longer open.');
    return { subscriptionOrderId: saved.id, checkoutSessionId: saved.session.id, checkoutUrl: saved.session.url, expiresAt: saved.session.expires_at * 1000, amountPerDelivery: saved.terms.amount, currency: 'usd' };
  }
  async function createCheckout(data, context) {
    const input = normalize(data,context);
    let root;
    try { root = new URL(origin); if (root.protocol !== 'https:' || root.username || root.password || root.pathname !== '/' || root.search || root.hash) throw Error(); } catch { fail('failed-precondition','Secure storefront origin required.'); }
    const id = `ds_${hash(data.requestId)}`;
    const orderRef = ref('deliverySubscriptions',id);
    const saved = await db.runTransaction(async tx => {
      const old = (await tx.get(orderRef)).data();
      if (old) authorize(old,data,input);
      const policy = (await tx.get(ref('settings','subscriptionDelivery'))).data();
      const zone = approvedPolicy(policy,input);
      if (old) return old; // Current permission, frozen original prices.
      const terms = { ...input, interval: CADENCES[input.cadence], zoneId: zone.id, feeCents: zone.feeCents, lines: Object.entries(input.cart).map(([sku,quantity]) => ({ sku, quantity, unitAmount: CATALOG[sku] })), policy: structuredClone(policy) };
      terms.lines.push({ sku: 'delivery_fee', quantity: 1, unitAmount: zone.feeCents });
      terms.amount = terms.lines.reduce((n,l) => n + l.unitAmount*l.quantity,0);
      const termsHash = hash(stable(terms));
      const metadata = { delivery_order_id: id, delivery_terms_hash: termsHash };
      const createdAt = now();
      const createParams = { mode: 'subscription', client_reference_id: id, customer_email: input.customerEmail, payment_method_types: ['card'], allow_promotion_codes: false, automatic_tax: { enabled: false }, expires_at: Math.floor(createdAt/1000)+3600, metadata, subscription_data: { metadata }, success_url: `${root.origin}/subscription.html#${id}`, cancel_url: `${root.origin}/subscription.html#${id}`, line_items: terms.lines.map(l => ({ quantity: l.quantity, price_data: { currency: 'usd', unit_amount: l.unitAmount, recurring: terms.interval, tax_behavior: 'exclusive', product_data: { name: l.sku === 'delivery_fee' ? 'Recurring local delivery' : l.sku, metadata: { delivery_sku: l.sku } } } })) };
      const record = { id, inputHash: hash(stable(input)), capabilityHash: hash(data.capability), capabilityExpiresAt: createdAt+23*3600000, createdAt, terms, termsHash, createParams, session: null, subscriptionId: null, customerId: null };
      tx.create(orderRef,record); return record;
    });
    if (saved.session) return response(saved);
    let session;
    try { session = await stripe.checkout.sessions.create(saved.createParams,{ idempotencyKey: `delivery:${id}`, apiVersion: API_VERSION }); } catch { fail('unavailable','Subscription checkout setup failed; retry the same attempt.'); }
    let checkoutUrl;
    try { checkoutUrl = new URL(session?.url); } catch { fail('failed-precondition','Unexpected checkout response.'); }
    if (!session || session.object !== 'checkout.session' || session.livemode !== false || session.mode !== 'subscription' || !/^cs_[A-Za-z0-9_]+$/.test(session.id || '') || session.client_reference_id !== saved.id || !sameMetadata(session.metadata,saved) || session.expires_at !== saved.createParams.expires_at || checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com' || checkoutUrl.username || checkoutUrl.password || checkoutUrl.port) fail('failed-precondition','Unexpected checkout response.');
    const final = await db.runTransaction(async tx => {
      const current = (await tx.get(orderRef)).data();
      authorize(current,data,input);
      approvedPolicy((await tx.get(ref('settings','subscriptionDelivery'))).data(),input);
      if (current.session && current.session.id !== session.id) fail('failed-precondition','Conflicting checkout binding.');
      tx.update(orderRef,{ session }); return { ...current, session };
    });
    return response(final);
  }
  const objectId = value => typeof value === 'string' ? value : value?.id;
  const sameMetadata = (metadata, saved) => metadata?.delivery_order_id === saved.id && metadata.delivery_terms_hash === saved.termsHash;
  const empty = value => value == null || (Array.isArray(value) && value.length === 0);
  const seconds = value => Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value*1000);
  const rejectPayment = () => fail('failed-precondition','Subscription payment verification failed.');
  const adverseTypes = new Set(['charge.refunded','refund.created','refund.updated','charge.refund.updated','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated']);
  async function persistPaymentHold(event, saved, session, binding) {
    const { subscriptionOrderId: id, invoiceId, subscriptionId: subId, customerId } = binding;
    return db.runTransaction(async tx => {
      const current = (await tx.get(ref('deliverySubscriptions',id))).data();
      const shipmentRef = ref('subscriptionShipments',invoiceId), holdRef = ref('subscriptionPaymentHolds',invoiceId);
      const shipment = (await tx.get(shipmentRef)).data(), hold = (await tx.get(holdRef)).data();
      if (!current || current.termsHash !== saved.termsHash || hash(stable(current.terms)) !== saved.termsHash || (current.subscriptionId && current.subscriptionId !== subId) || (current.customerId && current.customerId !== customerId) || (current.session && current.session.id !== session.id) || [shipment,hold].some(record => record && Object.entries(binding).some(([k,v]) => record[k] !== v))) rejectPayment();
      if (!hold) tx.create(holdRef,{ ...binding, held: true, reason: 'refund_or_dispute', firstEventId: event.id });
      // Never rewrite fulfilled history; the independent hold still fences future dispatch.
      if (shipment?.fulfillmentStatus === 'scheduled') tx.update(shipmentRef,{ fulfillmentStatus: 'needs_reconciliation', reconciliationReason: 'refund_or_dispute', deliveryAt: null, cutoffAt: null });
      return { held: true, shipmentId: invoiceId };
    });
  }
  async function holdPayment(event) {
    const raw = event.data?.object;
    if (event.api_version !== API_VERSION || event.livemode !== false || event.account || !/^evt_[A-Za-z0-9_]+$/.test(event.id || '')) rejectPayment();
    try {
      const kind = event.type.startsWith('charge.dispute.') ? 'dispute' : event.type === 'charge.refunded' ? 'charge' : 'refund';
      const prefix = { dispute: 'dp_', charge: 'ch_', refund: 're_' }[kind];
      if (raw?.object !== kind || typeof raw.id !== 'string' || !raw.id.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(raw.id)) rejectPayment();
      const source = await stripe[{ charge: 'charges', dispute: 'disputes', refund: 'refunds' }[kind]].retrieve(raw.id,{}, { apiVersion: API_VERSION });
      // Refunds have no livemode field. The verified test event and retrieved
      // bound test Charge establish mode; Disputes and Charges carry it themselves.
      if (source?.id !== raw.id || source.object !== kind || (kind !== 'refund' && source.livemode !== false)) rejectPayment();
      const chargeId = kind === 'charge' ? source.id : objectId(source.charge);
      if (!/^ch_[A-Za-z0-9_]+$/.test(chargeId || '') || (kind !== 'charge' && objectId(raw.charge) !== chargeId)) rejectPayment();
      const charge = kind === 'charge' ? source : await stripe.charges.retrieve(chargeId,{}, { apiVersion: API_VERSION });
      if (charge?.object !== 'charge' || charge.id !== chargeId || charge.livemode !== false || charge.paid !== true || charge.status !== 'succeeded' || (kind === 'charge' && !(Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded > 0))) rejectPayment();
      if (kind !== 'charge' && (!Number.isSafeInteger(source.amount) || source.amount <= 0 || source.amount > charge.amount || source.currency !== charge.currency || objectId(source.payment_intent) !== objectId(charge.payment_intent))) rejectPayment();
      const invoiceId = objectId(charge.invoice);
      if (!/^in_[A-Za-z0-9_]+$/.test(invoiceId || '')) rejectPayment(); // Never acknowledge an unresolved binding.
      const invoice = await stripe.invoices.retrieve(invoiceId,{ expand: ['payment_intent','charge'] },{ apiVersion: API_VERSION });
      const id = invoice?.subscription_details?.metadata?.delivery_order_id;
      if (!id) return { ignored: true };
      if (!/^ds_[a-f0-9]{64}$/.test(id)) rejectPayment();
      const saved = await db.runTransaction(async tx => (await tx.get(ref('deliverySubscriptions',id))).data());
      const subId = objectId(invoice.subscription), customerId = objectId(invoice.customer), piId = objectId(invoice.payment_intent);
      if (!saved || hash(stable(saved.terms)) !== saved.termsHash || !sameMetadata(invoice.subscription_details.metadata,saved) || invoice.id !== invoiceId || invoice.object !== 'invoice' || invoice.livemode !== false || invoice.paid !== true || invoice.status !== 'paid' || invoice.currency !== 'usd' || charge.currency !== 'usd' || charge.amount !== saved.terms.amount || invoice.amount_paid !== saved.terms.amount || objectId(invoice.charge) !== chargeId || objectId(charge.customer) !== customerId || objectId(charge.payment_intent) !== piId || !/^pi_[A-Za-z0-9_]+$/.test(piId || '') || !/^sub_[A-Za-z0-9_]+$/.test(subId || '') || !/^cus_[A-Za-z0-9_]+$/.test(customerId || '') || (kind !== 'charge' && source.payment_intent && objectId(source.payment_intent) !== piId)) rejectPayment();
      const subscription = await stripe.subscriptions.retrieve(subId,{}, { apiVersion: API_VERSION });
      const found = await stripe.checkout.sessions.list({ subscription: subId, limit: 2 },{ apiVersion: API_VERSION });
      const session = found?.data?.[0];
      if (subscription?.object !== 'subscription' || subscription.id !== subId || subscription.livemode !== false || objectId(subscription.customer) !== customerId || !sameMetadata(subscription.metadata,saved) || found.has_more !== false || found.data.length !== 1 || session?.object !== 'checkout.session' || session.livemode !== false || session.mode !== 'subscription' || session.status !== 'complete' || objectId(session.subscription) !== subId || objectId(session.customer) !== customerId || session.client_reference_id !== id || !sameMetadata(session.metadata,saved)) rejectPayment();
      return await persistPaymentHold(event,saved,session,{ subscriptionOrderId: id, invoiceId, subscriptionId: subId, customerId, chargeId, paymentIntentId: piId, termsHash: saved.termsHash });
    } catch (e) {
      if (e.code === 'failed-precondition') throw e;
      fail('unavailable','Payment hold verification unresolved; retry required.');
    }
  }
  async function processStripeEvent(event) {
    // Called ONLY after the existing entrypoint verifies the raw-body signature.
    if (adverseTypes.has(event?.type)) return holdPayment(event);
    if (!['invoice.paid','invoice.payment_succeeded'].includes(event?.type)) return { ignored: true };
    if (event.api_version !== API_VERSION || event.livemode !== false || event.account || !/^evt_[A-Za-z0-9_]+$/.test(event.id || '') || event.data?.object?.object !== 'invoice' || !/^in_[A-Za-z0-9_]+$/.test(event.data.object.id || '')) rejectPayment();
    const invoiceId = event.data.object.id;
    let invoice, subscription, session, lines, saved;
    try {
      invoice = await stripe.invoices.retrieve(invoiceId,{ expand: ['payment_intent','charge'] },{ apiVersion: API_VERSION });
      if (invoice?.id !== invoiceId || invoice.object !== 'invoice') rejectPayment();
      const id = invoice.subscription_details?.metadata?.delivery_order_id;
      // Unrelated one-time invoices may be routed here by the shared webhook.
      if (!id) return { ignored: true };
      if (!/^ds_[a-f0-9]{64}$/.test(id)) rejectPayment();
      saved = await db.runTransaction(async tx => (await tx.get(ref('deliverySubscriptions',id))).data());
      if (!saved || hash(stable(saved.terms)) !== saved.termsHash || !sameMetadata(invoice.subscription_details.metadata,saved)) rejectPayment();
      const subId = objectId(invoice.subscription);
      if (!/^sub_[A-Za-z0-9_]+$/.test(subId || '')) rejectPayment();
      subscription = await stripe.subscriptions.retrieve(subId,{}, { apiVersion: API_VERSION });
      const found = await stripe.checkout.sessions.list({ subscription: subId, limit: 2 },{ apiVersion: API_VERSION });
      if (found?.has_more !== false || !Array.isArray(found.data) || found.data.length !== 1) rejectPayment();
      session = found.data[0];
    } catch (e) {
      if (e.code === 'failed-precondition') throw e;
      fail('unavailable','Subscription verification is temporarily unavailable.');
    }
    const amount = saved.terms.amount;
    const subId = objectId(invoice.subscription), customerId = objectId(invoice.customer);
    const pi = invoice.payment_intent, charge = invoice.charge;
    if (pi?.object !== 'payment_intent' || !/^pi_[A-Za-z0-9_]+$/.test(pi.id || '') || pi.livemode !== false || pi.status !== 'succeeded' || pi.currency !== 'usd' || pi.amount !== amount || pi.amount_received !== amount || objectId(pi.customer) !== customerId || objectId(pi.invoice) !== invoiceId || charge?.object !== 'charge' || !/^ch_[A-Za-z0-9_]+$/.test(charge.id || '') || charge.livemode !== false || charge.status !== 'succeeded' || charge.paid !== true || charge.captured !== true || charge.amount !== amount || charge.currency !== 'usd' || objectId(charge.invoice) !== invoiceId || objectId(charge.customer) !== customerId || objectId(charge.payment_intent) !== pi.id || objectId(pi.latest_charge) !== charge.id) rejectPayment();
    if (subscription?.object !== 'subscription' || subscription.id !== subId || subscription.livemode !== false || objectId(subscription.customer) !== customerId || !sameMetadata(subscription.metadata,saved) || session?.object !== 'checkout.session' || session.mode !== 'subscription' || session.livemode !== false || session.status !== 'complete' || !/^cs_[A-Za-z0-9_]+$/.test(session.id || '') || objectId(session.subscription) !== subId || objectId(session.customer) !== customerId || session.client_reference_id !== saved.id || !sameMetadata(session.metadata,saved) || (saved.session && saved.session.id !== session.id) || (saved.subscriptionId && saved.subscriptionId !== subId) || (saved.customerId && saved.customerId !== customerId)) rejectPayment();
    if (invoice.livemode !== false || invoice.status !== 'paid' || invoice.paid !== true || invoice.currency !== 'usd' || invoice.amount_paid !== amount) rejectPayment();
    if (charge.refunded === true || charge.disputed === true || (Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded > 0)) {
      // Stable provider identities and paid amounts are verified above. Fence BEFORE
      // mutable billing policy/line/scheduler checks, including duplicate paid events.
      await persistPaymentHold(event,saved,session,{ subscriptionOrderId: saved.id, invoiceId, subscriptionId: subId, customerId, chargeId: charge.id, paymentIntentId: pi.id, termsHash: saved.termsHash });
      rejectPayment(); // A hold is not fulfillment authorization, even for a first paid event.
    }
    if (charge.refunded !== false || charge.disputed !== false || charge.amount_refunded !== 0) rejectPayment();
    if (invoice.livemode !== false || invoice.status !== 'paid' || invoice.paid !== true || invoice.paid_out_of_band !== false || invoice.collection_method !== 'charge_automatically' || !['subscription_create','subscription_cycle'].includes(invoice.billing_reason) || invoice.currency !== 'usd' || invoice.amount_paid !== amount || invoice.amount_due !== amount || invoice.total !== amount || invoice.subtotal !== amount || invoice.amount_remaining !== 0 || invoice.starting_balance !== 0 || ![0,null].includes(invoice.ending_balance) || invoice.pre_payment_credit_notes_amount !== 0 || invoice.post_payment_credit_notes_amount !== 0 || !empty(invoice.total_discount_amounts) || !empty(invoice.discounts) || !empty(invoice.total_tax_amounts) || invoice.automatic_tax?.enabled === true || invoice.amount_shipping !== 0 || !/^cus_[A-Za-z0-9_]+$/.test(customerId || '') || !seconds(invoice.status_transitions?.paid_at) || invoice.status_transitions.paid_at*1000 > now()+300000) rejectPayment();
    try { lines = await stripe.invoices.listLineItems(invoiceId,{ limit: 100, expand: ['data.price.product'] },{ apiVersion: API_VERSION }); }
    catch { fail('unavailable','Subscription verification is temporarily unavailable.'); }
    if (lines?.has_more !== false || !Array.isArray(lines.data) || lines.data.length !== saved.terms.lines.length) rejectPayment();
    const seen = new Set(); let period;
    for (const line of lines.data) {
      const price = line.price, sku = price?.product?.metadata?.delivery_sku;
      const expected = saved.terms.lines.find(l => l.sku === sku);
      if (!expected || seen.has(sku) || line.type !== 'subscription' || objectId(line.subscription) !== subId || !/^si_[A-Za-z0-9_]+$/.test(objectId(line.subscription_item) || '') || line.proration !== false || line.currency !== 'usd' || line.quantity !== expected.quantity || line.amount !== expected.quantity*expected.unitAmount || !empty(line.discount_amounts) || !empty(line.tax_amounts) || price.type !== 'recurring' || price.currency !== 'usd' || price.unit_amount !== expected.unitAmount || price.recurring?.interval !== saved.terms.interval.interval || price.recurring.interval_count !== saved.terms.interval.interval_count || price.recurring.usage_type !== 'licensed' || !seconds(line.period?.start) || !seconds(line.period?.end) || line.period.end <= line.period.start || (period && (period.start !== line.period.start || period.end !== line.period.end))) rejectPayment();
      seen.add(sku); period = line.period;
    }
    const paidAt = invoice.status_transitions.paid_at*1000;
    // Sanity bounds only, not a delivery policy: exact provider endpoints are retained.
    // Calendar months vary 28–31 days; allow at most one DST hour in either direction.
    const duration = period.end-period.start;
    const days = saved.terms.cadence === 'monthly' ? [28,31] : saved.terms.cadence === 'weekly' ? [7,7] : [14,14];
    const cadenceValid = duration >= days[0]*86400-3600 && duration <= days[1]*86400+3600;
    const immutablePayment = { subscriptionOrderId: saved.id, invoiceId, subscriptionId: subId, customerId, paymentIntentId: pi.id, chargeId: charge.id, termsHash: saved.termsHash, currency: 'usd', amountPaid: amount, periodStart: period.start*1000, periodEnd: period.end*1000, paidAt };
    const paymentHash = hash(stable(immutablePayment));
    const shipmentRef = ref('subscriptionShipments',invoiceId);
    const periodsRef = ref('subscriptionPeriods',subId);
    function periodIssue(current, ledger) {
      if (!cadenceValid) return 'implausible_billing_period';
      const valid = ledger ? ledger.subscriptionOrderId === saved.id && Array.isArray(ledger.periods) && ledger.periods.length <= 512 && ledger.periods.every(p => p && /^in_[A-Za-z0-9_]+$/.test(p.invoiceId || '') && seconds(p.start) && seconds(p.end) && p.end > p.start) : !current?.subscriptionId;
      if (!valid) return 'period_ledger_unavailable';
      if (ledger?.periods.some(p => period.start < p.end && period.end > p.start)) return 'overlapping_billing_period';
      return ledger?.periods.length >= 512 ? 'period_ledger_capacity' : null;
    }
    // Replays preserve history. A known paid exception must not depend on scheduler uptime.
    const preflight = await db.runTransaction(async tx => ({
      prior: (await tx.get(shipmentRef)).data(),
      current: (await tx.get(ref('deliverySubscriptions',saved.id))).data(),
      ledger: (await tx.get(periodsRef)).data(),
      hold: (await tx.get(ref('subscriptionPaymentHolds',invoiceId))).data(),
    }));
    if (preflight.prior) { if (preflight.prior.paymentHash !== paymentHash) rejectPayment(); return { created: false, shipmentId: invoiceId }; }
    let schedule;
    try { if (!preflight.hold && !periodIssue(preflight.current,preflight.ledger)) schedule = await scheduleShipment({ ...immutablePayment, cadence: saved.terms.cadence, policy: structuredClone(saved.terms.policy), zoneId: saved.terms.zoneId }); }
    catch { fail('unavailable','Paid invoice scheduling needs retry.'); }
    const valid = schedule && Number.isSafeInteger(schedule.cutoffAt) && Number.isSafeInteger(schedule.deliveryAt) && schedule.cutoffAt >= paidAt && now() <= schedule.cutoffAt && schedule.deliveryAt > schedule.cutoffAt && schedule.deliveryAt > now();
    const shipment = { ...immutablePayment, paymentHash, paymentStatus: 'paid', fulfillmentStatus: valid ? 'scheduled' : 'needs_reconciliation', reconciliationReason: valid ? null : 'scheduling_unavailable_after_payment', deliveryAt: valid ? schedule.deliveryAt : null, cutoffAt: valid ? schedule.cutoffAt : null, cart: structuredClone(saved.terms.cart), deliveryAddress: structuredClone(saved.terms.deliveryAddress), customerName: saved.terms.customerName, customerEmail: saved.terms.customerEmail, uid: saved.terms.uid, zoneId: saved.terms.zoneId, feeCents: saved.terms.feeCents };
    return db.runTransaction(async tx => {
      const existing = (await tx.get(shipmentRef)).data();
      const current = (await tx.get(ref('deliverySubscriptions',saved.id))).data();
      const hold = (await tx.get(ref('subscriptionPaymentHolds',invoiceId))).data();
      const ledger = (await tx.get(periodsRef)).data();
      const periodReason = periodIssue(current,ledger);
      if (periodReason) Object.assign(shipment,{ fulfillmentStatus: 'needs_reconciliation', reconciliationReason: periodReason, deliveryAt: null, cutoffAt: null });
      if (hold) {
        if (['subscriptionOrderId','invoiceId','subscriptionId','customerId','paymentIntentId','chargeId','termsHash'].some(k => hold[k] !== immutablePayment[k])) rejectPayment();
        Object.assign(shipment,{ fulfillmentStatus: 'needs_reconciliation', reconciliationReason: 'refund_or_dispute', deliveryAt: null, cutoffAt: null });
      }
      if (!current || current.termsHash !== saved.termsHash || (current.subscriptionId && current.subscriptionId !== subId) || (current.customerId && current.customerId !== customerId) || (current.session && current.session.id !== session.id)) rejectPayment();
      if (existing) { if (existing.paymentHash !== paymentHash) rejectPayment(); return { created: false, shipmentId: invoiceId }; }
      if (shipment.fulfillmentStatus === 'scheduled' && (now() > shipment.cutoffAt || now() >= shipment.deliveryAt)) Object.assign(shipment,{ fulfillmentStatus: 'needs_reconciliation', reconciliationReason: 'scheduling_unavailable_after_payment', deliveryAt: null, cutoffAt: null });
      tx.create(shipmentRef,shipment);
      if (!periodReason) {
        const next = { subscriptionOrderId: saved.id, periods: [...(ledger?.periods || []),{ invoiceId, start: period.start, end: period.end }] };
        if (ledger) tx.update(periodsRef,next); else tx.create(periodsRef,next);
      }
      tx.update(ref('deliverySubscriptions',saved.id),{ subscriptionId: subId, customerId, session: current.session || session });
      return { created: true, shipmentId: invoiceId, fulfillmentStatus: shipment.fulfillmentStatus };
    });
  }
  return { createCheckout, processStripeEvent };
};
module.exports.API_VERSION = API_VERSION;
