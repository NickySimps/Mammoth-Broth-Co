import { createPreorder } from './store.js';
import { openDialog, closeDialog } from './dialog.mjs';
import { createCheckoutRevision, rememberAttemptReceipt, receiptHref } from './commerce-ui.mjs';

const modal = document.getElementById('confirmationModal');
const closeButton = document.querySelector('#confirmationModal .close-button');
const orderNumberSpan = document.getElementById('orderNumber');
const submissionRevision = createCheckoutRevision(() => globalThis.crypto.randomUUID(), { storage: sessionStorage, crypto: globalThis.crypto, scope: 'preorder' });

if (closeButton) {
    closeButton.addEventListener('click', () => {
      closeDialog(modal);
    });
}

window.addEventListener('click', (event) => {
  if (event.target === modal) {
    closeDialog(modal);
  }
});

const PICKUP_TYPES = ['market', 'monthly'];
const WINDOW_MS = 30 * 60 * 1000;
// Only an exact 30-minute window returned by the server is ever shown.
function serverPickupWindow(start, end) {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs - startMs === WINDOW_MS ? { start, end } : null;
}
function formatPickupWindow(slot, timeZone) {
  const format = zone => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  let formatter;
  try { formatter = format(typeof timeZone === 'string' && timeZone ? timeZone : 'America/New_York'); } catch { formatter = format('America/New_York'); }
  return `${formatter.format(new Date(slot.start))} to ${formatter.format(new Date(slot.end))}`;
}

export async function checkout(order) {
  try {
    if (order.fulfillmentMethod !== 'market_pickup' || order.paymentMethod !== 'pickup') throw new Error('This checkout only accepts pay-at-pickup market orders.');
    const pickupType = order.pickupType === undefined || order.pickupType === null || order.pickupType === '' ? 'market' : order.pickupType;
    if (!PICKUP_TYPES.includes(pickupType)) throw new Error('Unknown pickup type.');
    const signature = JSON.stringify([order.cart, order.customerName, order.customerEmail, order.fulfillmentMethod, pickupType, order.marketId, order.pickupDate, order.deliveryAddress, order.specialNotes, order.paymentMethod]);
    const pendingSubmission = submissionRevision.begin(signature);
    // Pickup windows and revisions are server-authoritative; never keep or send client copies.
    const orderWithId = Object.fromEntries(Object.entries(order).filter(([key]) => !['receiptToken', 'token', 'clientSecret', 'requestId', 'idempotencyKey', 'pickupWindow', 'pickupWindowStartAt', 'pickupWindowEndAt', 'pickupRevision'].includes(key)));
    orderWithId.pickupType = pickupType;
    
    let serverOrder = null;
    try {
      const result = await createPreorder({
        cart: orderWithId.cart,
        customerName: orderWithId.customerName,
        customerEmail: orderWithId.customerEmail,
        fulfillmentMethod: orderWithId.fulfillmentMethod,
        pickupType,
        marketId: orderWithId.marketId || null,
        pickupDate: orderWithId.pickupDate || null,
        deliveryAddress: orderWithId.deliveryAddress || null,
        specialNotes: orderWithId.specialNotes || '',
        paymentMethod: orderWithId.paymentMethod,
        requestId: pendingSubmission.requestId,
        idempotencyKey: pendingSubmission.requestId,
        receiptToken: pendingSubmission.receiptToken
      });
      serverOrder = result.data;
    } catch (error) {
      console.error('Secure preorder function unavailable; order was not submitted.');
      throw error;
    }
    if (!serverOrder?.orderId) throw new Error('The server did not confirm an order reference.');
    if (!Number.isSafeInteger(serverOrder.totalAmount) || serverOrder.totalAmount < 1) throw new Error('The server did not confirm an order total.');
    const orderName = serverOrder.orderName || serverOrder.orderId;
    orderWithId.orderName = orderName;
    orderWithId.firestoreId = serverOrder.orderId;
    if (typeof serverOrder.marketName === 'string' && serverOrder.marketName.trim()) orderWithId.marketName = serverOrder.marketName;
    if (typeof serverOrder.pickupDate === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(serverOrder.pickupDate)) orderWithId.pickupDate = serverOrder.pickupDate;
    const confirmedType = PICKUP_TYPES.includes(serverOrder.pickupType) ? serverOrder.pickupType : null;
    const confirmedWindow = serverPickupWindow(serverOrder.pickupWindowStartAt, serverOrder.pickupWindowEndAt);
    if (confirmedWindow) {
      orderWithId.pickupWindowStartAt = confirmedWindow.start;
      orderWithId.pickupWindowEndAt = confirmedWindow.end;
    }
    const receiptLink = document.getElementById('confirmation-receipt');
    if (receiptLink) receiptLink.hidden = true;
    const receipt = rememberAttemptReceipt(serverOrder, pendingSubmission, sessionStorage);
    if (!receipt) throw new Error('Receipt capability could not be verified. Contact us before creating another order.');
    if (receiptLink) {
      receiptLink.href = receiptHref(receipt);
      receiptLink.hidden = false;
    }
    submissionRevision.invalidate();
    if (Number.isFinite(serverOrder.totalAmount)) orderWithId.totalAmount = serverOrder.totalAmount;
    // Browser history is a convenience, not the source of truth for a saved order.
    try {
      let saved = [];
      try {
        const history = JSON.parse(localStorage.getItem('mammothOrders') || '[]');
        if (Array.isArray(history)) saved = history;
      } catch (error) {
        console.warn('Local order history could not be read.');
      }
      saved.unshift(orderWithId);
      localStorage.setItem('mammothOrders', JSON.stringify(saved));
    } catch (error) {
      console.warn('Order saved securely, but local order history could not be updated.');
    }
    // The orders onCreate function owns confirmation emails. Do not send twice.
    
    // Display the same server reference used in durable receipts and owner records.
    if (orderNumberSpan) {
        orderNumberSpan.textContent = orderName;
    }
    
    if (modal) {
        const title = document.getElementById('confirmation-title');
        const details = document.getElementById('confirmation-details');
        if (title) title.textContent = 'Pickup reservation received';
        if (details) details.textContent = `Your order is recorded for pickup at ${orderWithId.marketName || 'your selected market'} on ${orderWithId.pickupDate || 'your selected date'}. We'll have it ready at the selected market on the date shown. Payment: pay at pickup. Amount due: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(orderWithId.totalAmount / 100)}. Bring your order reference ID when you arrive.`;
        if (details && pickupType === 'monthly') {
          if (confirmedType !== 'monthly') details.textContent += ' Monthly pickup could not be confirmed by our server. Check your private receipt for your confirmed pickup before traveling.';
          else if (confirmedWindow) details.textContent += ` Monthly pickup: a one-time order that never renews. Your 30-minute pickup window is ${formatPickupWindow(confirmedWindow, serverOrder.marketTimezone)}. Your private receipt shows any confirmed change.`;
          else details.textContent += ' Monthly pickup: a one-time order that never renews. Your 30-minute pickup window is not confirmed yet; check your private receipt before traveling.';
        }
        if (details && serverOrder.emailState === 'pending') details.textContent += ' Email: pending — not yet delivered. Keep your private receipt link.';
        openDialog(modal);
    }
    return orderWithId;
  } catch (error) {
    console.error('Secure checkout could not be completed.');
    alert('Secure ordering is unavailable or could not be verified. Retry unchanged details or contact us before creating another order.');
    return null;
  }
}