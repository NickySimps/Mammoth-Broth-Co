import { getProducts, getMarkets, createPaymentIntent, saveOrder } from './store.js'; // Assuming createPaymentIntent calls your new cloud function
import { renderProducts, renderMarkets, updateCartSummary } from './ui.js';
import { checkout } from './checkout.js';

// --- State Management ---
let products = [];
let markets = [];
let cart = {}; // { productId: quantity }

// --- Stripe Variables ---
// IMPORTANT: Replace with your actual Stripe publishable key. This key is safe to be public.
const stripe = Stripe('pk_test_YOUR_REAL_PUBLISHABLE_KEY');
let elements;
let paymentElement;

// --- Application Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        [products, markets] = await Promise.all([
            getProducts(),
            getMarkets()
        ]);
        renderProducts(products, handleAddToCart);
        renderMarkets(markets);
    } catch (error) {
        console.error("Error initializing app:", error);
        alert("Could not load store data. Please try again later.");
    }

    document.getElementById('order-form').addEventListener('submit', handleOrderSubmit);
    document.getElementById('pay-at-pickup-button').addEventListener('click', handlePayAtPickup);
    document.getElementById('clear-cart-button').addEventListener('click', handleClearCart);
});

// --- Event Handlers ---
function handleAddToCart(productId, quantity) {
    cart[productId] = (cart[productId] || 0) + quantity;
    updateCartUI();
}

function updateCart(productId, change) {
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

    const order = {
        cart,
        customerName,
        customerEmail,
        marketId,
        paymentMethod: 'pickup',
        status: 'pending'
    };

    // Show the confirmation modal for "Pay at Pickup"
    checkout(order).then(() => {
        handleClearCart();
    });
}

async function handleOrderSubmit(e) {
    e.preventDefault();
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
    const orderForStripe = { cart, customerName, customerEmail, marketId, paymentMethod: 'stripe', status: 'paid' };
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
            await saveOrder(finalOrder);
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
    updateCartSummary(cart, products, updateCart);
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
