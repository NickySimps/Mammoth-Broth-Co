import { calculateCartTotal } from './store.js';

const productListEl = document.getElementById('product-list');
const marketSelectEl = document.getElementById('market-select');
const cartSummaryEl = document.getElementById('cart-summary');

export function renderProducts(products, addToCartCallback) {
    productListEl.innerHTML = ''; // Clear existing products
    products.filter(product => product.active !== false).forEach(product => {
        const unavailable = product.available === false;
        const card = document.createElement('div');
        card.className = 'panel-primitive product-card';
        card.innerHTML = `
            <div class="product-image-wrap"><img src="${product.imageUrl || 'assets/mammothbrothlogo.jpg'}" alt="${product.name}" class="product-image">${unavailable ? '<span class="product-badge">Batch spoken for</span>' : '<span class="product-badge product-badge-available">Small batch</span>'}</div>
            <h3 class="font-caveman">${product.name}</h3>
            <p class="product-description">${product.description}</p>
            <div class="product-story" aria-label="Batch details"><span>24-hour simmer</span><span>Made for pickup</span></div>
            <p class="product-price"><span>$${(product.price / 100).toFixed(2)}</span> <small>per jar</small></p>
            ${product.stockMessage ? `<p class="stock-message">${product.stockMessage}</p>` : ''}
            <div class="quantity-selector" aria-label="Quantity for ${product.name}">
                <button class="btn-quantity-change" aria-label="Decrease ${product.name} quantity" data-id="${product.id}" data-change="-1" ${unavailable ? 'disabled' : ''}>−</button>
                <input type="number" class="quantity-input" aria-label="${product.name} quantity" data-id="${product.id}" value="1" min="1" ${unavailable ? 'disabled' : ''}>
                <button class="btn-quantity-change" aria-label="Increase ${product.name} quantity" data-id="${product.id}" data-change="1" ${unavailable ? 'disabled' : ''}>+</button>
            </div>
            <button class="add-to-cart-btn btn-primitive font-caveman" data-id="${product.id}" ${unavailable ? 'disabled' : ''}>${unavailable ? 'Batch spoken for' : 'Add to cache'}</button>
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

    const weekdayByMarket = { market_atlantic: 0, market_palm: 2, market_murray: 3, market_ponte_vedra: 5 };
    sortedMarkets.forEach(market => {
        const option = document.createElement('option');
        option.value = market.id;
        const capacityFull = Number(market.capacity || 0) > 0 && Number(market.reservedCount || 0) >= Number(market.capacity);
        const cutoffPassed = market.orderCutoffAt && !Number.isNaN(new Date(market.orderCutoffAt).getTime()) && Date.now() >= new Date(market.orderCutoffAt).getTime();
        const unavailable = market.active === false || capacityFull || cutoffPassed;
        option.textContent = `${market.name}${capacityFull ? ' · Full' : cutoffPassed ? ' · Closed for orders' : ''}`;
        option.disabled = unavailable;
        option.dataset.weekday = market.weekday ?? weekdayByMarket[market.id] ?? '';
        option.dataset.cutoffAt = market.orderCutoffAt || '';
        marketSelectEl.appendChild(option);
    });
}

export function updateCartSummary(cart, products, updateCartCallback, promotion) {
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

    const { items, total, discount } = calculateCartTotal(cart, products, promotion);

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
