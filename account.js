import { signInEmail, signInProvider, logout, watchUser, getUserOrders } from './auth.js?v=2';
const authCard = document.getElementById('auth-card');
const ordersCard = document.getElementById('orders-card');
const message = document.getElementById('auth-message');
const form = document.getElementById('email-auth-form');
const money = cents => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const setMessage = text => { message.textContent = text; };

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const orderStatus = status => ({ pending: 'Reserved', payment_processing: 'Payment processing', paid: 'Payment received', confirmed: 'Confirmed', ready_for_pickup: 'Ready for pickup', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded' }[status] || 'Confirmed');

async function renderOrders(user) {
  if (!user) { authCard.hidden = false; ordersCard.hidden = true; return; }
  authCard.hidden = true; ordersCard.hidden = false;
  const orders = await getUserOrders(user);
  const list = document.getElementById('orders-list');
  window.__mammothOrders = new Map(orders.map(order => [order.id || order.orderName, order]));
  list.innerHTML = orders.length ? orders.map(order => {
    const key = order.id || order.orderName;
    const items = Array.isArray(order.items) ? order.items : [];
    const canReorder = items.some(item => item.productId && Number(item.quantity) > 0);
    return `<article class="order-card"><div><span class="status-pill">${escapeHtml(orderStatus(order.status))}</span><h3 class="font-caveman">${escapeHtml(order.orderName || order.id || 'Mammoth preorder')}</h3><p>${escapeHtml(order.productSummary || items.map(item => `${item.quantity} × ${item.name}`).join(', '))}</p><p class="order-meta"><strong>Pickup</strong> ${escapeHtml(order.marketName || 'Next market')}<br>${escapeHtml(order.pickupDate || 'Upcoming pickup')}</p><p class="order-meta"><strong>Payment</strong> ${order.paymentMethod === 'pickup' ? 'Pay at pickup' : 'Paid online'}</p>${canReorder ? `<button type="button" class="btn-primitive reorder-button" data-reorder="${escapeHtml(key)}">Reorder these broths</button>` : ''}</div><strong aria-label="Order total ${money(order.totalAmount ?? order.total)}">${money(order.totalAmount ?? order.total)}</strong></article>`;
  }).join('') : '<div class="empty-state"><p>No past preorders yet.</p><a href="./shop.html">Start with the next market</a></div>';
}

document.getElementById('orders-list').addEventListener('click', event => {
  const button = event.target.closest('[data-reorder]');
  if (!button) return;
  const order = window.__mammothOrders?.get(button.dataset.reorder);
  const cart = {};
  (order?.items || []).forEach(item => {
    if (item.productId && Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0) cart[item.productId] = Number(item.quantity);
  });
  if (!Object.keys(cart).length) return;
  localStorage.setItem('mammothCart', JSON.stringify(cart));
  window.location.href = './shop.html';
});

form.addEventListener('submit', async event => { event.preventDefault(); setMessage('Opening your ledger…'); try { const user = await signInEmail(form.elements['auth-email'].value.trim(), form.elements['auth-password'].value); await renderOrders(user); setMessage(''); } catch (error) { setMessage(error.message || 'Sign in did not work.'); } });
document.getElementById('create-account').addEventListener('click', async () => { setMessage('Creating your account…'); try { const user = await signInEmail(form.elements['auth-email'].value.trim(), form.elements['auth-password'].value, true); await renderOrders(user); setMessage(''); } catch (error) { setMessage(error.message || 'Account creation did not work.'); } });
document.querySelectorAll('[data-provider]').forEach(button => button.addEventListener('click', async () => { setMessage(`Connecting to ${button.dataset.provider}…`); try { const user = await signInProvider(button.dataset.provider); await renderOrders(user); setMessage(''); } catch (error) { setMessage(error.message || 'Provider sign-in did not work.'); } }));
document.getElementById('logout-button').addEventListener('click', async () => { await logout(); renderOrders(null); });
watchUser(user => renderOrders(user).catch(error => setMessage(error.message || 'Could not load your orders.')));
