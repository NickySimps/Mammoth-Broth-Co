import { getProducts, calculateCartTotal } from './store.js';

document.addEventListener('DOMContentLoaded', async () => {
    // --- Create Floating Buttons Container ---
    const floatContainer = document.createElement('div');
    floatContainer.className = 'floating-buttons-container';
    document.body.appendChild(floatContainer);

    // --- Back to Top Button ---
    const backToTopBtn = document.createElement('button');
    backToTopBtn.className = 'float-btn back-to-top';
    backToTopBtn.innerHTML = '↑'; // Simple arrow, can be replaced with SVG
    backToTopBtn.setAttribute('aria-label', 'Back to Top');
    floatContainer.appendChild(backToTopBtn);

    // Scroll Logic
    window.addEventListener('scroll', () => {
        if (window.scrollY > 300) {
            floatContainer.classList.add('scrolled');
        } else {
            floatContainer.classList.remove('scrolled');
        }
    });

    backToTopBtn.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });

    // --- Floating Cart Button ---
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

    // Initialize Data
    try {
        currentProducts = await getProducts();
        const savedCart = localStorage.getItem('mammothCart');
        if (savedCart) {
            currentCart = JSON.parse(savedCart);
            // Calculate initial count
            const initialCount = Object.values(currentCart).reduce((a, b) => a + b, 0);
            updateFloatingCartCount(initialCount);
        }
    } catch (err) {
        console.error("Failed to initialize floating cart:", err);
    }

    // Open Modal
    cartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        renderCartModal();
        if (cartModal) cartModal.style.display = 'block';
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

    // --- "Proceed to Checkout" Button Focus Logic ---
    const checkoutLink = cartModal?.querySelector('a[href*="#order-section"]');
    if (checkoutLink) {
        checkoutLink.addEventListener('click', (e) => {
            const orderSection = document.getElementById('order-section');
            if (orderSection) {
                // If we are already on a page with the order section, handle it smoothly
                e.preventDefault();
                cartModal.style.display = 'none';
                
                orderSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                
                // Add highlight effect
                orderSection.classList.add('highlight-focus');
                setTimeout(() => {
                    orderSection.classList.remove('highlight-focus');
                }, 1500);
            }
            // If orderSection doesn't exist, let the default link behavior take over (redirect to shop.html#order-section)
        });
    }

    function renderCartModal() {
        if (!cartModalItems) return;
        
        cartModalItems.innerHTML = '';
        
        const { items, total, discount } = calculateCartTotal(currentCart, currentProducts);
        const hasItems = items.length > 0;

        items.forEach(item => {
            const itemDiv = document.createElement('div');
            itemDiv.style.display = 'flex';
            itemDiv.style.justifyContent = 'space-between';
            itemDiv.style.marginBottom = '10px';
            itemDiv.style.borderBottom = '1px solid rgba(0,0,0,0.1)';
            itemDiv.style.paddingBottom = '10px';
            
            itemDiv.innerHTML = `
                <div>
                    <span class="font-caveman" style="font-size: 1.1rem;">${item.name}</span>
                    <div style="font-size: 0.9rem; color: #666;">Qty: ${item.quantity}</div>
                </div>
                <div class="font-caveman">
                    $${(item.itemTotal / 100).toFixed(2)}
                </div>
            `;
            cartModalItems.appendChild(itemDiv);
        });

        if (!hasItems) {
            cartModalItems.innerHTML = '<p style="text-align: center;">Your cache is empty.</p>';
            cartModalFooter.classList.add('hidden');
        } else {
            cartModalFooter.classList.remove('hidden');
            
            let totalHtml = '';
            if (discount > 0) {
                 totalHtml += `<div style="color: green; font-size: 0.9em;">Savings: -$${(discount / 100).toFixed(2)}</div>`;
            }
            totalHtml += `$${(total / 100).toFixed(2)}`;
            cartModalTotal.innerHTML = totalHtml;
        }
    }

    // --- Cart Count Logic ---
    function updateFloatingCartCount(count) {
        const countBadge = document.getElementById('floating-cart-count');
        if (!countBadge) return;
        
        if (count > 0) {
            countBadge.textContent = count;
            countBadge.classList.remove('hidden');
            cartBtn.classList.add('has-contents');
        } else {
            countBadge.classList.add('hidden');
            cartBtn.classList.remove('has-contents');
        }
    }

    // Listen for updates from Shop page (if we are on it)
    window.addEventListener('cartUpdated', (e) => {
        const { count, cart, products } = e.detail;
        currentCart = cart || {};
        if (products) currentProducts = products;
        
        updateFloatingCartCount(count);
        
        // Trigger Animation
        cartBtn.classList.remove('cart-animate'); // Reset animation
        void cartBtn.offsetWidth; // Trigger reflow to restart animation
        cartBtn.classList.add('cart-animate');
        
        // If modal is open, re-render it
        if (cartModal && cartModal.style.display === 'block') {
            renderCartModal();
        }
    });
});