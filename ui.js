const productListEl = document.getElementById('product-list');
const marketSelectEl = document.getElementById('market-select');
const cartSummaryEl = document.getElementById('cart-summary');

export function renderProducts(products, addToCartCallback) {
    productListEl.innerHTML = ''; // Clear existing products
    products.forEach(product => {
        const card = document.createElement('div');
        card.className = 'panel-primitive product-card';
        card.innerHTML = `
            <img src="${product.imageUrl || 'assets/logo.png'}" alt="${product.name}" class="product-image">
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
    markets.forEach(market => {
        const option = document.createElement('option');
        option.value = market.id;
        option.textContent = market.name;
        marketSelectEl.appendChild(option);
    });
}

export function updateCartSummary(cart, products, updateCartCallback) {
    if (Object.keys(cart).length === 0) {
        cartSummaryEl.innerHTML = '<p>Your cart is empty.</p>';
        return;
    }

    let summaryHTML = '<ul>';
    let total = 0;

    for (const productId in cart) {
        const product = products.find(p => p.id === productId);
        if (product) {
            const quantity = cart[productId];
            summaryHTML += `<li>
                ${product.name} x ${quantity}
                <button class="btn-cart-quantity-change" data-id="${productId}" data-change="-1">-</button>
                <button class="btn-cart-quantity-change" data-id="${productId}" data-change="1">+</button>
            </li>`;
            total += product.price * quantity;
        }
    }

    summaryHTML += '</ul>';
    summaryHTML += `<p><strong>Total: ${(total / 100).toFixed(2)}</strong></p>`;
    cartSummaryEl.innerHTML = summaryHTML;

    document.querySelectorAll('.btn-cart-quantity-change').forEach(button => {
        button.addEventListener('click', (e) => {
            const productId = e.target.dataset.id;
            const change = parseInt(e.target.dataset.change, 10);
            updateCartCallback(productId, change);
        });
    });
}
