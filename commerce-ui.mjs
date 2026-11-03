// Receipt capabilities belong in memory/session storage, never query strings or logs.
const RECEIPT_KEY = 'mammothGuestReceipt';
export const formatMoney = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export function deliveryEligibility(policy, jars, address = {}) {
  // This is only an early UX guard. The callable revalidates policy and prices.
  const approved = {
    jacksonville: { feeCents: 1000, zips: ['32204', '32205'] },
    surrounding: { feeCents: 1500, zips: ['32233', '32082'] },
  };
  const seenZones = new Set(), seenZips = new Set();
  const validZones = Array.isArray(policy?.zones) && policy.zones.length === 2 && policy.zones.every(zone => {
    const tier = zone && Object.hasOwn(approved, zone.id) && approved[zone.id];
    if (!tier || seenZones.has(zone.id) || zone.feeCents !== tier.feeCents || !Array.isArray(zone.allowedZips) || !zone.allowedZips.length) return false;
    seenZones.add(zone.id);
    return zone.allowedZips.every(zip => {
      if (typeof zip !== 'string' || !/^\d{5}$/.test(zip) || !tier.zips.includes(zip) || seenZips.has(zip)) return false;
      seenZips.add(zip);
      return true;
    });
  });
  if (policy?.enabled !== true || !validZones || policy.allowedZips !== undefined || policy.feeCents !== undefined || policy.state !== 'FL' || !Number.isSafeInteger(policy.minimumJars) || policy.minimumJars < 6 || policy.minimumJars > 12 || !Number.isSafeInteger(policy.cutoffHours) || policy.cutoffHours < 0 || policy.cutoffHours > 168) return 'Local delivery is not configured for a service area yet. Choose market pickup or contact us.';
  if (jars < policy.minimumJars) return `Local delivery requires at least ${policy.minimumJars} jars.`;
  if (['street', 'city', 'state', 'zip'].some(key => !String(address?.[key] || '').trim())) return 'Enter the complete delivery address to check eligibility.';
  if (String(address.state).trim() !== policy.state || !policy.zones.some(zone => zone.allowedZips.includes(String(address.zip).trim()))) return 'This address is outside our configured delivery area. Choose market pickup or contact us.';
  return '';
}
export function deliveryQuoteText(quote, policy) {
  const date = new Date(`${quote?.deliveryDate}T00:00:00Z`);
  if (!Number.isSafeInteger(quote?.deliveryFee) || quote.deliveryFee < 0 || !Number.isSafeInteger(quote.totalAmount) || quote.totalAmount < quote.deliveryFee || !/^\d{4}-\d{2}-\d{2}$/.test(quote.deliveryDate || '') || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== quote.deliveryDate || date.getUTCDay() !== 1) throw new Error('A valid server delivery quote is required before payment.');
  return `Delivery fee ${formatMoney(quote.deliveryFee)} · Monday ${quote.deliveryDate} · Total ${formatMoney(quote.totalAmount)}. Cutoff: ${policy.cutoffHours} hours before Monday 00:00 UTC; later orders move to the following Monday. Details are rechecked before payment.`;
}
export function buildSpecialReview(claims, orderId, decision, items = []) {
  if (claims?.admin !== true) throw new Error('Explicit admin permission required.');
  if (!orderId || !['approve', 'decline'].includes(decision)) throw new Error('Choose an order and review decision.');
  if (decision === 'decline') return { orderId, decision };
  if (!items.length) throw new Error('Add at least one reviewed item.');
  const reviewed = items.map(item => {
    if (!String(item.productId || '').trim() || !String(item.name || '').trim()) throw new Error('Every item needs a product ID and name.');
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error('Every quantity must be a positive whole number.');
    if (!Number.isSafeInteger(item.price) || item.price < 1) throw new Error('Every price must be a positive integer in cents.');
    return { productId: item.productId, name: item.name, quantity: item.quantity, price: item.price };
  });
  const totalAmount = reviewed.reduce((sum, item) => sum + item.quantity * item.price, 0);
  if (!Number.isSafeInteger(totalAmount)) throw new Error('Reviewed price exceeds supported range.');
  return { orderId, decision, items: reviewed, totalAmount };
}
export function createCheckoutRevision(uuid = () => globalThis.crypto.randomUUID(), { storage = globalThis.sessionStorage, crypto = globalThis.crypto, scope = 'card' } = {}) {
  const activeKey = `mammothCommerceAttempt:${scope}`;
  const attemptKey = id => `mammothCommerceAttempt:${scope}:${id}`;
  let revision = 0;
  let attempt = null;
  return {
    begin(payload) {
      const signature = JSON.stringify(payload);
      if (attempt?.signature === signature) return attempt;
      // Persist before calling a provider: a lost response must not lose the proof.
      const savedId = storage?.getItem(activeKey);
      if (savedId) {
        let saved;
        try { saved = JSON.parse(storage.getItem(attemptKey(savedId)) || 'null'); } catch { /* Fail closed below. */ }
        if (!saved || !/^[a-f0-9]{64}$/.test(saved.receiptToken || '')) throw new Error('Pending order capability is unavailable. Contact us before creating another order.');
        if (saved.signature === signature) {
          attempt = Object.freeze({ ...saved, revision });
          return attempt;
        }
      }
      const receiptToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      const next = { signature, revision, requestId: uuid(), receiptToken };
      storage?.setItem(attemptKey(next.requestId), JSON.stringify(next));
      storage?.setItem(activeKey, next.requestId);
      attempt = Object.freeze(next);
      return attempt;
    },
    invalidate() {
      revision++;
      // Initial UI rendering must not discard a persisted in-flight attempt.
      if (attempt) storage?.removeItem(activeKey);
      attempt = null;
    },
    isCurrent(candidate) { return candidate === attempt && candidate.revision === revision; }
  };
}
export function rememberAttemptReceipt(result, attempt, storage = globalThis.sessionStorage) {
  if (!/^[a-f0-9]{64}$/.test(attempt?.receiptToken || '') || result?.receiptToken !== attempt.receiptToken) return null;
  return rememberReceipt({ orderId: result.orderId, receiptToken: attempt.receiptToken }, storage);
}
export function rememberReceipt(result, storage = globalThis.sessionStorage) {
  if (!result?.orderId) throw new Error('No durable order reference was returned.');
  const previous = readReceipt('', storage);
  const token = result.receiptToken || (previous?.orderId === result.orderId ? previous.token : null);
  if (!token) return null;
  const receipt = { orderId: result.orderId, token };
  try { storage?.setItem(RECEIPT_KEY, JSON.stringify(receipt)); } catch { /* Fragment links still work if storage is disabled. */ }
  return receipt;
}
export function readReceipt(fragment = '', storage = globalThis.sessionStorage) {
  const values = new URLSearchParams(fragment.replace(/^#/, ''));
  if (values.getAll('order').length > 1 || values.getAll('token').length > 1) return null;
  if (values.has('token')) return values.get('order') && /^[A-Za-z0-9_-]+$/.test(values.get('token') || '') ? { orderId: values.get('order'), token: values.get('token') } : null;
  try {
    const saved = JSON.parse(storage?.getItem(RECEIPT_KEY) || 'null');
    if (values.has('order') && (!values.get('order') || saved?.orderId !== values.get('order'))) return null;
    return typeof saved?.orderId === 'string' && saved.orderId && typeof saved?.token === 'string' && saved.token ? { orderId: saved.orderId, token: saved.token } : null;
  } catch { return null; }
}
export function receiptHref(receipt) {
  return `./receipt.html#${new URLSearchParams({ order: receipt.orderId, token: receipt.token })}`;
}
