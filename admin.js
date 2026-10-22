import { getAllOrders, watchUser, isAdmin } from './auth.js?v=3';

const shell = document.querySelector('.dashboard-shell');
const dashboardMarkup = shell.innerHTML;
let session = 0;
const money = cents => `$${(Number(cents || 0) / 100).toFixed(2)}`;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function fulfillmentLabel(order) {
  if (order.fulfillmentMethod === 'local_delivery') return 'Monday local delivery';
  if (order.fulfillmentMethod === 'special_order') return `Special order: ${order.specialNotes || 'Approval required'}`;
  return `Market pickup · ${order.marketName || order.marketId || 'Unassigned'}`;
}

function renderDashboard(orders) {
  const total = orders.reduce((sum, order) => sum + Number(order.totalAmount || order.total || 0), 0);
  document.getElementById('order-count').textContent = orders.length;
  document.getElementById('revenue-total').textContent = money(total);
  document.getElementById('ready-count').textContent = orders.filter(order => /ready/i.test(order.status || '')).length;
  document.getElementById('orders-table').innerHTML = orders.map(order => `<tr><td><strong>${escapeHtml(order.customerName || 'Guest')}</strong><small>${escapeHtml(order.customerEmail || '')}</small></td><td>${escapeHtml(fulfillmentLabel(order))}<small>${escapeHtml(order.pickupDate || '')}</small></td><td>${escapeHtml(order.productSummary || (order.items || []).map(item => `${item.quantity} × ${item.name}`).join(', ') || 'Broth preorder')}</td><td>${money(order.totalAmount || order.total)}</td><td><span class="status-pill">${escapeHtml(order.status || 'Confirmed')}</span></td></tr>`).join('');
  const byMarket = orders.reduce((result, order) => { const key = order.fulfillmentMethod === 'special_order' ? 'Special requests' : order.fulfillmentMethod === 'local_delivery' ? 'Monday local delivery' : order.marketName || order.marketId || 'Unassigned pickup'; result[key] = (result[key] || 0) + 1; return result; }, {});
  document.getElementById('market-breakdown').innerHTML = Object.entries(byMarket).map(([name, count]) => `<div class="breakdown-row"><span>${escapeHtml(name)}</span><strong>${count} ${count === 1 ? 'order' : 'orders'}</strong></div>`).join('');
}

function showUnavailable() {
  shell.innerHTML = '<section class="panel-primitive empty-state"><h1 class="font-caveman">Dashboard unavailable</h1><p>The live order queue could not be loaded. Check your admin permissions and try again.</p></section>';
}

shell.innerHTML = '<p role="status">Checking admin access…</p>';
watchUser(async user => {
  const currentSession = ++session;
  // Clear customer data immediately on every sign-out or account change.
  shell.innerHTML = '<section class="panel-primitive empty-state"><p class="eyebrow">PRIVATE AREA</p><h1 class="font-caveman">Admin access required</h1><p>Sign in with an account carrying the admin permission to view fulfillment details.</p><a class="btn-primitive" href="./account.html">Go to sign in</a></section>';
  try {
    if (!user || !await isAdmin(user) || currentSession !== session) return;
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
