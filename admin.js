import { getAllOrders, getCurrentUser, isAdmin } from './auth.js?v=2';

const shell = document.querySelector('.dashboard-shell');
const user = getCurrentUser();
const money = cents => `$${(Number(cents || 0) / 100).toFixed(2)}`;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function renderDashboard(orders) {
  const total = orders.reduce((sum, order) => sum + Number(order.totalAmount || order.total || 0), 0);
  document.getElementById('order-count').textContent = orders.length;
  document.getElementById('revenue-total').textContent = money(total);
  document.getElementById('ready-count').textContent = orders.filter(order => /ready/i.test(order.status || '')).length;
  document.getElementById('orders-table').innerHTML = orders.map(order => `<tr><td><strong>${escapeHtml(order.customerName || 'Guest')}</strong><small>${escapeHtml(order.customerEmail || '')}</small></td><td>${escapeHtml(order.marketName || order.marketId || 'Next market')}<small>${escapeHtml(order.pickupDate || 'Upcoming')}</small></td><td>${escapeHtml(order.productSummary || (order.items || []).map(item => `${item.quantity} × ${item.name}`).join(', ') || 'Broth preorder')}</td><td>${money(order.totalAmount || order.total)}</td><td><span class="status-pill">${escapeHtml(order.status || 'Confirmed')}</span></td></tr>`).join('');
  const byMarket = orders.reduce((result, order) => { const key = order.marketName || order.marketId || 'Next market'; result[key] = (result[key] || 0) + 1; return result; }, {});
  document.getElementById('market-breakdown').innerHTML = Object.entries(byMarket).map(([name, count]) => `<div class="breakdown-row"><span>${escapeHtml(name)}</span><strong>${count} ${count === 1 ? 'order' : 'orders'}</strong></div>`).join('');
}

async function init() {
  if (!isAdmin(user)) {
    shell.innerHTML = '<section class="panel-primitive empty-state"><p class="eyebrow">PRIVATE AREA</p><h1 class="font-caveman">Admin access required</h1><p>Sign in with the operations account to view fulfillment details.</p><a class="btn-primitive" href="./account.html">Go to sign in</a></section>';
    return;
  }
  renderDashboard(await getAllOrders());
  document.getElementById('refresh-dashboard').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    renderDashboard(await getAllOrders());
    event.currentTarget.disabled = false;
  });
}

init().catch(error => { console.error(error); shell.innerHTML = '<section class="panel-primitive empty-state"><h1 class="font-caveman">Dashboard unavailable</h1><p>Refresh the page and try again.</p></section>'; });
