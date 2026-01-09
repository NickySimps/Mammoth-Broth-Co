import { calculateCartTotal } from './store.js';

const productListEl = document.getElementById('product-list');
const marketSelectEl = document.getElementById('market-select');
const cartSummaryEl = document.getElementById('cart-summary');

export function renderProducts(products, addToCartCallback) {
    productListEl.innerHTML = ''; // Clear existing products
    products.forEach(product => {
        const card = document.createElement('div');
        card.className = 'panel-primitive product-card';
        card.innerHTML = `
            <img src="${product.imageUrl || 'assets/mammothbrothlogo.jpg'}" alt="${product.name}" class="product-image">
            <h3 class="font-caveman">${product.name}</h3>
            <p>${product.description}</p>
            <p class="product-price">${(product.price / 100).toFixed(2)}</p>
            <div class="quantity-selector">
                <button class="btn-quantity-change" data-id="${product.id}" data-change="-1">-</button>
                <input type="number" class="quantity-input" data-id="${product.id}" value="1" min="1">
                <button class="btn-quantity-change" data-id="${product.id}" data-change="1">+</button>
            </div>
            <button class="add-to-cart-btn btn-primitive font-caveman" data-id="${product.id}">Add to Cart</button>
        `;
        productListEl.appendChild(card);
    });

    // Add event listeners to the buttons
    document.querySelectorAll('.add-to-cart-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            const productId = e.target.dataset.id;
            const quantityInput = productListEl.querySelector(`.quantity-input[data-id="${productId}"]`);
            const quantity = parseInt(quantityInput.value, 10);
            addToCartCallback(productId, quantity);
        });
    });

    document.querySelectorAll('.btn-quantity-change').forEach(button => {
        button.addEventListener('click', (e) => {
            const productId = e.target.dataset.id;
            const change = parseInt(e.target.dataset.change, 10);
            const quantityInput = productListEl.querySelector(`.quantity-input[data-id="${productId}"]`);
            let quantity = parseInt(quantityInput.value, 10);
            quantity = Math.max(1, quantity + change);
            quantityInput.value = quantity;
        });
    });
}

export function renderMarkets(markets) {
    marketSelectEl.innerHTML = '<option value="">Select a pickup location...</option>';
    
    // Sort markets by day of the week
    const dayOrder = {
        'market_atlantic': 0,    // Sunday
        'market_palm': 1,        // Tuesday
        'market_murray': 2,      // Wednesday
        'market_ponte_vedra': 3  // Friday
    };

    const sortedMarkets = [...markets].sort((a, b) => {
        return (dayOrder[a.id] ?? 99) - (dayOrder[b.id] ?? 99);
    });

    sortedMarkets.forEach(market => {
        const option = document.createElement('option');
        option.value = market.id;
        option.textContent = market.name;
        marketSelectEl.appendChild(option);
    });
}

export function updateCartSummary(cart, products, updateCartCallback) {
    // Dispatch custom event for floating buttons - ALWAYS dispatch this first
    const count = Object.values(cart).reduce((a, b) => a + b, 0);
    const event = new CustomEvent('cartUpdated', { 
        detail: { 
            count, 
            cart, 
            products 
        } 
    });
    window.dispatchEvent(event);

    if (Object.keys(cart).length === 0) {
        cartSummaryEl.innerHTML = '<p>Your cart is empty.</p>';
        return;
    }

    const { items, total, discount } = calculateCartTotal(cart, products);

    let summaryHTML = '<ul>';
    
    items.forEach(item => {
        summaryHTML += `<li>
            ${item.name} x ${item.quantity}
            <button class="btn-cart-quantity-change" data-id="${item.productId}" data-change="-1">-</button>
            <button class="btn-cart-quantity-change" data-id="${item.productId}" data-change="1">+</button>
        </li>`;
    });

    summaryHTML += '</ul>';

    // Display
    if (discount > 0) {
        summaryHTML += `<p style="color: green;"><strong>Bundle Savings: -$${(discount / 100).toFixed(2)}</strong></p>`;
    }
    summaryHTML += `<p><strong>Total: $${(total / 100).toFixed(2)}</strong></p>`;

    // Limit Warning
    const totalQuantity = Object.values(cart).reduce((a, b) => a + b, 0);
    if (totalQuantity >= 12) {
        summaryHTML += `<p style="color: red; font-weight: bold;">Maximum order limit reached (12 jars).</p>`;
    }
    
    cartSummaryEl.innerHTML = summaryHTML;

    document.querySelectorAll('.btn-cart-quantity-change').forEach(button => {
        const change = parseInt(button.dataset.change, 10);
        // Disable "+" button if limit reached
        if (change === 1 && totalQuantity >= 12) {
            button.disabled = true;
            button.style.opacity = "0.5";
            button.style.cursor = "not-allowed";
        }

        button.addEventListener('click', (e) => {
            const productId = e.target.dataset.id;
            updateCartCallback(productId, change);
        });
    });
}
