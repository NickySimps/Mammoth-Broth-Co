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

    // --- Cart Count Logic ---
    // We need to sync this with the main app's cart state if possible.
    // Since state is local to app.js (and potentially store.js), we might need a way to communicate.
    // A simple way for a static/MPA site without a shared global state manager is reading from localStorage if app.js saves it there,
    // or listening to a custom event.
    
    // For now, let's setup a listener for a custom event 'cartUpdated' that app.js/store.js can dispatch.
    
    function updateFloatingCartCount(count) {
        const countBadge = document.getElementById('floating-cart-count');
        if (count > 0) {
            countBadge.textContent = count;
            countBadge.classList.remove('hidden');
        } else {
            countBadge.classList.add('hidden');
        }
    }

    window.addEventListener('cartUpdated', (e) => {
        const { count } = e.detail;
        updateFloatingCartCount(count);
    });
    
    // Initial check (if you save cart to localStorage)
    // const savedCart = JSON.parse(localStorage.getItem('mammothCart') || '{}');
    // const initialCount = Object.values(savedCart).reduce((a, b) => a + b, 0);
    // updateFloatingCartCount(initialCount);
});
