import { watchUser, isAdmin, signInEmail, signInProvider, logout } from './auth.js?v=3';
import { auth } from './store.js';
import { getStaffOrder } from './staff-store.mjs';
import { readStaffOrder } from './order-lookup.mjs';

const node = id => document.getElementById(id);
const details = node('order-details');
let user = null;
let generation = 0;

function clearOrder() {
  node('order-card').hidden = true;
  details.replaceChildren();
  node('order-warning').textContent = '';
  node('order-warning').hidden = true;
}
const text = value => typeof value === 'string' && value ? value : 'Not recorded';
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
  if (['paid', 'paid_requires_review'].includes(order.status)) return 'Payment received';
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
}

async function lookup(nextUser) {
  const session = ++generation;
  user = nextUser;
  clearOrder();
  node('auth-card').hidden = Boolean(user);
  node('staff-session').hidden = !user;
  const current = () => session === generation && user === nextUser && auth.currentUser === nextUser;
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
    if (!order) {
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
