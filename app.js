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
        
        // Load cart from localStorage
        const savedCart = localStorage.getItem('mammothCart');
        if (savedCart) {
            cart = JSON.parse(savedCart);
        }

        renderProducts(products, handleAddToCart);
        renderMarkets(markets);
        
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
    const items = [];
    let totalAmount = 0;

    for (const [productId, quantity] of Object.entries(cart)) {
        const product = products.find(p => p.id === productId);
        if (product) {
            const itemTotal = product.price * quantity;
            totalAmount += itemTotal;
            items.push({
                productId,
                name: product.name,
                price: product.price,
                quantity,
                itemTotal
            });
        }
    }

    return {
        customerName,
        customerEmail,
        marketId,
        items,
        totalAmount,
        status,
        paymentMethod,
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
    localStorage.setItem('mammothCart', JSON.stringify(cart));
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
