document.addEventListener('DOMContentLoaded', () => {
    const hamburgerBtn = document.getElementById('mobile-menu-btn');
    const nav = document.querySelector('nav');

    if (hamburgerBtn && nav) {
        hamburgerBtn.addEventListener('click', () => {
            nav.classList.toggle('active');
            hamburgerBtn.classList.toggle('open');
            
            // Accessibility
            const isExpanded = hamburgerBtn.classList.contains('open');
            hamburgerBtn.setAttribute('aria-expanded', isExpanded);
        });
    }
});
