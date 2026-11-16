import { readReceipt, rememberReceipt, receiptHref, formatMoney } from './commerce-ui.mjs';
import { clearOrderQr, showOrderQr } from './receipt-order-qr.mjs';

// No Firebase SDK, analytics, authentication, third-party assets or public order queries.
const capability = readReceipt(location.hash, sessionStorage);
// Stripe may append redirect query secrets: scrub them before any network request.
history.replaceState(null, '', location.pathname);
if (capability) rememberReceipt({ orderId: capability.orderId, receiptToken: capability.token }, sessionStorage);
const status = document.getElementById('receipt-status');
const refresh = document.getElementById('receipt-refresh');
const share = document.getElementById('receipt-link');
const details = document.getElementById('receipt-details');
const payment = document.getElementById('receipt-payment');
const printButton = document.getElementById('receipt-print');
printButton?.addEventListener('click', () => { if (!printButton.disabled) window.print(); });
if (capability) {
  share.href = receiptHref(capability);
  share.hidden = false;
}

function hasPickupSchedule(receipt) {
  if (receipt.fulfillmentMethod !== 'market_pickup' || typeof receipt.marketName !== 'string' || !receipt.marketName.trim() ||
      typeof receipt.pickupDate !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(receipt.pickupDate)) return false;
  const timestamp = Date.parse(`${receipt.pickupDate}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === receipt.pickupDate;
}
function pickupScheduleCopy(receipt) {
  return hasPickupSchedule(receipt)
    ? 'Your order is recorded and will be ready at the selected market and date shown. Bring your order reference.'
    : 'Pickup details need review. Contact us with your order reference before traveling.';
}
function receiptStatus(receipt) {
  if (receipt.status === 'cancelled') return 'This order was cancelled. No further payment is due. Contact us if you need help with an existing payment.';
  if (receipt.status === 'refunded') return 'This order is marked refunded. Do not pay again. Contact us if you need help with your refund.';
  if (receipt.status === 'completed') return 'This order is completed. Keep this receipt for your records; do not make another payment for this order.';
  if (receipt.status === 'paid_requires_review') return 'Payment received. Fulfillment is not confirmed and requires owner review. Contact us with your reference so we can arrange fulfillment or a refund. Do not pay again.';
  if (receipt.status === 'paid') {
    if (receipt.fulfillmentMethod !== 'market_pickup') return 'Payment confirmed by our secure server. Keep this receipt for your records.';
    const pickup = pickupScheduleCopy(receipt);
    return receipt.paymentMethod === 'pickup'
      ? `Payment is marked paid by our staff; this is not an online payment confirmation. ${pickup}`
      : `Payment confirmed by our secure server. ${pickup} Keep this receipt for your records.`;
  }
  if (receipt.status === 'awaiting_approval') return 'Your special-order request is awaiting owner approval. No payment is required yet.';
  if (receipt.status === 'declined') return 'The owner declined this special-order request. No payment is required.';
  if (receipt.status === 'awaiting_payment') return receipt.fulfillmentMethod === 'special_order'
    ? 'Your reviewed special order is approved and awaiting payment. Review the final items and total below.'
    : 'Your order is recorded and awaiting payment. No payment has been confirmed. Review the items and total below.';
  if (['pending', 'confirmed', 'ready_for_pickup'].includes(receipt.status) && receipt.paymentMethod === 'pickup' && receipt.fulfillmentMethod === 'market_pickup')
    return `${pickupScheduleCopy(receipt)} Payment is due at market pickup.`;
  if (['pending', 'pending_payment', 'payment_processing'].includes(receipt.status)) return 'Awaiting signed server payment confirmation. A browser return is not proof of payment. Refresh this receipt before attempting another payment.';
  return 'This order status could not be confirmed. Contact us with your reference before making another payment.';
}
const FUNCTIONS_ORIGIN = 'https://us-central1-mammoth-broth-co.cloudfunctions.net';
const ACTIVE_PICKUP = ['pending', 'confirmed', 'ready_for_pickup', 'paid'];
const changeSection = document.getElementById('receipt-market-change');
const changeSelect = document.getElementById('receipt-market-change-select');
const changeButton = document.getElementById('receipt-market-change-submit');
const changeStatus = document.getElementById('receipt-market-change-status');
let changeOffer = null;

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
// Display only an exact 30-minute window that the server returned.
function serverPickupWindow(start, end) {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs - startMs === 30 * 60 * 1000 ? { start, end } : null;
}
function formatPickupWindow(slot, timeZone) {
  const format = zone => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  let formatter;
  try { formatter = format(typeof timeZone === 'string' && timeZone ? timeZone : 'America/New_York'); } catch { formatter = format('America/New_York'); }
  return `${formatter.format(new Date(slot.start))} to ${formatter.format(new Date(slot.end))}`;
}
function hideMarketChange() {
  changeOffer = null;
  if (!changeSection) return;
  changeSection.hidden = true;
  changeSelect?.replaceChildren();
  if (changeSelect) changeSelect.disabled = true;
  if (changeButton) changeButton.disabled = true;
}
// The server decides eligibility; the browser only refuses to show an incomplete offer.
function showMarketChange(receipt) {
  hideMarketChange();
  if (!capability || !changeSection || !changeSelect || !changeButton) return;
  if (receipt.fulfillmentMethod !== 'market_pickup' || receipt.pickupType !== 'monthly' || receipt.marketChangeEligible !== true ||
      !ACTIVE_PICKUP.includes(receipt.status) || !Number.isSafeInteger(receipt.pickupRevision) || receipt.pickupRevision < 0) return;
  const markets = new Map();
  for (const option of Array.isArray(receipt.marketChangeOptions) ? receipt.marketChangeOptions : []) {
    if (typeof option?.marketId === 'string' && /^[A-Za-z0-9_-]+$/.test(option.marketId) &&
        typeof option.marketName === 'string' && option.marketName.trim() && !markets.has(option.marketId)) markets.set(option.marketId, option.marketName.trim());
  }
  if (!markets.size) return;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose an alternative market…';
  changeSelect.append(placeholder);
  for (const [marketId, marketName] of markets) {
    const option = document.createElement('option');
    option.value = marketId;
    option.textContent = marketName;
    changeSelect.append(option);
  }
  changeSelect.value = '';
  changeOffer = { orderId: receipt.orderId, revision: receipt.pickupRevision, markets };
  changeSelect.disabled = false;
  changeButton.disabled = false;
  changeSection.hidden = false;
}
async function requestMarketChange() {
  const offer = changeOffer;
  if (!capability || !offer || changeButton.disabled) return;
  const marketId = changeSelect.value;
  if (!marketId || !offer.markets.has(marketId)) {
    changeStatus.textContent = 'Choose one of the alternative markets listed for this order.';
    return;
  }
  changeButton.disabled = true;
  changeSelect.disabled = true;
  changeStatus.textContent = 'Requesting your market change securely…';
  let confirmation = null;
  try {
    const response = await fetch(`${FUNCTIONS_ORIGIN}/reschedulePickup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { orderId: capability.orderId, receiptToken: capability.token, marketId, expectedPickupRevision: offer.revision } }),
      referrerPolicy: 'no-referrer', cache: 'no-store', credentials: 'omit'
    });
    const envelope = await response.json();
    const result = envelope?.result;
    const slot = serverPickupWindow(result?.pickupWindowStartAt, result?.pickupWindowEndAt);
    if (!response.ok || envelope.error || !result || result.marketId !== marketId || typeof result.marketName !== 'string' || !result.marketName.trim() ||
        !isIsoDate(result.pickupDate) || !slot || !Number.isSafeInteger(result.pickupRevision) || result.pickupRevision <= offer.revision) throw new Error('Unconfirmed change');
    confirmation = `Market change confirmed by our secure server: ${result.marketName.trim()} on ${result.pickupDate}, ${formatPickupWindow(slot, result.marketTimezone)}. This was your one market change.`;
  } catch {
    confirmation = null;
  }
  changeStatus.textContent = confirmation || 'Your market change could not be confirmed. Do not assume your pickup moved; this receipt is refreshed from our server and shows only the schedule on record. Contact us before traveling if anything is unclear.';
  // The receipt read-back, not the mutation response alone, confirms the new schedule.
  const refreshed = await loadReceipt();
  const refreshedSlot = serverPickupWindow(refreshed?.pickupWindowStartAt, refreshed?.pickupWindowEndAt);
  if (refreshed && refreshed.marketId === marketId && refreshed.pickupType === 'monthly' &&
      isIsoDate(refreshed.pickupDate) && refreshedSlot && Number.isSafeInteger(refreshed.pickupRevision) && refreshed.pickupRevision > offer.revision) {
    changeStatus.textContent = `Market change confirmed by your refreshed receipt: ${refreshed.marketName} on ${refreshed.pickupDate}, ${formatPickupWindow(refreshedSlot, refreshed.marketTimezone)}.`;
  } else if (confirmation) {
    changeStatus.textContent = 'The server accepted the market-change request, but the refreshed receipt did not confirm the new schedule. Do not travel until your private receipt shows the updated market, date and window; contact us if it does not refresh.';
  }
}
changeButton?.addEventListener('click', requestMarketChange);
function safeCheckoutUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' ? url.href : null; } catch { return null; }
}
async function loadReceipt() {
  clearOrderQr(document);
  hideMarketChange();
  if (printButton) printButton.disabled = true;
  if (!capability) {
    status.textContent = 'Open the private receipt link from your order confirmation. No account is needed. If your link is missing, contact us with your order reference; do not send payment details.';
    refresh.hidden = true;
    return null;
  }
  refresh.disabled = true;
  status.textContent = 'Checking your receipt securely…';
  payment.hidden = true;
  try {
    const response = await fetch('https://us-central1-mammoth-broth-co.cloudfunctions.net/getGuestReceipt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: capability }), referrerPolicy: 'no-referrer', cache: 'no-store', credentials: 'omit'
    });
    const envelope = await response.json();
    if (!response.ok || envelope.error || !envelope.result?.orderId) throw new Error('Receipt unavailable');
    const receipt = envelope.result;
    status.textContent = receiptStatus(receipt);
    details.replaceChildren();
    const add = text => { const line = document.createElement('p'); line.textContent = text; details.append(line); };
    add(`Reference: ${receipt.orderName || receipt.orderId}`);
    for (const item of receipt.items || []) add(`${item.quantity} × ${item.name} · ${formatMoney(Number(item.price || 0) * Number(item.quantity || 0))}`);
    add(`Total: ${formatMoney(Number(receipt.totalAmount || 0))}`);
    if (receipt.discountAmount) add(`Discount: ${formatMoney(receipt.discountAmount)}`);
    if (['pending', 'confirmed', 'ready_for_pickup', 'paid', 'awaiting_payment', 'pending_payment', 'payment_processing'].includes(receipt.status)) {
      if (receipt.deliveryDate) add(`Monday delivery: ${receipt.deliveryDate} · Delivery fee: ${formatMoney(receipt.deliveryFee || 0)}`);
      if (receipt.marketName || receipt.pickupDate) add(`Pickup: ${receipt.marketName || ''} ${receipt.pickupDate || ''}`);
      if (receipt.fulfillmentMethod === 'market_pickup') {
        const slot = serverPickupWindow(receipt.pickupWindowStartAt, receipt.pickupWindowEndAt);
        if (receipt.pickupType === 'monthly') add('Monthly pickup: one-time order. It never renews and you are not charged again.');
        if (slot) add(`Pickup window: ${formatPickupWindow(slot, receipt.marketTimezone)} (30 minutes)`);
        else if (receipt.pickupType === 'monthly') add('Pickup window: not confirmed. Contact us with your reference before traveling.');
      }
    }
    const checkoutUrl = safeCheckoutUrl(receipt.checkoutUrl);
    const approvedSpecial = receipt.fulfillmentMethod === 'special_order' && receipt.status === 'awaiting_payment';
    if (approvedSpecial && !checkoutUrl) status.textContent += ' Payment setup is not available yet. Contact the owner to resume setup for the approved terms; do not place another order.';
    if (receipt.status === 'awaiting_payment' && !approvedSpecial) status.textContent += ' If checkout was interrupted, check your existing checkout session or contact us with this reference before trying again. Do not place another order to retry.';
    if (approvedSpecial && checkoutUrl) {
      payment.href = checkoutUrl;
      payment.hidden = false;
    }
    showOrderQr(document, receipt);
    showMarketChange(receipt);
    if (printButton) printButton.disabled = false;
    return receipt;
  } catch {
    clearOrderQr(document);
    hideMarketChange();
    details.replaceChildren();
    status.textContent = 'This receipt is unavailable, expired, revoked, or the secure service is not configured. Check your private link and try again, or contact us with your order reference. No payment status has been assumed.';
    return null;
  } finally { refresh.disabled = false; }
}
refresh.addEventListener('click', loadReceipt);
loadReceipt();
