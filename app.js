import { getProducts, getMarkets, getPromotionConfig, createPaymentIntent, createPreorder, calculateCartTotal } from './store.js';
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
}

function syncFulfillmentUI() {
  const method = selectedFulfillmentMethod();
  const isPickup = method === FULFILLMENT_METHODS.MARKET_PICKUP;
  const isDelivery = method === FULFILLMENT_METHODS.LOCAL_DELIVERY;
  const isSpecial = method === FULFILLMENT_METHODS.SPECIAL_ORDER;
  document.getElementById('local-delivery-option').disabled = !stripe;
  document.getElementById('delivery-availability').hidden = Boolean(stripe);
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
  resetPaymentElement();
}

async function preparePaymentElement() {
  if (!stripe || elements || selectedFulfillmentMethod() === FULFILLMENT_METHODS.SPECIAL_ORDER) return Boolean(elements);
  const errors = validateOrderDetails();
  if (errors.length) return false;
  try {
    const result = await createPaymentIntent({ cart, ...fulfillmentDetails() });
    elements = stripe.elements({ clientSecret: result.data.clientSecret });
    paymentElement = elements.create('payment');
    paymentElement.mount('#payment-element');
    document.getElementById('payment-element').hidden = false;
    return true;
  } catch (error) {
    console.error('Payment setup error:', error);
    showMessage('Secure payment is not configured yet. Please try again later or choose Pay at Pickup.');
    return false;
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
  if (!elements && !(await preparePaymentElement())) {
    showMessage('Secure payment fields are still loading. Please try again.');
    return;
  }
  setLoading(true);
  const orderForStripe = createDetailedOrder('stripe', 'paid');
  localStorage.setItem('pendingOrder', JSON.stringify(orderForStripe));
  try {
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/thank-you.html` },
      redirect: 'if_required'
    });
    if (error) {
      showMessage(error.message || 'Payment could not be completed.');
      localStorage.removeItem('pendingOrder');
    } else if (paymentIntent?.status === 'succeeded') {
      const finalOrder = { ...orderForStripe, paymentIntentId: paymentIntent.id };
      const result = await createPreorder({ ...finalOrder, idempotencyKey: finalOrder.orderName || `${paymentIntent.id}-${Date.now()}`, orderName: finalOrder.orderName });
      finalOrder.firestoreId = result.data?.orderId || null;
      const saved = JSON.parse(localStorage.getItem('mammothOrders') || '[]');
      saved.unshift(finalOrder);
      localStorage.setItem('mammothOrders', JSON.stringify(saved));
      localStorage.removeItem('pendingOrder');
      showMessage('Payment successful! You will receive a confirmation email.', 10000);
      handleClearCart();
    }
  } catch (error) {
    console.error('Payment Error:', error);
    localStorage.removeItem('pendingOrder');
    showMessage('An error occurred during payment. Please try again.');
  } finally {
    setLoading(false);
  }
}

function updateCartUI() {
  resetPaymentElement();
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
    [products, markets, promotion] = await Promise.all([getProducts(), getMarkets(), getPromotionConfig()]);
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
  ['customer-name', 'customer-email', 'delivery-street', 'delivery-city', 'delivery-state', 'delivery-zip'].forEach(id => {
    document.getElementById(id)?.addEventListener('blur', preparePaymentElement);
  });
  syncFulfillmentUI();
});
