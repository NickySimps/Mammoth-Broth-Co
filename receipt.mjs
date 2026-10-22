import { readReceipt, rememberReceipt, receiptHref, formatMoney } from './commerce-ui.mjs';

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
if (capability) {
  share.href = receiptHref(capability);
  share.hidden = false;
}

function receiptStatus(receipt) {
  if (receipt.status === 'paid_requires_review') return 'Payment received. Fulfillment is not confirmed and requires owner review. Contact us with your reference so we can arrange fulfillment or a refund. Do not pay again.';
  if (receipt.status === 'paid') return 'Payment confirmed by our secure server. Keep this receipt for your records.';
  if (receipt.status === 'awaiting_approval') return 'Your special-order request is awaiting owner approval. No payment is required yet.';
  if (receipt.status === 'declined') return 'The owner declined this special-order request. No payment is required.';
  if (receipt.status === 'awaiting_payment') return 'Your reviewed special order is approved and awaiting payment. Review the final items and total below.';
  if (receipt.paymentMethod === 'pickup') return 'Your preorder is recorded. Payment is due at market pickup.';
  return 'Awaiting signed server payment confirmation. A browser return is not proof of payment. Refresh this receipt before attempting another payment.';
}
function safeCheckoutUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' ? url.href : null; } catch { return null; }
}
async function loadReceipt() {
  if (!capability) {
    status.textContent = 'Open the private receipt link from your order confirmation. No account is needed. If your link is missing, contact us with your order reference; do not send payment details.';
    refresh.hidden = true;
    return;
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
    if (receipt.status !== 'paid_requires_review') {
      if (receipt.deliveryDate) add(`Monday delivery: ${receipt.deliveryDate} · Delivery fee: ${formatMoney(receipt.deliveryFee || 0)}`);
      if (receipt.marketName || receipt.pickupDate) add(`Pickup: ${receipt.marketName || ''} ${receipt.pickupDate || ''}`);
    }
    const checkoutUrl = safeCheckoutUrl(receipt.checkoutUrl);
    if (receipt.status === 'awaiting_payment' && !checkoutUrl) status.textContent += ' Payment setup is not available yet. Contact the owner to resume setup for the approved terms; do not place another order.';
    if (receipt.status === 'awaiting_payment' && checkoutUrl) {
      payment.href = checkoutUrl;
      payment.hidden = false;
    }
  } catch {
    details.replaceChildren();
    status.textContent = 'This receipt is unavailable, expired, revoked, or the secure service is not configured. Check your private link and try again, or contact us with your order reference. No payment status has been assumed.';
  } finally { refresh.disabled = false; }
}
refresh.addEventListener('click', loadReceipt);
loadReceipt();
