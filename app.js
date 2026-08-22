import { getProducts, getMarkets, getPromotionConfig, createPaymentIntent, createPreorder, calculateCartTotal } from './store.js'; // Assuming createPaymentIntent calls your new cloud function
import { renderProducts, renderMarkets, updateCartSummary } from './ui.js';
import { checkout } from './checkout.js';

// --- State Management ---
let products = [];
let markets = [];
let promotion = undefined;
let cart = {}; // { productId: quantity }

// --- Stripe Variables ---
// IMPORTANT: Replace with your actual Stripe publishable key. This key is safe to be public.
const STRIPE_PUBLISHABLE_KEY = 'pk_test_YOUR_REAL_PUBLISHABLE_KEY';
const stripe = STRIPE_PUBLISHABLE_KEY.includes('YOUR_') ? null : Stripe(STRIPE_PUBLISHABLE_KEY);
let elements;
let paymentElement;

function nextMarketDate(weekday) {
    const date = new Date();
    const offset = (Number(weekday) - date.getDay() + 7) % 7 || 7;
    date.setDate(date.getDate() + offset);
    return date.toISOString().slice(0, 10);
}

// --- Application Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        [products, markets, promotion] = await Promise.all([
            getProducts(),
            getMarkets(),
            getPromotionConfig()
        ]);
        
        // Load cart from localStorage
        const savedCart = localStorage.getItem('mammothCart');
        if (savedCart) {
            cart = JSON.parse(savedCart);
        }

        renderProducts(products, handleAddToCart);
        renderMarkets(markets);
        const marketSelect = document.getElementById('market-select');
        const pickupDate = document.getElementById('pickup-date');
        const updatePickupDate = () => {
            const option = marketSelect.selectedOptions[0];
            if (option && option.dataset.weekday !== '') pickupDate.value = nextMarketDate(option.dataset.weekday);
        };
        marketSelect.addEventListener('change', updatePickupDate);
        updatePickupDate();
        
        // Initialize cart UI with loaded data
        updateCartUI();
    } catch (error) {
        console.error("Error initializing app:", error);
        alert("Could not load store data. Please try again later.");
    }

    document.getElementById('order-form').addEventListener('submit', handleOrderSubmit);
    document.getElementById('pay-at-pickup-button').addEventListener('click', handlePayAtPickup);
    document.getElementById('clear-cart-button').addEventListener('click', handleClearCart);
});

// --- Helper Functions ---
function createDetailedOrder(customerName, customerEmail, marketId, paymentMethod, status) {
    const { items, total, discount, subtotal } = calculateCartTotal(cart, products, promotion);
    const marketOption = document.getElementById('market-select')?.selectedOptions[0];

    return {
        customerName,
        customerEmail,
        cart: { ...cart },
        marketId,
        marketName: marketOption?.textContent || '',
        productSummary: items.map(item => `${item.quantity} × ${item.name}`).join(', '),
        items,
        totalAmount: total,
        subtotal: subtotal,
        discountAmount: discount,
        status,
        paymentMethod,
        pickupDate: document.getElementById('pickup-date')?.value || '',
        createdAt: new Date().toISOString()
    };
}

// --- Event Handlers ---
function handleAddToCart(productId, quantity) {
    const currentTotal = Object.values(cart).reduce((a, b) => a + b, 0);
    
    if (currentTotal + quantity > 12) {
        alert("You cannot add more than 12 jars to your order.");
        return;
    }

    cart[productId] = (cart[productId] || 0) + quantity;
    updateCartUI();
}

function updateCart(productId, change) {
    // Check for max limit when adding items
    if (change > 0) {
        const currentTotal = Object.values(cart).reduce((a, b) => a + b, 0);
        if (currentTotal + change > 12) {
            alert("Maximum limit of 12 jars reached.");
            return;
        }
    }

    cart[productId] = (cart[productId] || 0) + change;
    if (cart[productId] <= 0) {
        delete cart[productId];
    }
    updateCartUI();
}

function handleClearCart() {
    cart = {};
    updateCartUI();
}

async function handlePayAtPickup() {
    const customerName = document.getElementById('customer-name').value;
    const customerEmail = document.getElementById('customer-email').value;
    const marketId = document.getElementById('market-select').value;

    if (Object.keys(cart).length === 0) {
        showMessage("Your cart is empty.");
        return;
    }

    if (!customerName || !customerEmail || !marketId) {
        showMessage("Please fill out all fields.");
        return;
    }

    const order = createDetailedOrder(customerName, customerEmail, marketId, 'pickup', 'pending');

    // Show the confirmation modal for "Pay at Pickup"
    checkout(order).then(() => {
        handleClearCart();
    });
}

async function handleOrderSubmit(e) {
    e.preventDefault();
    if (!stripe) {
        showMessage("Online payment is being connected. Choose Pay at Pickup to reserve your broth today.");
        return;
    }
    setLoading(true);

    const customerName = document.getElementById('customer-name').value;
    const customerEmail = document.getElementById('customer-email').value;
    const marketId = document.getElementById('market-select').value;

    if (!customerName || !customerEmail || !marketId) {
        showMessage("Please fill out all customer and market details.");
        setLoading(false);
        return;
    }

    // Save order details to localStorage in case of a redirect
    const orderForStripe = createDetailedOrder(customerName, customerEmail, marketId, 'stripe', 'paid');
    localStorage.setItem('pendingOrder', JSON.stringify(orderForStripe));

    try {
        const { error, paymentIntent } = await stripe.confirmPayment({
            elements,
            confirmParams: {
                return_url: `${window.location.origin}/thank-you.html`,
            },
            redirect: 'if_required'
        });

        // This point is only reached if payment succeeds without a redirect
        if (error) {
            if (error.type === "card_error" || error.type === "validation_error") {
                showMessage(error.message);
            } else {
                showMessage("An unexpected error occurred.");
            }
            localStorage.removeItem('pendingOrder'); // Clean up on error
        } else if (paymentIntent && paymentIntent.status === 'succeeded') {
            // Payment succeeded without redirect.
            const finalOrder = { ...orderForStripe, paymentIntentId: paymentIntent.id };
            const result = await createPreorder({
                cart: finalOrder.cart,
                customerName: finalOrder.customerName,
                customerEmail: finalOrder.customerEmail,
                marketId: finalOrder.marketId,
                pickupDate: finalOrder.pickupDate,
                paymentMethod: 'stripe',
                paymentIntentId: paymentIntent.id,
                idempotencyKey: finalOrder.orderName,
                orderName: finalOrder.orderName
            });
            finalOrder.firestoreId = result.data?.orderId || null;
            const saved = JSON.parse(localStorage.getItem('mammothOrders') || '[]');
            saved.unshift(finalOrder);
            localStorage.setItem('mammothOrders', JSON.stringify(saved));
            showMessage("Payment successful! You will receive a confirmation email.");
            localStorage.removeItem('pendingOrder'); // Clean up
            handleClearCart();
        }
    } catch (error) {
        console.error("Payment Error:", error);
        showMessage("An error occurred during payment. Please try again.");
        localStorage.removeItem('pendingOrder');
    }

    setLoading(false);
}

// --- UI & Cart Logic ---
function updateCartUI() {
    localStorage.setItem('mammothCart', JSON.stringify(cart));
    updateCartSummary(cart, products, updateCart, promotion);
}

function showMessage(message) {
    const messageContainer = document.getElementById("payment-message");
    messageContainer.classList.remove("hidden");
    messageContainer.textContent = message;
    setTimeout(() => {
        messageContainer.classList.add("hidden");
        messageContainer.textContent = '';
    }, 5000);
}
