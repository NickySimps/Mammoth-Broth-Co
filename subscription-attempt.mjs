// Inert helper for the future test-only checkout. No provider calls are made here.
// Capabilities remain in sessionStorage and must never be placed in a URL.
const ACTIVE = 'mammoth.subscription.active.v1';
const PREFIX = 'mammoth.subscription.attempt.v1.';
const FIELDS = ['cart', 'cadence', 'deliveryAddress', 'customerName', 'customerEmail'];
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

export function createSubscriptionAttempt({ storage, crypto, uid = null }) {
  if (!storage || !crypto?.getRandomValues || (uid !== null && (typeof uid !== 'string' || !uid))) throw new Error('Secure checkout recovery is unavailable.');
  function randomHex() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
  function read(key) { try { return storage.getItem(key); } catch { throw new Error('Secure checkout recovery is unavailable.'); } }
  function write(key, value) { try { storage.setItem(key, value); if (storage.getItem(key) !== value) throw new Error(); } catch { throw new Error('Secure checkout recovery is unavailable.'); } }
  return {
    async prepare(input, createCheckout) {
      if (!input || typeof input !== 'object' || typeof createCheckout !== 'function' || Object.keys(input).some(k => !FIELDS.includes(k)) || FIELDS.some(k => !(k in input))) throw new Error('Invalid subscription details.');
      // Serialize and clone before any async boundary; the backend validates actual fields.
      const details = JSON.parse(stable(Object.fromEntries(FIELDS.map(k => [k, input[k]]))));
      const signature = stable({ uid, details });
      let active = read(ACTIVE), record = null;
      if (active && /^[a-f0-9]{64}$/.test(active)) {
        try { record = JSON.parse(read(PREFIX + active) || 'null'); } catch { record = null; }
      }
      if (!record || record.signature !== signature || record.requestId !== active || !/^[a-f0-9]{64}$/.test(record.capability || '')) {
        record = { requestId: randomHex(), capability: randomHex(), signature, details };
        if (record.requestId === record.capability) throw new Error('Secure checkout recovery is unavailable.');
        write(PREFIX + record.requestId, JSON.stringify(record));
        write(ACTIVE, record.requestId);
      }
      const payload = { requestId: record.requestId, capability: record.capability, ...record.details };
      const result = await createCheckout(payload);
      if (read(ACTIVE) !== record.requestId || read(PREFIX + record.requestId) !== JSON.stringify(record)) throw new Error('Checkout details changed. Please review your order.');
      if (!crypto.subtle?.digest) throw new Error('Secure checkout recovery is unavailable.');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.requestId));
      const expectedId = 'ds_' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (read(ACTIVE) !== record.requestId || read(PREFIX + record.requestId) !== JSON.stringify(record)) throw new Error('Checkout details changed. Please review your order.');
      let url;
      try { url = new URL(result?.checkoutUrl); } catch { throw new Error('Unexpected checkout response.'); }
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password || url.port || result?.subscriptionOrderId !== expectedId || !/^cs_[A-Za-z0-9_]+$/.test(result?.checkoutSessionId || '') || result.currency !== 'usd' || !Number.isSafeInteger(result.amountPerDelivery) || result.amountPerDelivery <= 0 || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error('Unexpected checkout response.');
      // Return only navigation data. Successful navigation is not evidence of payment.
      return { subscriptionOrderId: result.subscriptionOrderId, checkoutUrl: url.href, expiresAt: result.expiresAt, amountPerDelivery: result.amountPerDelivery, currency: result.currency };
    }
  };
}
