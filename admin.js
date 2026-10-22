import { getAllOrders, watchUser, isAdmin } from './auth.js?v=3';
import { reviewSpecialOrder, retryOrderEmail } from './store.js';
import { buildSpecialReview } from './commerce-ui.mjs';

const shell = document.querySelector('.dashboard-shell');
const dashboardMarkup = shell.innerHTML;
let session = 0;
let authorizedOwner = null;
let approvedTerms = new Map();
const money = cents => `$${(Number(cents || 0) / 100).toFixed(2)}`;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function fulfillmentLabel(order) {
  if (order.fulfillmentMethod === 'local_delivery') {
    const address = order.deliveryAddress || {};
    return `Monday local delivery · ${[address.street, address.city, address.state, address.zip].filter(Boolean).join(', ') || 'Delivery address unavailable'}`;
  }
  if (order.fulfillmentMethod === 'special_order') return `Special order: ${order.specialNotes || 'Approval required'}`;
  return `Market pickup · ${order.marketName || order.marketId || 'Unassigned'}`;
}

function renderDashboard(orders) {
  renderSpecialReviews(orders);
  const total = orders.reduce((sum, order) => sum + Number(order.totalAmount || order.total || 0), 0);
  document.getElementById('order-count').textContent = orders.length;
  document.getElementById('revenue-total').textContent = money(total);
  document.getElementById('ready-count').textContent = orders.filter(order => /ready/i.test(order.status || '')).length;
  document.getElementById('orders-table').innerHTML = orders.map(order => `<tr><td><strong>${escapeHtml(order.customerName || 'Guest')}</strong><small>${escapeHtml(order.customerEmail || '')}</small></td><td>${escapeHtml(fulfillmentLabel(order))}<small>${escapeHtml(order.fulfillmentMethod === 'local_delivery' ? order.deliveryDate || 'Delivery date unavailable' : order.fulfillmentMethod === 'special_order' ? '' : order.pickupDate || '')}</small></td><td>${escapeHtml(order.productSummary || (order.items || []).map(item => `${item.quantity} × ${item.name}`).join(', ') || 'Broth preorder')}</td><td>${money(order.totalAmount || order.total)}</td><td><span class="status-pill">${escapeHtml(order.status || 'Confirmed')}</span></td></tr>`).join('');
  const byMarket = orders.reduce((result, order) => { const key = order.fulfillmentMethod === 'special_order' ? 'Special requests' : order.fulfillmentMethod === 'local_delivery' ? 'Monday local delivery' : order.marketName || order.marketId || 'Unassigned pickup'; result[key] = (result[key] || 0) + 1; return result; }, {});
  document.getElementById('market-breakdown').innerHTML = Object.entries(byMarket).map(([name, count]) => `<div class="breakdown-row"><span>${escapeHtml(name)}</span><strong>${count} ${count === 1 ? 'order' : 'orders'}</strong></div>`).join('');
}

function showUnavailable() {
  shell.innerHTML = '<section class="panel-primitive empty-state"><h1 class="font-caveman">Dashboard unavailable</h1><p>The live order queue could not be loaded. Check your admin permissions and try again.</p></section>';
}

function renderSpecialReviews(orders) {
  approvedTerms = new Map(orders.filter(order => order.fulfillmentMethod === 'special_order' && order.status === 'awaiting_payment').map(order => [order.id, { items: (order.items || []).map(item => ({ ...item })), totalAmount: order.totalAmount }]));
  const queue = document.getElementById('special-order-review');
  if (!queue) return;
  queue.innerHTML = orders.filter(order => order.fulfillmentMethod === 'special_order').map(order => {
    const id = escapeHtml(order.id);
    const items = JSON.stringify((order.items || []).map(item => ({ productId: item.productId || '', name: item.name || '', quantity: item.quantity, price: item.price })), null, 2);
    const pending = order.status === 'awaiting_approval';
    return `<form data-review-order="${id}" class="panel-primitive"><h3>Special request ${escapeHtml(order.orderName || order.id)}</h3>
      <p>${escapeHtml(order.specialNotes || '')}</p><p>Status: ${escapeHtml(order.status)}</p>
      <label for="review-items-${id}">Final reviewed items (JSON; price in USD cents)</label>
      <p id="review-help-${id}">Each item requires productId, name, positive whole quantity, and unit price in cents. Review the final terms with the customer before approval.</p>
      <textarea id="review-items-${id}" name="reviewed-items" class="input-primitive" rows="8" aria-describedby="review-help-${id}" ${pending ? '' : 'readonly'}>${escapeHtml(items)}</textarea>
      <p>Final total: <output data-review-total>${money(order.totalAmount)}</output></p>
      ${pending ? '<label><input type="checkbox" name="terms-reviewed" required> I reviewed the final items and price above.</label><p><button type="submit" class="btn-primitive">Approve and create hosted payment link</button> <button type="button" data-decline class="btn-primitive">Decline request</button></p>' : ''}
      ${order.status === 'awaiting_payment' && !order.checkoutUrl ? '<p>Approved terms are frozen. Payment setup may still be incomplete; retry the same approved terms only.</p><button type="button" data-resume-payment class="btn-primitive">Resume payment setup</button>' : ''}
      <p><button type="button" data-retry-email class="btn-primitive">Retry notification</button></p>
      <p>${escapeHtml(emailStatus(order.emailState))}</p>
      <p data-review-status role="status" aria-live="polite">Email delivery is not confirmed here. Retry is safe; do not assume a notification was sent.</p>
      <a data-checkout-link rel="noreferrer noopener" hidden>Open approved hosted payment link</a></form>`;
  }).join('') || '<p>No special-order requests in the queue.</p>';
  // Assign handlers once per render instead of accumulating refresh listeners.
  queue.oninput = updateReviewedTotal;
  queue.onsubmit = submitReview;
  queue.onclick = clickReviewAction;
}
function reviewedItems(form) { return JSON.parse(form.querySelector('[name="reviewed-items"]').value); }
function emailStatus(state) {
  if (state === 'pending') return 'Email: pending — not yet delivered.';
  if (state === 'sending') return 'Email: sending — delivery is not confirmed.';
  if (state === 'sent') return 'Email: sent — recorded by the server, not proof of payment.';
  return 'Email delivery is not confirmed.';
}
function updateReviewedTotal(event) {
  const form = event.target.closest('[data-review-order]');
  if (!form) return;
  try {
    const review = buildSpecialReview({ admin: Boolean(authorizedOwner) }, form.dataset.reviewOrder, 'approve', reviewedItems(form));
    form.querySelector('[data-review-total]').textContent = money(review.totalAmount);
  } catch { form.querySelector('[data-review-total]').textContent = 'Enter valid reviewed items and integer cent prices.'; }
}
async function performReview(form, action) {
  const currentSession = session;
  const status = form.querySelector('[data-review-status]');
  if (form.dataset.busy === 'true') return;
  form.dataset.busy = 'true';
  try {
    if (!authorizedOwner || !await isAdmin(authorizedOwner) || currentSession !== session) return;
    form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    status.textContent = 'Submitting secure owner action…';
    const orderId = form.dataset.reviewOrder;
    if (action === 'retry') {
      await retryOrderEmail({ orderId });
      if (currentSession === session) status.textContent = 'Notification retry completed on the server. Refresh the queue to verify delivery status; this is not a payment confirmation.';
      return;
    }
    const frozen = action === 'resume' ? approvedTerms.get(orderId) : null;
    if (action === 'resume' && !frozen) throw new Error('Refresh approved terms before resuming');
    const payload = buildSpecialReview({ admin: true }, orderId, action === 'resume' ? 'approve' : action, frozen ? frozen.items : action === 'approve' ? reviewedItems(form) : []);
    if (frozen && payload.totalAmount !== frozen.totalAmount) throw new Error('Approved total does not match frozen items');
    const result = await reviewSpecialOrder(payload);
    if (currentSession !== session) return;
    if (!result.data?.orderId || !result.data.status) throw new Error('No durable decision returned');
    const verified = (await getAllOrders()).find(order => order.id === orderId);
    if (currentSession !== session) return;
    if (!verified || verified.status !== result.data.status) throw new Error('Decision is not yet verified');
    status.textContent = action !== 'decline' ? `Approved; awaiting payment. ${emailStatus(verified.emailState)} Refresh the queue before further decisions.` : 'Request declined. No payment is requested. Refresh the queue to verify.';
    const link = form.querySelector('[data-checkout-link]');
    const url = result.data.checkoutUrl ? new URL(result.data.checkoutUrl) : null;
    if (url?.protocol === 'https:' && url.hostname === 'checkout.stripe.com') { link.href = url.href; link.hidden = false; }
  } catch {
    if (currentSession === session) {
      status.textContent = 'Action could not be confirmed. Check admin permission, final item JSON and provider setup. Refresh before retrying; approved terms cannot be changed.';
      // Approval may have committed before Stripe failed. Reload durable terms,
      // never retry payment setup from the now-stale editable approval form.
      if (action === 'approve' || action === 'resume') {
        try {
          const orders = await getAllOrders();
          if (currentSession === session && orders.some(order => order.id === form.dataset.reviewOrder && order.status === 'awaiting_payment')) renderDashboard(orders);
        } catch { /* Keep the refresh instruction when readback also fails. */ }
      }
    }
  } finally {
    form.dataset.busy = 'false';
    if (currentSession === session) form.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}
function submitReview(event) {
  const form = event.target.closest('[data-review-order]');
  if (!form) return;
  event.preventDefault();
  if (!form.querySelector('[name="terms-reviewed"]')?.checked) return;
  performReview(form, 'approve');
}
function clickReviewAction(event) {
  const form = event.target.closest('[data-review-order]');
  if (!form) return;
  if (event.target.closest('[data-decline]')) performReview(form, 'decline');
  if (event.target.closest('[data-retry-email]')) performReview(form, 'retry');
  if (event.target.closest('[data-resume-payment]')) performReview(form, 'resume');
}

shell.innerHTML = '<p role="status">Checking admin access…</p>';
watchUser(async user => {
  const currentSession = ++session;
  authorizedOwner = null;
  approvedTerms.clear();
  // Clear customer data immediately on every sign-out or account change.
  shell.innerHTML = '<section class="panel-primitive empty-state"><p class="eyebrow">PRIVATE AREA</p><h1 class="font-caveman">Admin access required</h1><p>Sign in with an account carrying the admin permission to view fulfillment details.</p><a class="btn-primitive" href="./account.html">Go to sign in</a></section>';
  try {
    if (!user || !await isAdmin(user) || currentSession !== session) return;
    authorizedOwner = user;
    shell.innerHTML = dashboardMarkup;
    const refresh = document.getElementById('refresh-dashboard');
    const load = async () => {
      refresh.disabled = true;
      try {
        const orders = await getAllOrders();
        if (currentSession === session) renderDashboard(orders);
      } catch (error) {
        console.error('Live order queue unavailable.', error);
        if (currentSession === session) showUnavailable();
      } finally {
        if (currentSession === session) refresh.disabled = false;
      }
    };
    refresh.addEventListener('click', load);
    await load();
  } catch (error) {
    console.error('Admin access check failed.', error);
    if (currentSession === session) showUnavailable();
  }
});
