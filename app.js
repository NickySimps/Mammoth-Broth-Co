import { getProducts, getMarkets, createPaymentIntent, saveOrder } from './store.js';
import { renderProducts, renderMarkets, updateCartSummary } from './ui.js';

// --- State Management ---
let products = [];
let markets = [];
let cart = {}; // { productId: quantity }

// --- Stripe Variables ---
// IMPORTANT: Replace with your actual Stripe publishable key
const stripe = Stripe('pk_test_YOUR_PUBLISHABLE_KEY');
let elements;

// --- Application Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        [products, markets] = await Promise.all([
            getProducts(),
            getMarkets()
        ]);
        renderProducts(products, handleAddToCart);
        renderMarkets(markets);
        initializeStripe();
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
    updateCartSummary(cart, products, updateCart);
}

function updateCart(productId, change) {
    cart[productId] = (cart[productId] || 0) + change;
    if (cart[productId] <= 0) {
        delete cart[productId];
    }
    updateCartSummary(cart, products, updateCart);
}

function handleClearCart() {
    cart = {};
    updateCartSummary(cart, products, updateCart);
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

    try {
        await saveOrder({ cart, customerName, customerEmail, marketId, paymentMethod: 'pickup' });
        showMessage("Your order has been placed! You can pay at pickup.");
        handleClearCart();
    } catch (error) {
        console.error("Error saving order:", error);
        showMessage("There was an error placing your order. Please try again.");
    }
}

async function handleOrderSubmit(e) {
    e.preventDefault();
    setLoading(true);

    const customerName = document.getElementById('customer-name').value;
    const customerEmail = document.getElementById('customer-email').value;
    const marketId = document.getElementById('market-select').value;

    if (Object.keys(cart).length === 0) {
        showMessage("Your cart is empty.");
        setLoading(false);
        return;
    }

    try {
        // 1. Create a Payment Intent on the server
        const response = await createPaymentIntent({ cart, customerName, customerEmail, marketId });
        const { clientSecret } = response.data;

        // 2. Confirm the payment on the client
        const { error } = await stripe.confirmPayment({
            elements,
            confirmParams: {
                return_url: `${window.location.origin}/thank-you.html`, // Create a thank-you page
                payment_method_data: {
                    billing_details: {
                        name: customerName,
                        email: customerEmail
                    }
                }
            },
        });

        if (error) {
            showMessage(error.message);
        } else {
            showMessage("Payment successful! You will receive a confirmation email.");
            handleClearCart();
        }

    } catch (error) {
        console.error("Payment Error:", error);
        showMessage("An error occurred during payment. Please try again.");
    }

    setLoading(false);
}

// --- Stripe Integration ---
async function initializeStripe() {
    // This function will be called after the payment intent is created
    // For now, we just set up the appearance
    const appearance = { theme: 'stripe' };
    elements = stripe.elements({ appearance });
    const paymentElement = elements.create("payment");
    paymentElement.mount("#payment-element");
}


// --- UI Helper Functions ---
function setLoading(isLoading) {
    const button = document.getElementById('checkout-button');
    if (isLoading) {
        button.disabled = true;
        button.textContent = 'Processing...';
    } else {
        button.disabled = false;
        button.textContent = 'Pay Now';
    }
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
