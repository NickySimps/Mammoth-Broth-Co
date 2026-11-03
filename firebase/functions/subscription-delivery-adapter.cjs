'use strict';
const createDomain = require('./subscription-delivery.cjs');
const { API_VERSION } = createDomain;

/** Isolated factory; never imported by the production entrypoint. No environment
 * reads, deployment exports, secret binding defaults, policy writes or approvals.
 * All injected dependencies/config are trusted SERVER inputs, never request data.
 * getProjectId must read the initialized Firebase app's actual project ID.
 * Key format recognition is a guard, not proof a credential exists or is usable.
 * App Check/auth verification belongs to the real Firebase onCall wrapper; .run
 * is a local test hook only and must never be exposed as an HTTP handler.
 */
module.exports = function createSubscriptionDeliveryAdapter({ functions, Stripe, db, getConfig = () => ({}), getProjectId = () => undefined, allowedTargets = [], scheduleShipment, now }) {
  const targets = structuredClone(allowedTargets);
  const fail = (code = 'failed-precondition') => { throw new functions.https.HttpsError(code, 'Subscription transport unavailable.'); };
  const nonproduction = id => typeof id === 'string' && /^(?:demo-[a-z0-9-]+|[a-z][a-z0-9-]*-(?:test|sandbox|staging|dev))$/.test(id) && !/(?:^|-)(?:prod|production|live)(?:-|$)/.test(id);
  const secureOrigin = (value, projectId) => {
    // Deliberately excludes custom/production domains and preview channels.
    try { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password && !u.port && [ `${projectId}.web.app`, `${projectId}.firebaseapp.com` ].includes(u.hostname); } catch { return false; }
  };
  const strings = list => Array.isArray(list) && list.length > 0 && list.every(x => typeof x === 'string' && x.length > 0);
  function settings(checkout = false) {
    const c = getConfig();
    if (!c || c.enabled !== true || (checkout && c.checkoutEnabled !== true) || !nonproduction(c.projectId) || c.projectId !== getProjectId() || !secureOrigin(c.origin, c.projectId) || typeof c.secretKey !== 'string' || !/^(?:sk|rk)_test_[A-Za-z0-9]{16,256}$/.test(c.secretKey) || /\s/.test(c.secretKey)) fail();
    const matches = targets.filter(t => t.projectId === c.projectId && t.origin === c.origin);
    if (matches.length !== 1 || !strings(matches[0].appIds) || !strings(matches[0].testerUids)) fail();
    return { ...c, target: matches[0] };
  }
  function domainFor(c, checkout) {
    // Every provider operation revalidates switches, scope and key. No cached key.
    function invoke(path, args) {
      const current = settings(checkout);
      if (current.projectId !== c.projectId || current.origin !== c.origin) fail();
      const client = Stripe(current.secretKey, { apiVersion: API_VERSION, maxNetworkRetries: 0 });
      const parent = path.slice(0, -1).reduce((v, k) => v[k], client);
      return parent[path.at(-1)](...args);
    }
    const stripe = {};
    for (const path of [ ['checkout','sessions','create'], ['checkout','sessions','list'], ['subscriptions','retrieve'], ['invoices','retrieve'], ['invoices','listLineItems'], ['charges','retrieve'], ['refunds','retrieve'], ['disputes','retrieve'] ]) {
      let owner = stripe;
      for (const key of path.slice(0, -1)) owner = owner[key] ||= {};
      owner[path.at(-1)] = (...args) => invoke(path, args);
    }
    return createDomain({ db, stripe, HttpsError: functions.https.HttpsError, origin: c.origin, scheduleShipment, now });
  }
  const checkout = async (data, context) => {
    try {
      const c = settings(true);
      if (!c.target.appIds.includes(context?.app?.appId) || !c.target.testerUids.includes(context?.auth?.uid) || context?.rawRequest?.headers?.origin !== c.origin) fail('permission-denied');
      const result = await domainFor(c, true).createCheckout(data, context);
      const current = settings(true);
      if (current.projectId !== c.projectId || current.origin !== c.origin) fail();
      return result; // Recheck revocation even on cached sessions/final DB commit.
    } catch (e) {
      const code = ['permission-denied','invalid-argument','failed-precondition','unauthenticated','unavailable'].includes(e?.code) ? e.code : 'unavailable';
      fail(code); // Never return provider/domain error text, details or request data.
    }
  };
  const supportedEvents = new Set(['invoice.paid', 'invoice.payment_succeeded', 'charge.refunded', 'refund.created', 'refund.updated', 'charge.refund.updated', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated']);
  const webhook = async (request, response) => {
    if (request.method !== 'POST') return response.status(405).send('POST required');
    let c;
    try {
      c = settings();
      // A signing secret does not encode test/live mode; enforce the verified
      // event's mode/version/account separately, before any provider operation.
      if (typeof c.webhookSecret !== 'string' || !/^whsec_[A-Za-z0-9]{16,256}$/.test(c.webhookSecret) || /\s/.test(c.webhookSecret)) fail();
    } catch { return response.status(503).send('Subscription transport unavailable'); }
    let event;
    try {
      if (!Buffer.isBuffer(request.rawBody) || typeof request.headers?.['stripe-signature'] !== 'string') throw Error();
      const client = Stripe(c.secretKey, { apiVersion: API_VERSION, maxNetworkRetries: 0 });
      event = client.webhooks.constructEvent(request.rawBody, request.headers['stripe-signature'], c.webhookSecret, 300);
    } catch { return response.status(400).send('Payment event not accepted'); }
    // Only this lexical verified-event router calls the domain. Parsed body is
    // deliberately unused; no public processEvent bypass is exported.
    if (event?.object !== 'event' || event.livemode !== false || Object.hasOwn(event, 'account') || event.api_version !== API_VERSION || !/^evt_[A-Za-z0-9_]+$/.test(event.id || '') || !supportedEvents.has(event.type) || (event.data?.object?.livemode !== undefined && event.data.object.livemode !== false)) return response.status(400).send('Payment event not accepted');
    try {
      const result = await domainFor(c, false).processStripeEvent(event);
      if (!result || !(result.ignored === true || result.held === true || typeof result.created === 'boolean')) throw Error();
      return response.status(200).json({ received: true });
    } catch {
      // Unresolved verification/commit/scheduling is retryable, never a 2xx ACK.
      // Do not log payloads, provider errors, signatures, capabilities or PII.
      return response.status(500).send('Payment event processing incomplete');
    }
  };
  return {
    createCheckout: functions.runWith({ enforceAppCheck: true, timeoutSeconds: 60 }).https.onCall(checkout),
    stripeWebhook: functions.runWith({ timeoutSeconds: 60 }).https.onRequest(webhook),
  };
};
module.exports.API_VERSION = API_VERSION;
