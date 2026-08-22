document.addEventListener('DOMContentLoaded', () => {
    const hamburgerBtn = document.getElementById('mobile-menu-btn');
    const nav = document.querySelector('nav');

    if (hamburgerBtn && nav) {
        hamburgerBtn.type = 'button';
        hamburgerBtn.setAttribute('aria-expanded', 'false');
        hamburgerBtn.addEventListener('click', () => {
            nav.classList.toggle('active');
            hamburgerBtn.classList.toggle('open');
            
            // Accessibility
            const isExpanded = hamburgerBtn.classList.contains('open');
            hamburgerBtn.setAttribute('aria-expanded', isExpanded);
        });
    }

    const currentPage = `${window.location.pathname.split('/').pop() || 'index.html'}`;
    nav?.querySelectorAll('a').forEach(link => {
        const href = link.getAttribute('href') || '';
        const target = href.split('/').pop()?.split('#')[0];
        if (target === currentPage) link.setAttribute('aria-current', 'page');
    });

    const accountLink = nav?.querySelector('.nav-account');
    const renderAccountLink = (user = readCachedUser()) => {
        if (!accountLink) return;
        const name = user?.displayName || user?.email?.split('@')[0];
        accountLink.textContent = name ? `Hello, ${name}` : 'Sign in';
        accountLink.setAttribute('aria-label', name ? `Hello, ${name}. Open your account` : 'Sign in to your account');
        accountLink.classList.toggle('is-signed-in', Boolean(name));
    };

    const readCachedUser = () => {
        try { return JSON.parse(localStorage.getItem('mammothUser') || 'null'); } catch { return null; }
    };

    renderAccountLink();
    window.addEventListener('mammoth-auth-changed', event => renderAccountLink(event.detail));
    window.addEventListener('storage', event => {
        if (event.key === 'mammothUser') renderAccountLink(readCachedUser());
    });
});
