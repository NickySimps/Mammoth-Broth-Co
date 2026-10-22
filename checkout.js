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

export async function checkout(order) {
  try {
    const signature = JSON.stringify([order.cart, order.customerName, order.customerEmail, order.fulfillmentMethod, order.marketId, order.pickupDate, order.deliveryAddress, order.specialNotes, order.paymentMethod]);
    const pendingSubmission = submissionRevision.begin(signature);
    const orderWithId = Object.fromEntries(Object.entries(order).filter(([key]) => !['receiptToken', 'token', 'clientSecret', 'requestId', 'idempotencyKey'].includes(key)));
    
    let serverOrder = null;
    try {
      const result = await createPreorder({
        cart: orderWithId.cart,
        customerName: orderWithId.customerName,
        customerEmail: orderWithId.customerEmail,
        fulfillmentMethod: orderWithId.fulfillmentMethod,
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
    const orderName = serverOrder.orderName || serverOrder.orderId;
    orderWithId.orderName = orderName;
    orderWithId.firestoreId = serverOrder.orderId;
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
        const isSpecial = orderWithId.fulfillmentMethod === 'special_order';
        const title = document.getElementById('confirmation-title');
        const details = document.getElementById('confirmation-details');
        if (title) title.textContent = isSpecial ? 'Request received' : 'Order received';
        if (details) details.textContent = isSpecial ? 'Your special-order request is awaiting approval. We will contact you before fulfillment or payment.' : 'Your preorder has been saved. Bring your reference ID to pickup.';
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