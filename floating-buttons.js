document.addEventListener('DOMContentLoaded', () => {
    // --- Create Floating Buttons Container ---
    const floatContainer = document.createElement('div');
    floatContainer.className = 'floating-buttons-container';
    document.body.appendChild(floatContainer);

    // --- Back to Top Button ---
    const backToTopBtn = document.createElement('button');
    backToTopBtn.className = 'float-btn back-to-top hidden';
    backToTopBtn.innerHTML = '↑'; // Simple arrow, can be replaced with SVG
    backToTopBtn.setAttribute('aria-label', 'Back to Top');
    floatContainer.appendChild(backToTopBtn);

    // Scroll Logic
    window.addEventListener('scroll', () => {
        if (window.scrollY > 300) {
            backToTopBtn.classList.remove('hidden');
        } else {
            backToTopBtn.classList.add('hidden');
        }
    });

    backToTopBtn.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });

    // --- Floating Cart Button ---
    // Check if we are on the shop page to avoid redundancy or complex syncing if needed.
    // However, usually, a persistent cart button is good everywhere.
    
    const cartBtn = document.createElement('a');
    cartBtn.href = './shop.html#order-section'; // Link to cart section
    cartBtn.className = 'float-btn floating-cart';
    cartBtn.setAttribute('aria-label', 'View Cart');
    
    // SVG Icon for Cart
    cartBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-shopping-cart"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
        <span id="floating-cart-count" class="cart-count hidden">0</span>
    `;
    
    floatContainer.appendChild(cartBtn);

    // --- Cart Modal Logic ---
    const cartModal = document.getElementById('cart-modal');
    const cartModalClose = document.getElementById('cart-modal-close');
    const cartModalItems = document.getElementById('cart-modal-items');
    const cartModalFooter = document.getElementById('cart-modal-footer');
    const cartModalTotal = document.getElementById('cart-modal-total');

    let currentCart = {};
    let currentProducts = [];

    // Open Modal
    cartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        renderCartModal();
        cartModal.style.display = 'block';
    });

    // Close Modal
    if (cartModalClose) {
        cartModalClose.addEventListener('click', () => {
            cartModal.style.display = 'none';
        });
    }

    // Close on outside click
    window.addEventListener('click', (e) => {
        if (e.target === cartModal) {
            cartModal.style.display = 'none';
        }
    });

    function renderCartModal() {
        if (!cartModalItems) return;
        
        cartModalItems.innerHTML = '';
        let total = 0;
        let hasItems = false;

        for (const productId in currentCart) {
            const product = currentProducts.find(p => p.id === productId);
            if (product) {
                hasItems = true;
                const quantity = currentCart[productId];
                const itemTotal = product.price * quantity;
                total += itemTotal;

                const itemDiv = document.createElement('div');
                itemDiv.style.display = 'flex';
                itemDiv.style.justifyContent = 'space-between';
                itemDiv.style.marginBottom = '10px';
                itemDiv.style.borderBottom = '1px solid rgba(0,0,0,0.1)';
                itemDiv.style.paddingBottom = '10px';
                
                itemDiv.innerHTML = `
                    <div>
                        <span class="font-caveman" style="font-size: 1.1rem;">${product.name}</span>
                        <div style="font-size: 0.9rem; color: #666;">Qty: ${quantity}</div>
                    </div>
                    <div class="font-caveman">
                        $${(itemTotal / 100).toFixed(2)}
                    </div>
                `;
                cartModalItems.appendChild(itemDiv);
            }
        }

        if (!hasItems) {
            cartModalItems.innerHTML = '<p style="text-align: center;">Your cache is empty.</p>';
            cartModalFooter.classList.add('hidden');
        } else {
            cartModalFooter.classList.remove('hidden');
            cartModalTotal.textContent = `$${(total / 100).toFixed(2)}`;
        }
    }

    // --- Cart Count Logic ---
    function updateFloatingCartCount(count) {
        const countBadge = document.getElementById('floating-cart-count');
        if (count > 0) {
            countBadge.textContent = count;
            countBadge.classList.remove('hidden');
            cartBtn.classList.add('has-contents');
        } else {
            countBadge.classList.add('hidden');
            cartBtn.classList.remove('has-contents');
        }
    }

    window.addEventListener('cartUpdated', (e) => {
        const { count, cart, products } = e.detail;
        currentCart = cart || {};
        currentProducts = products || [];
        
        updateFloatingCartCount(count);
        
        // Trigger Animation
        cartBtn.classList.remove('cart-animate'); // Reset animation
        void cartBtn.offsetWidth; // Trigger reflow to restart animation
        cartBtn.classList.add('cart-animate');
        
        // If modal is open, re-render it
        if (cartModal.style.display === 'block') {
            renderCartModal();
        }
    });
});
