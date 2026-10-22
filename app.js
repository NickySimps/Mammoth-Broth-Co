import { getProducts, getMarkets, getPromotionConfig, createPaymentIntent, getDeliveryPolicy, getDeliveryQuote, getGuestReceipt, calculateCartTotal } from './store.js';
import { createCheckoutRevision, deliveryEligibility, deliveryQuoteText, rememberAttemptReceipt, receiptHref, formatMoney } from './commerce-ui.mjs';
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
let deliveryPolicy = null;
let deliveryQuote = null;
let preparedPayment = null;
let setupPending = null;
let quoteSequence = 0;
const checkoutRevision = createCheckoutRevision(() => globalThis.crypto.randomUUID(), { storage: sessionStorage, crypto: globalThis.crypto, scope: 'card' });

function paymentPayload() {
  return { cart: { ...cart }, customerName: document.getElementById('customer-name').value.trim(), customerEmail: document.getElementById('customer-email').value.trim(), ...fulfillmentDetails() };
}
function currentAttempt(attempt) {
  return checkoutRevision.isCurrent(attempt) && attempt.signature === JSON.stringify(paymentPayload());
}
function invalidateCheckout() {
  checkoutRevision.invalidate();
  quoteSequence++;
  deliveryQuote = null;
  resetPaymentElement();
  if (selectedFulfillmentMethod() === FULFILLMENT_METHODS.LOCAL_DELIVERY) deliveryStatus(deliveryEligibility(deliveryPolicy, totalJars(), deliveryAddress()) || 'Check delivery and review a fresh quote before payment.');
}
function deliveryStatus(text) {
  const status = document.getElementById('delivery-quote-status');
  if (status) status.textContent = text;
}
function sameQuote(a, b) {
  return a && b && ['deliveryFee', 'deliveryDate', 'totalAmount'].every(key => a[key] === b[key]);
}
async function requestDeliveryQuote() {
  if (submitting || selectedFulfillmentMethod() !== FULFILLMENT_METHODS.LOCAL_DELIVERY) return;
  const eligibility = deliveryEligibility(deliveryPolicy, totalJars(), deliveryAddress());
  if (eligibility) { deliveryStatus(eligibility); return; }
  let attempt;
  try { attempt = checkoutRevision.begin(paymentPayload()); }
  catch {
    deliveryStatus('Pending order capability is unavailable. Contact us before creating another order.');
    return;
  }
  const sequence = ++quoteSequence;
  resetPaymentElement();
  deliveryQuote = null;
  deliveryStatus('Checking delivery…');
  try {
    const { data } = await getDeliveryQuote({ cart: { ...cart }, address: deliveryAddress() });
    if (!currentAttempt(attempt) || sequence !== quoteSequence) return;
    const text = deliveryQuoteText(data, deliveryPolicy);
    deliveryQuote = data;
    deliveryStatus(`${text} Review these terms, then continue to secure payment.`);
  } catch {
    if (currentAttempt(attempt) && sequence === quoteSequence) deliveryStatus('Delivery could not be verified. Retry the quote or choose market pickup.');
  }
}

const stripe = STRIPE_PUBLISHABLE_KEY.includes('YOUR_') || typeof Stripe !== 'function'
  ? null
  : Stripe(STRIPE_PUBLISHABLE_KEY);

function nextMarketDate(weekday) {
  if (weekday === '' || weekday == null || !Number.isInteger(Number(weekday)) || Number(weekday) < 0 || Number(weekday) > 6) return '';
  const date = new Date();
  const offset = (Number(weekday) - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function selectedFulfillmentMethod() {
  return document.querySelector('input[name="fulfillment-method"]:checked')?.value || FULFILLMENT_METHODS.MARKET_PICKUP;
}

function totalJars() {
  return Object.values(cart).reduce((sum, quantity) => sum + Number(quantity), 0);
}

function deliveryAddress() {
  return {
    street: document.getElementById('delivery-street')?.value || '',
    city: document.getElementById('delivery-city')?.value || '',
    state: document.getElementById('delivery-state')?.value || '',
    zip: document.getElementById('delivery-zip')?.value || ''
  };
}

function fulfillmentDetails() {
  const method = selectedFulfillmentMethod();
  return {
    fulfillmentMethod: method,
    marketId: method === FULFILLMENT_METHODS.MARKET_PICKUP ? document.getElementById('market-select')?.value || '' : '',
    pickupDate: method === FULFILLMENT_METHODS.MARKET_PICKUP ? document.getElementById('pickup-date')?.value || '' : '',
    deliveryAddress: method === FULFILLMENT_METHODS.LOCAL_DELIVERY ? deliveryAddress() : null,
    specialNotes: method === FULFILLMENT_METHODS.SPECIAL_ORDER ? document.getElementById('special-order-notes')?.value || '' : ''
  };
}

function validateOrderDetails() {
  const details = fulfillmentDetails();
  const errors = validateFulfillment({
    ...details,
    method: details.fulfillmentMethod,
    notes: details.specialNotes,
    totalJars: totalJars()
  });
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
  const marketOption = document.getElementById('market-select')?.selectedOptions[0];
  return {
    customerName: document.getElementById('customer-name').value.trim(),
    customerEmail: document.getElementById('customer-email').value.trim(),
    cart: { ...cart },
    ...details,
    marketName: details.marketId ? marketOption?.textContent || '' : '',
    productSummary: items.map(item => `${item.quantity} × ${item.name}`).join(', '),
    items,
    totalAmount: total,
    subtotal,
    discountAmount: discount,
    status,
    paymentMethod,
    createdAt: new Date().toISOString()
  };
}

function setLoading(isLoading) {
  submitting = isLoading;
  const buttons = document.querySelectorAll('#checkout-button, #pay-at-pickup-button, #special-order-button');
  buttons.forEach(button => { button.disabled = isLoading; });
  document.getElementById('checkout-button').disabled = isLoading || !stripe;
}

function showMessage(message, timeout = 7000) {
  const messageContainer = document.getElementById('payment-message');
  messageContainer.classList.remove('hidden');
  messageContainer.textContent = message;
  window.clearTimeout(showMessage.timeout);
  showMessage.timeout = window.setTimeout(() => {
    messageContainer.classList.add('hidden');
    messageContainer.textContent = '';
  }, timeout);
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
  const method = selectedFulfillmentMethod();
  const isPickup = method === FULFILLMENT_METHODS.MARKET_PICKUP;
  const isDelivery = method === FULFILLMENT_METHODS.LOCAL_DELIVERY;
  const isSpecial = method === FULFILLMENT_METHODS.SPECIAL_ORDER;
  const configuredDelivery = !deliveryEligibility(deliveryPolicy, 12, { street: 'check', city: 'check', state: deliveryPolicy?.state, zip: deliveryPolicy?.allowedZips?.[0] });
  document.getElementById('local-delivery-option').disabled = !stripe || !configuredDelivery;
  document.getElementById('delivery-availability').hidden = Boolean(stripe && configuredDelivery);
  document.getElementById('market-fulfillment-fields').hidden = !isPickup;
  document.getElementById('delivery-fields').hidden = !isDelivery;
  document.getElementById('special-order-fields').hidden = !isSpecial;
  document.getElementById('market-select').required = isPickup;
  document.getElementById('pickup-date').required = isPickup;
  document.getElementById('payment-heading').hidden = isSpecial || !stripe;
  document.getElementById('payment-element').hidden = true;
  document.getElementById('checkout-button').style.display = isSpecial || !stripe ? 'none' : 'inline-block';
  document.getElementById('checkout-button').disabled = !stripe;
  document.getElementById('pay-at-pickup-button').hidden = !isPickup;
  document.getElementById('special-order-button').hidden = !isSpecial;
  invalidateCheckout();
}

async function preparePaymentElement() {
  if (!stripe || selectedFulfillmentMethod() === FULFILLMENT_METHODS.SPECIAL_ORDER) return false;
  if (elements) return Boolean(preparedPayment && currentAttempt(preparedPayment.attempt));
  if (setupPending) return false;
  const errors = validateOrderDetails();
  if (errors.length) { showMessage(errors.join(' ')); return false; }
  const payload = paymentPayload();
  let attempt;
  try { attempt = checkoutRevision.begin(payload); }
  catch {
    showMessage('Pending order capability is unavailable. Contact us before creating another order.', 20000);
    return false;
  }
  const isDelivery = payload.fulfillmentMethod === FULFILLMENT_METHODS.LOCAL_DELIVERY;
  if (isDelivery) {
    const eligibility = deliveryEligibility(deliveryPolicy, totalJars(), payload.deliveryAddress);
    if (eligibility || !deliveryQuote) {
      deliveryStatus(eligibility || 'Check delivery and review the server quote before payment.');
      return false;
    }
  }
  setupPending = attempt;
  try {
    if (isDelivery) {
      const { data: fresh } = await getDeliveryQuote({ cart: payload.cart, address: payload.deliveryAddress });
      if (!currentAttempt(attempt)) return false;
      const text = deliveryQuoteText(fresh, deliveryPolicy);
      if (!sameQuote(deliveryQuote, fresh)) {
        deliveryQuote = fresh;
        deliveryStatus(`Delivery terms changed. ${text} Review the new terms and continue again; no payment has been taken.`);
        return false;
      }
    }
    const { data: result } = await createPaymentIntent({ ...payload, requestId: attempt.requestId, receiptToken: attempt.receiptToken });
    if (!currentAttempt(attempt)) return false;
    const receipt = rememberAttemptReceipt(result, attempt, sessionStorage);
    if (!receipt) {
      showMessage(`Pending order ${result.orderName || result.orderId} cannot be opened securely. Do not retry with a new order. Contact us with this reference before payment.`, 20000);
      return false;
    }
    if (!result.clientSecret || !Number.isSafeInteger(result.totalAmount) || result.totalAmount < 1) throw new Error('Incomplete payment setup');
    if (isDelivery) {
      // The intent response has only a total. Read the immutable saved order to
      // verify fee/date too; a fresh informational quote cannot prove its terms.
      const { data: persisted } = await getGuestReceipt({ orderId: receipt.orderId, token: receipt.token });
      if (!currentAttempt(attempt)) return false;
      if (!sameQuote(deliveryQuote, persisted) || persisted.totalAmount !== result.totalAmount) {
        deliveryStatus(`Saved order terms differ from the reviewed quote. ${deliveryQuoteText(persisted, deliveryPolicy)} Contact us before payment; no charge was requested.`);
        return false;
      }
    }
    elements = stripe.elements({ clientSecret: result.clientSecret });
    paymentElement = elements.create('payment');
    paymentElement.mount('#payment-element');
    preparedPayment = { attempt, receipt, totalAmount: result.totalAmount };
    document.getElementById('payment-element').hidden = false;
    document.getElementById('checkout-button').textContent = `Pay ${formatMoney(result.totalAmount)}`;
    showMessage(`Order ${result.orderName || result.orderId} is pending. Review ${formatMoney(result.totalAmount)}, enter payment details, then click Pay to submit.`, 15000);
    return true;
  } catch {
    if (currentAttempt(attempt)) showMessage('Secure ordering is unavailable or could not be verified. Retry unchanged details or contact us. No payment was requested.');
    return false;
  } finally {
    if (setupPending === attempt) setupPending = null;
  }
}

async function handleSpecialOrder() {
  if (submitting) return;
  const errors = validateOrderDetails();
  if (errors.length) {
    showMessage(errors.join(' '));
    return;
  }
  setLoading(true);
  try {
    const savedOrder = await checkout(createDetailedOrder('special_order', 'awaiting_approval'));
    if (!savedOrder) return;
    handleClearCart();
    showMessage('Special-order request received. We will review it and contact you before any payment is requested.', 10000);
  } finally {
    setLoading(false);
  }
}

async function handlePayAtPickup() {
  if (submitting) return;
  const errors = validateOrderDetails();
  if (errors.length) {
    showMessage(errors.join(' '));
    return;
  }
  setLoading(true);
  try {
    const savedOrder = await checkout(createDetailedOrder('pickup', 'pending'));
    if (!savedOrder) return;
    handleClearCart();
  } finally {
    setLoading(false);
  }
}

async function handleOrderSubmit(event) {
  event.preventDefault();
  if (submitting) return;
  if (selectedFulfillmentMethod() === FULFILLMENT_METHODS.SPECIAL_ORDER) {
    await handleSpecialOrder();
    return;
  }
  if (!stripe && selectedFulfillmentMethod() === FULFILLMENT_METHODS.MARKET_PICKUP) {
    await handlePayAtPickup();
    return;
  }
  const errors = validateOrderDetails();
  if (errors.length) {
    showMessage(errors.join(' '));
    return;
  }
  if (!stripe) {
    showMessage('Online payment is not configured yet. Choose Pay at Pickup, or try again after Stripe is connected.');
    return;
  }
  if (!elements || !preparedPayment || !currentAttempt(preparedPayment.attempt)) {
    resetPaymentElement();
    setLoading(true);
    try { await preparePaymentElement(); } finally { setLoading(false); }
    // Mounting fields is never consent to charge, including after a retry.
    return;
  }
  const payment = preparedPayment;
  const confirmingElements = elements;
  setLoading(true);
  try {
    const href = new URL(receiptHref(payment.receipt), window.location.origin).href;
    const { error } = await stripe.confirmPayment({
      elements: confirmingElements,
      // Stripe only needs the order reference; the capability stays in session storage.
      confirmParams: { return_url: new URL(`./receipt.html#${new URLSearchParams({ order: payment.receipt.orderId })}`, window.location.origin).href },
      redirect: 'if_required'
    });
    if (!currentAttempt(payment.attempt)) return;
    if (error) {
      showMessage('Payment could not be completed. Check your payment details or open your private receipt before trying again.');
      return;
    }
    // Only the signed webhook establishes payment status. Keep the cart; the
    // private receipt shows pending/review/paid from the durable server order.
    window.location.href = href;
  } catch {
    if (currentAttempt(payment.attempt)) showMessage('Payment status could not be checked. Open your private receipt or contact us before trying another payment.');
  } finally {
    setLoading(false);
  }
}

function updateCartUI() {
  invalidateCheckout();
  try { localStorage.setItem('mammothCart', JSON.stringify(cart)); } catch (error) { console.warn('Cart could not be cached on this device.', error); }
  updateCartSummary(cart, products, updateCart, promotion);
}

function handleAddToCart(productId, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    showMessage('Choose a positive whole number of jars.');
    return;
  }
  if (totalJars() + quantity > 12) {
    showMessage('You cannot add more than 12 jars to your order.');
    return;
  }
  cart[productId] = (cart[productId] || 0) + quantity;
  updateCartUI();
}

function updateCart(productId, change) {
  if (change > 0 && totalJars() + change > 12) {
    showMessage('Maximum limit of 12 jars reached.');
    return;
  }
  cart[productId] = (cart[productId] || 0) + change;
  if (cart[productId] <= 0) delete cart[productId];
  updateCartUI();
}

function handleClearCart() {
  cart = {};
  updateCartUI();
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    [products, markets, promotion, deliveryPolicy] = await Promise.all([getProducts(), getMarkets(), getPromotionConfig(), getDeliveryPolicy().catch(() => null)]);
    try {
      const savedCart = JSON.parse(localStorage.getItem('mammothCart') || '{}');
      if (savedCart && typeof savedCart === 'object' && !Array.isArray(savedCart)) {
        cart = {};
        for (const [id, quantity] of Object.entries(savedCart)) {
          const product = products.find(product => product.id === id) || products.find(product => product.id === `prod_${id}`);
          if (product && product.active !== false && product.available !== false && Number.isInteger(quantity) && quantity > 0) cart[product.id] = (cart[product.id] || 0) + quantity;
        }
      }
    } catch {
      cart = {};
      showMessage('Your saved cart could not be restored. Please add your broth again.');
    }
    renderProducts(products, handleAddToCart);
    renderMarkets(markets);
    const marketSelect = document.getElementById('market-select');
    const pickupDate = document.getElementById('pickup-date');
    const updatePickupDate = () => {
      const option = marketSelect.selectedOptions[0];
      pickupDate.value = nextMarketDate(option?.dataset.weekday);
    };
    marketSelect.addEventListener('change', updatePickupDate);
    updatePickupDate();
    updateCartUI();
  } catch (error) {
    console.error('Error initializing app:', error);
    showMessage('Could not load store data. Please try again later.');
  }

  document.getElementById('order-form').addEventListener('submit', handleOrderSubmit);
  document.getElementById('pay-at-pickup-button').addEventListener('click', handlePayAtPickup);
  document.getElementById('special-order-button').addEventListener('click', handleSpecialOrder);
  document.getElementById('clear-cart-button').addEventListener('click', handleClearCart);
  document.querySelectorAll('input[name="fulfillment-method"]').forEach(input => input.addEventListener('change', syncFulfillmentUI));
  const invalidateForm = event => {
    if (document.getElementById('payment-element').contains?.(event?.target)) return;
    invalidateCheckout();
  };
  document.getElementById('order-form').addEventListener('input', invalidateForm);
  document.getElementById('order-form').addEventListener('change', invalidateForm);
  document.getElementById('delivery-quote-button')?.addEventListener('click', requestDeliveryQuote);
  syncFulfillmentUI();
});
