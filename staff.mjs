import { watchUser, isAdmin, signInEmail, signInProvider, logout } from './auth.js?v=3';
import { auth } from './store.js';
import { getStaffOrder } from './staff-store.mjs';
import { readStaffOrder } from './order-lookup.mjs';

const node = id => document.getElementById(id);
const details = node('order-details');
let user = null;
let generation = 0;
let displayedOrder = null;
let confirmation = null;
let busy = false;
const uncertain = new Map();
const actionButtons = ['record-payment', 'record-collection', 'record-payment-and-collection', 'retry-pickup-action'];
const labels = {
  record_payment: 'Payment received at pickup',
  record_collection: 'Order collected',
  record_payment_and_collection: 'Payment received at pickup and order collected'
};
const operationKey = (who, id) => `${who.uid}/${id}`;
const revision = order => order.pickupAdminRevision === undefined ? 0 : order.pickupAdminRevision;
const hasValue = (order, key) => ![undefined, null, '', false, 0].includes(order[key]);
const present = (order, key) => order[key] !== undefined && order[key] !== null;
const adverse = order => ['reconciliationRequired', 'reviewReason', 'refundStatus', 'refundedAt', 'cancelledAt', 'canceledAt', 'refundId', 'refundAmount', 'amountRefunded', 'disputeStatus'].some(key => hasValue(order, key));
const providerSetup = order => ['paymentIntentId', 'checkoutSessionId', 'clientSecret', 'checkoutUrl'].some(key => hasValue(order, key)) ||
  [['paymentLease', 'paymentLeaseUntil'], ['checkoutLease', 'checkoutLeaseUntil']].some(([token, until]) =>
    (hasValue(order, token) && !Number.isFinite(order[until])) ||
    (present(order, until) && (!Number.isFinite(order[until]) || order[until] > Date.now())));
const paymentProof = order => {
  const evidence = order?.paymentEvidence;
  if (order?.status !== 'paid' || !Number.isFinite(order.paidAt) || order.paidAt <= 0 ||
      !Number.isFinite(evidence?.recordedAt) || evidence.recordedAt <= 0 ||
      evidence.totalAmount !== order.totalAmount || evidence.currency !== order.currency) return false;
  if (order.paymentMethod === 'stripe') return evidence.source === 'stripe' &&
    /^pi_[-\w]+$/.test(evidence.paymentIntentId) && evidence.paymentIntentId === order.paymentIntentId && /^evt_[-\w]+$/.test(evidence.eventId);
  return order.paymentMethod === 'pickup' && !providerSetup(order) && evidence.source === 'operator_declaration' &&
    typeof evidence.actorUid === 'string' && Boolean(evidence.actorUid) && /^[0-9a-f-]{36}$/i.test(evidence.operationId) && order.paidAt === evidence.recordedAt;
};
const validSnapshot = order => order && order.id === readStaffOrder(location.hash) &&
  /^[a-f0-9]{64}$/.test(order.id) &&
  order.fulfillmentMethod === 'market_pickup' && ['pickup', 'stripe'].includes(order.paymentMethod) &&
  Number.isSafeInteger(order.totalAmount) && order.totalAmount > 0 && order.totalAmount <= 99999999 && order.currency === 'usd' &&
  Number.isSafeInteger(revision(order)) && revision(order) >= 0 && revision(order) < Number.MAX_SAFE_INTEGER &&
  typeof order.marketName === 'string' && Boolean(order.marketName.trim()) &&
  typeof order.pickupDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(order.pickupDate) &&
  (order.fulfillmentStatus === undefined || order.fulfillmentStatus === 'uncollected') &&
  !['collectedAt', 'collectionEvidence'].some(key => present(order, key)) && !adverse(order);
function eligible(order, action) {
  if (!validSnapshot(order)) return false;
  if (action === 'record_collection') return paymentProof(order);
  return order.paymentMethod === 'pickup' && order.status === 'pending' && !providerSetup(order) &&
    !['paidAt', 'paymentEvidence'].some(key => present(order, key));
}
function currentOrder() {
  return user && auth.currentUser === user && displayedOrder?.id === readStaffOrder(location.hash);
}
function refreshActions() {
  const ready = currentOrder();
  const retry = ready && uncertain.get(operationKey(user, displayedOrder.id));
  const choices = ['record_payment', 'record_collection', 'record_payment_and_collection'];
  choices.forEach((action, i) => {
    const allowed = ready && !retry && eligible(displayedOrder, action);
    node(actionButtons[i]).hidden = !allowed;
    node(actionButtons[i]).disabled = !allowed || busy;
  });
  node('retry-pickup-action').hidden = !retry;
  node('retry-pickup-action').disabled = !retry || busy;
  node('pickup-actions').hidden = !ready || (!retry && !choices.some(action => eligible(displayedOrder, action)));
  node('confirm-pickup-action').disabled = !ready || !confirmation || busy;
  node('cancel-pickup-action').disabled = busy;
}
function closeConfirmation() {
  confirmation = null;
  node('pickup-confirmation').hidden = true;
  node('pickup-confirm-summary').textContent = '';
  refreshActions();
}
function prepare(action, retry = false) {
  if (busy || !currentOrder()) return;
  const saved = uncertain.get(operationKey(user, displayedOrder.id));
  if (retry ? !saved : saved || !eligible(displayedOrder, action)) return;
  confirmation = retry ? saved : {
    payload: { orderId: displayedOrder.id, operationId: crypto.randomUUID(), action,
      expectedRevision: revision(displayedOrder), expectedTotalAmount: displayedOrder.totalAmount, expectedCurrency: displayedOrder.currency },
    marketName: displayedOrder.marketName, pickupDate: displayedOrder.pickupDate, paymentMethod: displayedOrder.paymentMethod
  };
  const p = confirmation.payload;
  node('pickup-confirm-summary').textContent = `${p.orderId} · ${confirmation.marketName} · ${confirmation.pickupDate} · ${new Intl.NumberFormat('en-US', { style: 'currency', currency: p.expectedCurrency }).format(p.expectedTotalAmount / 100)} · ${labels[p.action]}. ${retry ? 'Retry uses the original operation ID and original amount/revision; do not take payment again.' : 'No money will be charged.'}`;
  node('pickup-confirmation').hidden = false;
  refreshActions();
  node('confirm-pickup-action').focus();
}


function clearOrder() {
  displayedOrder = null;
  closeConfirmation();
  node('pickup-action-status').textContent = '';
  node('order-card').hidden = true;
  details.replaceChildren();
  node('order-warning').textContent = '';
  node('order-warning').hidden = true;
}
const text = value => typeof value === 'string' && value ? value : 'Not recorded';
const recordedTime = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? new Date(value).toISOString() : 'Not recorded';
function line(label, value) {
  const row = document.createElement('p');
  const title = document.createElement('strong');
  title.textContent = `${label}: `;
  const content = document.createElement('span');
  content.textContent = value;
  row.append(title, content);
  details.append(row);
}
function payment(order) {
  if (['paid', 'paid_requires_review'].includes(order.status)) {
    if (order.paymentEvidence?.source === 'operator_declaration') return 'Payment recorded at pickup by an authorized operator';
    if (order.paymentEvidence?.source === 'stripe') return 'Payment received — verified online by Stripe';
    return 'Payment received — source not recorded; verify with the owner';
  }
  if (order.status === 'refunded') return 'Refunded';
  if (order.status === 'cancelled') return 'Order cancelled — verify payment history with the owner';
  if (order.status === 'payment_processing') return 'Payment processing — not yet confirmed';
  if (['pending', 'awaiting_payment', 'awaiting_approval'].includes(order.status)) return 'Payment not confirmed';
  return 'Payment not confirmed by this record — check with the owner';
}
function renderOrder(order) {
  // Allowlist individual display fields. Never serialize the Firestore document.
  line('Order reference', text(order.orderName || order.id));
  if (order.orderName) line('Order ID', text(order.id));
  line('Customer', text(order.customerName));
  line('Email', text(order.customerEmail));
  line('Order status', text(order.status));
  line('Payment method', ({ stripe: 'Online card (Stripe)', pickup: 'Pay at pickup', special_order: 'Special-order terms' })[order.paymentMethod] || text(order.paymentMethod));
  line('Payment', payment(order));
  if (order.paymentEvidence?.source === 'operator_declaration') {
    line('Payment evidence', 'Operator declaration only — not independent bank or card-payment verification');
    line('Payment declaration actor', text(order.paymentEvidence.actorUid));
    line('Payment declaration operation', text(order.paymentEvidence.operationId));
    line('Payment declaration recorded at', recordedTime(order.paymentEvidence.recordedAt));
  }
  if (order.collectionEvidence) {
    line('Collection declaration actor', text(order.collectionEvidence.actorUid));
    line('Collection declaration operation', text(order.collectionEvidence.operationId));
    line('Collection declaration recorded at', recordedTime(order.collectionEvidence.recordedAt));
  }
  if (order.pickupAdminRevision !== undefined) line('Pickup ledger revision', String(order.pickupAdminRevision));
  if (order.paymentStatus) line('Recorded payment status', text(order.paymentStatus));
  const total = order.totalAmount ?? order.total;
  line('Total', typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(total / 100) : 'Not recorded');
  line('Fulfillment method', ({ market_pickup: 'Market pickup', local_delivery: 'Local delivery', special_order: 'Special order' })[order.fulfillmentMethod] || text(order.fulfillmentMethod));
  const blocked = ['cancelled', 'refunded', 'declined'].includes(order.status);
  const review = order.status === 'paid_requires_review';
  line('Fulfillment', blocked ? 'No fulfillment scheduled' : review ? 'Not confirmed — owner review required' : order.status === 'completed' ? 'Recorded as completed' : text(order.fulfillmentStatus || 'Not confirmed by this scan; verify the order status with the owner'));
  line('Recorded market', text(order.marketName));
  line('Recorded pickup date', text(order.pickupDate));
  if (order.deliveryDate) line('Recorded delivery date', text(order.deliveryDate));
  const heading = document.createElement('h3');
  heading.textContent = 'Items';
  details.append(heading);
  const items = document.createElement('ul');
  for (const item of Array.isArray(order.items) ? order.items : []) {
    const row = document.createElement('li');
    const quantity = Number.isSafeInteger(item?.quantity) && item.quantity > 0 ? item.quantity : '?';
    row.textContent = `${quantity} × ${text(item?.name)}`;
    items.append(row);
  }
  if (!items.children.length) {
    const row = document.createElement('li');
    row.textContent = 'No item details recorded';
    items.append(row);
  }
  details.append(items);
  const warning = review ? 'Payment received — owner review required. Fulfillment is not confirmed. Do not fulfill until the owner resolves the review; do not charge again.'
    : blocked ? `${text(order.status)} order. Do not fulfill; contact the owner before taking any action.` : '';
  node('order-warning').textContent = warning;
  node('order-warning').hidden = !warning;
  node('order-card').hidden = false;
  displayedOrder = order;
  refreshActions();
}

node('record-payment').addEventListener('click', () => prepare('record_payment'));
node('record-collection').addEventListener('click', () => prepare('record_collection'));
node('record-payment-and-collection').addEventListener('click', () => prepare('record_payment_and_collection'));
node('retry-pickup-action').addEventListener('click', () => prepare(null, true));
node('cancel-pickup-action').addEventListener('click', () => { if (!busy) { closeConfirmation(); node('pickup-actions').focus(); } });

node('confirm-pickup-action').addEventListener('click', async () => {
  if (busy || !confirmation || !currentOrder()) return;
  const actor = user;
  const session = generation;
  const attempt = confirmation;
  const payload = attempt.payload;
  const key = operationKey(actor, payload.orderId);
  const current = () => session === generation && user === actor && auth.currentUser === actor && readStaffOrder(location.hash) === payload.orderId;
  // Save before crossing any asynchronous boundary. An ambiguous response must
  // never turn into a new mutation ID, even after a lookup or account switch.
  uncertain.set(key, attempt);
  busy = true;
  refreshActions();
  node('pickup-action-status').textContent = 'Submitting declaration… No money is being charged. Wait for server verification.';
  try {
    const sdk = await import('https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js');
    if (!current()) return;
    if (!await isAdmin(actor)) throw new Error('Access denied');
    if (!current()) return;
    const submit = sdk.httpsCallable(sdk.getFunctions(), 'recordMarketPickupAction');
    await submit(payload);
    if (!current()) return;
    node('pickup-action-status').textContent = 'Server responded. Re-reading this exact order to verify the declaration…';
    const fresh = await getStaffOrder(payload.orderId, actor);
    if (!current()) return;
    const paymentOK = payload.action === 'record_collection' ||
      (fresh?.paymentEvidence?.source === 'operator_declaration' && fresh.paymentEvidence.operationId === payload.operationId && fresh.paymentEvidence.actorUid === actor.uid);
    const collectionOK = payload.action === 'record_payment' ||
      (fresh?.fulfillmentStatus === 'collected' && fresh.collectionEvidence?.operationId === payload.operationId && fresh.collectionEvidence.actorUid === actor.uid &&
        Number.isFinite(fresh.collectionEvidence.recordedAt) && fresh.collectionEvidence.recordedAt > 0 && fresh.collectedAt === fresh.collectionEvidence.recordedAt);
    if (!fresh || fresh.id !== payload.orderId || fresh.totalAmount !== payload.expectedTotalAmount ||
        fresh.currency !== payload.expectedCurrency || !paymentProof(fresh) || adverse(fresh) ||
        fresh.fulfillmentMethod !== 'market_pickup' || fresh.paymentMethod !== attempt.paymentMethod ||
        !Number.isSafeInteger(revision(fresh)) || revision(fresh) <= payload.expectedRevision || !paymentOK || !collectionOK) {
      throw new Error('Readback does not verify this declaration');
    }
    uncertain.delete(key);
    details.replaceChildren();
    renderOrder(fresh);
    closeConfirmation();
    node('pickup-action-status').textContent = 'Declaration verified by a fresh read of this exact order. No money was charged by this page.';
  } catch {
    if (!current()) return;
    closeConfirmation();
    node('pickup-action-status').textContent = 'Declaration not verified. It may already have been recorded. Do not take payment or hand over goods again. Review and retry the same declaration, or ask the owner. Keep this page open to retain its operation ID.';
  } finally {
    busy = false;
    // Releasing an old request must not publish its result into a new session.
    refreshActions();
  }
});

async function lookup(nextUser) {
  const session = ++generation;
  user = nextUser;
  clearOrder();
  node('auth-card').hidden = Boolean(user);
  node('staff-session').hidden = !user;
  const current = () => session === generation && user === nextUser && auth.currentUser === nextUser && readStaffOrder(location.hash) === orderId;
  const orderId = readStaffOrder(location.hash);
  if (!orderId) {
    node('lookup-status').textContent = 'Missing or invalid order link. Scan the staff order QR on the receipt.';
    return;
  }
  if (!nextUser) {
    node('lookup-status').textContent = 'Sign in with an authorized staff account to view this exact order.';
    return;
  }
  node('lookup-status').textContent = 'Checking staff access…';
  try {
    const allowed = await isAdmin(nextUser);
    if (!current()) return;
    if (!allowed) {
      node('lookup-status').textContent = 'Staff access required. This account is not authorized. Sign out to switch accounts.';
      return;
    }
    node('lookup-status').textContent = 'Loading the scanned order…';
    const order = await getStaffOrder(orderId, nextUser);
    if (!current()) return;
    if (!order || order.id !== orderId) {
      node('lookup-status').textContent = 'No order found for this reference. Check the receipt with the owner.';
      return;
    }
    renderOrder(order);
    node('lookup-status').textContent = 'Exact order loaded. Read-only: scanning does not record payment or fulfillment.';
  } catch {
    if (!current()) return;
    clearOrder();
    node('lookup-status').textContent = 'Order unavailable or access denied. Check your staff account and connection, then retry.';
  }
}

node('staff-signin').addEventListener('submit', async event => {
  event.preventDefault();
  node('auth-message').textContent = 'Signing in…';
  try {
    const pending = signInEmail(node('staff-email').value.trim(), node('staff-password').value);
    node('staff-password').value = '';
    await pending;
    node('auth-message').textContent = '';
  } catch {
    node('auth-message').textContent = 'Sign-in failed. Check your details and try again.';
  } finally {
    node('staff-password').value = '';
  }
});
node('google-signin').addEventListener('click', async () => {
  node('auth-message').textContent = 'Connecting to Google…';
  try { await signInProvider('google'); node('auth-message').textContent = ''; }
  catch { node('auth-message').textContent = 'Google sign-in failed or was cancelled. Try again.'; }
});
node('staff-signout').addEventListener('click', async () => {
  // Clear before waiting for the network/auth observer, including failed sign-outs.
  generation += 1;
  user = null;
  clearOrder();
  node('lookup-status').textContent = 'Signing out…';
  try { await logout(); await lookup(null); }
  catch { node('lookup-status').textContent = 'Sign-out could not be completed. Close this page on a shared device and retry.'; }
});
node('retry-lookup').addEventListener('click', () => lookup(auth.currentUser));
window.addEventListener('hashchange', () => lookup(auth.currentUser));
// Avoid retaining private DOM in a back-forward cache snapshot.
window.addEventListener('pagehide', () => { generation += 1; clearOrder(); });
window.addEventListener('pageshow', event => { if (event.persisted) lookup(auth.currentUser); });
// Enable credential entry only after the preventDefault handler is installed.
// A failed module load must never submit a password through a native GET.
node('staff-credentials').disabled = false;
node('google-signin').disabled = false;
watchUser(nextUser => { lookup(nextUser); });
