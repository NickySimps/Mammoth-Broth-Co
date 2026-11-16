import { getProducts, getMarkets, getPromotionConfig, createPaymentIntent, calculateCartTotal, isOrderingConfigured } from './store.js';
import { createCheckoutRevision, pickupDateOptions, rememberAttemptReceipt, receiptHref, formatMoney } from './commerce-ui.mjs';
import { renderProducts, renderMarkets, updateCartSummary } from './ui.js';
import { checkout } from './checkout.js';
import { FULFILLMENT_METHODS, validateFulfillment } from './checkout-rules.mjs';
import { STRIPE_PUBLISHABLE_KEY } from './stripe-config.mjs';
let products = [];
let markets = [];
let promotion;
let cart = {};
let elements;
let paymentElement;
let submitting = false;
let preparedPayment = null;
let setupPending = null;
const checkoutRevision = createCheckoutRevision(() => globalThis.crypto.randomUUID(), { storage: sessionStorage, crypto: globalThis.crypto, scope: 'card' });
const stripe = !/^pk_(test|live)_/.test(STRIPE_PUBLISHABLE_KEY || '') || /YOUR_|PLACEHOLDER/i.test(STRIPE_PUBLISHABLE_KEY) || typeof Stripe !== 'function' ? null : Stripe(STRIPE_PUBLISHABLE_KEY);

function selectedPaymentMethod() {
  return document.querySelector('input[name="payment-method"]:checked')?.value || '';
}
// Read the checked state, not the editable value attribute; legacy default is market.
function selectedPickupType() {
  return document.getElementById('pickup-type-monthly')?.checked === true ? 'monthly' : 'market';
}
function fulfillmentDetails() {
  return { fulfillmentMethod: FULFILLMENT_METHODS.MARKET_PICKUP, pickupType: selectedPickupType(), marketId: document.getElementById('market-select')?.value || '', pickupDate: document.getElementById('pickup-date')?.value || '' };
}
function paymentPayload() {
  return { cart: { ...cart }, customerName: document.getElementById('customer-name').value.trim(), customerEmail: document.getElementById('customer-email').value.trim(), ...fulfillmentDetails() };
}
function currentAttempt(attempt) {
  return selectedPaymentMethod() === 'online' && checkoutRevision.isCurrent(attempt) && attempt.signature === JSON.stringify(paymentPayload());
}
function invalidateCheckout() {
  checkoutRevision.invalidate();
  resetPaymentElement();
}
function totalJars() {
  return Object.values(cart).reduce((sum, quantity) => sum + Number(quantity), 0);
}
function validateOrderDetails() {
  const details = fulfillmentDetails();
  const market = markets.find(market => market.id === details.marketId);
  const errors = validateFulfillment({ ...details, method: details.fulfillmentMethod, allowedPickupDates: pickupDateOptions(market) });
  const customerName = document.getElementById('customer-name')?.value.trim();
  const customerEmail = document.getElementById('customer-email')?.value.trim();
  if (!customerName) errors.unshift('Enter your name.');
  if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) errors.unshift('Enter a valid email address.');
  if (!totalJars()) errors.unshift('Add at least one jar to your cart.');
  if (totalJars() > 12) errors.unshift('Maximum order limit is 12 jars.');
  if (Object.entries(cart).some(([id, quantity]) => !Number.isInteger(quantity) || quantity < 1 || !products.some(product => product.id === id && product.active !== false && product.available !== false))) errors.unshift('Your cart contains an invalid or unavailable item. Please update it.');
  return errors;
}
function createDetailedOrder(paymentMethod, status) {
  const { items, total, discount, subtotal } = calculateCartTotal(cart, products, promotion);
  const details = fulfillmentDetails();
  return { ...paymentPayload(), marketName: markets.find(market => market.id === details.marketId)?.name || '', productSummary: items.map(item => `${item.quantity} × ${item.name}`).join(', '), items, totalAmount: total, subtotal, discountAmount: discount, status, paymentMethod, createdAt: new Date().toISOString() };
}
function setLoading(isLoading) {
  submitting = isLoading;
  const configured = isOrderingConfigured();
  const online = selectedPaymentMethod() === 'online';
  const pickupButton = document.getElementById('pay-at-pickup-button');
  const onlineButton = document.getElementById('checkout-button');
  pickupButton.disabled = isLoading || !configured || online;
  pickupButton.hidden = online;
  onlineButton.disabled = isLoading || !stripe || !configured || !online;
  onlineButton.hidden = !online;
  if (configured) pickupButton.removeAttribute('aria-describedby');
  document.getElementById('payment-online').disabled = !stripe || !configured;
}
function canSubmitOrder() {
  if (isOrderingConfigured()) return true;
  showMessage('Online ordering is temporarily unavailable. Your cart is saved; contact us to arrange an order.', 15000);
  return false;
}
function showMessage(message, timeout = 7000) {
  const messageContainer = document.getElementById('payment-message');
  messageContainer.classList.remove('hidden');
  messageContainer.textContent = message;
  window.clearTimeout(showMessage.timeout);
  showMessage.timeout = window.setTimeout(() => { messageContainer.classList.add('hidden'); messageContainer.textContent = ''; }, timeout);
}
function resetPaymentElement() {
  if (paymentElement) paymentElement.unmount();
  paymentElement = null;
  elements = null;
  preparedPayment = null;
  document.getElementById('payment-element').hidden = true;
  document.getElementById('checkout-button').textContent = 'Continue to secure payment';
}
function syncFulfillmentUI() {
  document.getElementById('ordering-availability').hidden = isOrderingConfigured();
  document.getElementById('pickup-reservation-help').hidden = !isOrderingConfigured();
  document.getElementById('online-payment-availability').hidden = Boolean(stripe && isOrderingConfigured());
  invalidateCheckout();
  setLoading(submitting);
}
function updatePickupDate() {
  const select = document.getElementById('pickup-date');
  const market = markets.find(market => market.id === document.getElementById('market-select').value);
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a listed pickup date…';
  select.appendChild(placeholder);
  for (const date of pickupDateOptions(market)) {
    const option = document.createElement('option');
    option.value = date;
    option.textContent = date;
    select.appendChild(option);
  }
  select.disabled = select.options.length < 2;
  if (market && select.disabled) showMessage('This market has no available pickup date. Choose another listed market or contact us.');
}
async function preparePaymentElement() {
  if (!stripe || selectedPaymentMethod() !== 'online' || !canSubmitOrder()) return false;
  if (elements) return Boolean(preparedPayment && currentAttempt(preparedPayment.attempt));
  if (setupPending) return false;
  const errors = validateOrderDetails();
  if (errors.length) { showMessage(errors.join(' ')); return false; }
  let attempt;
  try { attempt = checkoutRevision.begin(paymentPayload()); }
  catch { showMessage('Pending order capability is unavailable. Contact us before creating another order.', 20000); return false; }
  setupPending = attempt;
  try {
    const { data: result } = await createPaymentIntent({ ...paymentPayload(), requestId: attempt.requestId, receiptToken: attempt.receiptToken });
    if (!currentAttempt(attempt)) return false;
    const receipt = rememberAttemptReceipt(result, attempt, sessionStorage);
    if (!receipt) { showMessage(`Pending order ${result.orderName || result.orderId} cannot be opened securely. Do not retry with a new order. Contact us with this reference before payment.`, 20000); return false; }
    if (!result.clientSecret || !Number.isSafeInteger(result.totalAmount) || result.totalAmount < 1) throw new Error('Incomplete payment setup');
    elements = stripe.elements({ clientSecret: result.clientSecret });
    paymentElement = elements.create('payment');
    paymentElement.mount('#payment-element');
    preparedPayment = { attempt, receipt, totalAmount: result.totalAmount };
    document.getElementById('payment-element').hidden = false;
    document.getElementById('checkout-button').textContent = `Pay ${formatMoney(result.totalAmount)}`;
    showMessage(`Order ${result.orderName || result.orderId} is pending for ${fulfillmentDetails().pickupDate}. Review ${formatMoney(result.totalAmount)}, enter payment details securely, then click Pay to submit. Pickup is not confirmed as paid until the server verifies payment.`, 15000);
    return true;
  } catch {
    if (currentAttempt(attempt)) showMessage('Secure ordering is unavailable or could not be verified. Retry unchanged details or contact us. No payment was requested.');
    return false;
  } finally { if (setupPending === attempt) setupPending = null; }
}
async function handlePayAtPickup() {
  if (submitting || selectedPaymentMethod() !== 'pickup' || !canSubmitOrder()) return;
  const errors = validateOrderDetails();
  if (errors.length) { showMessage(errors.join(' ')); return; }
  const snapshot = JSON.stringify(paymentPayload());
  setLoading(true);
  try {
    const savedOrder = await checkout(createDetailedOrder('pickup', 'pending'));
    if (savedOrder && snapshot === JSON.stringify(paymentPayload())) handleClearCart();
  } finally { setLoading(false); }
}
async function handleOrderSubmit(event) {
  event.preventDefault();
  if (submitting || !canSubmitOrder()) return;
  if (selectedPaymentMethod() === 'pickup') { await handlePayAtPickup(); return; }
  if (selectedPaymentMethod() !== 'online') { showMessage('Choose how you would like to pay.'); return; }
  const errors = validateOrderDetails();
  if (errors.length) { showMessage(errors.join(' ')); return; }
  if (!stripe) { showMessage('Online payment is not configured. Choose Pay at Pickup or contact us.'); return; }
  if (!elements || !preparedPayment || !currentAttempt(preparedPayment.attempt)) {
    resetPaymentElement();
    setLoading(true);
    try { await preparePaymentElement(); } finally { setLoading(false); }
    // Mounting fields never authorizes a charge.
    return;
  }
  const payment = preparedPayment;
  const confirmingElements = elements;
  setLoading(true);
  try {
    const href = new URL(receiptHref(payment.receipt), window.location.origin).href;
    const { error } = await stripe.confirmPayment({ elements: confirmingElements, confirmParams: { return_url: new URL(`./receipt.html#${new URLSearchParams({ order: payment.receipt.orderId })}`, window.location.origin).href }, redirect: 'if_required' });
    if (!currentAttempt(payment.attempt)) return;
    if (error) { showMessage('Payment could not be completed. Check your payment details or open your private receipt before trying again.'); return; }
    // Only the server webhook establishes paid status; retain the cart meanwhile.
    window.location.href = href;
  } catch {
    if (currentAttempt(payment.attempt)) showMessage('Payment status could not be checked. Open your private receipt or contact us before trying another payment.');
  } finally { setLoading(false); }
}
function updateCartUI() {
  invalidateCheckout();
  try { localStorage.setItem('mammothCart', JSON.stringify(cart)); } catch { console.warn('Cart could not be cached on this device.'); }
  updateCartSummary(cart, products, updateCart, promotion);
}
function handleAddToCart(productId, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) { showMessage('Choose a positive whole number of jars.'); return; }
  if (totalJars() + quantity > 12) { showMessage('You cannot add more than 12 jars to your order.'); return; }
  cart[productId] = (cart[productId] || 0) + quantity;
  updateCartUI();
}
function updateCart(productId, change) {
  if (change > 0 && totalJars() + change > 12) { showMessage('Maximum limit of 12 jars reached.'); return; }
  cart[productId] = (cart[productId] || 0) + change;
  if (cart[productId] <= 0) delete cart[productId];
  updateCartUI();
}
function handleClearCart() { cart = {}; updateCartUI(); }

document.addEventListener('DOMContentLoaded', async () => {
  try {
    [products, markets, promotion] = await Promise.all([getProducts(), getMarkets(), getPromotionConfig()]);
    try {
      const savedCart = JSON.parse(localStorage.getItem('mammothCart') || '{}');
      if (savedCart && typeof savedCart === 'object' && !Array.isArray(savedCart)) {
        for (const [id, quantity] of Object.entries(savedCart)) {
          const product = products.find(product => product.id === id) || products.find(product => product.id === `prod_${id}`);
          if (product && product.active !== false && product.available !== false && Number.isInteger(quantity) && quantity > 0) cart[product.id] = (cart[product.id] || 0) + quantity;
        }
      }
    } catch { cart = {}; showMessage('Your saved cart could not be restored. Please add your broth again.'); }
    renderProducts(products, handleAddToCart);
    renderMarkets(markets);
    document.getElementById('market-select').addEventListener('change', updatePickupDate);
    updatePickupDate();
    updateCartUI();
  } catch { console.error('Error initializing storefront.'); showMessage('Could not load store data. Please try again later.'); }
  document.getElementById('order-form').addEventListener('submit', handleOrderSubmit);
  document.getElementById('pay-at-pickup-button').addEventListener('click', handlePayAtPickup);
  document.getElementById('clear-cart-button').addEventListener('click', handleClearCart);
  document.querySelectorAll('input[name="payment-method"]').forEach(input => input.addEventListener('change', syncFulfillmentUI));
  const invalidateForm = event => {
    if (document.getElementById('payment-element').contains(event?.target)) return;
    invalidateCheckout();
  };
  document.getElementById('order-form').addEventListener('input', invalidateForm);
  document.getElementById('order-form').addEventListener('change', invalidateForm);
  syncFulfillmentUI();
});
