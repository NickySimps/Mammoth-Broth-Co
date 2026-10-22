document.addEventListener('DOMContentLoaded', () => {
    const hamburgerBtn = document.getElementById('mobile-menu-btn');
    const nav = document.querySelector('nav');
    const stickyNav = document.querySelector('.sticky-nav-container');
    const mobile = window.matchMedia('(max-width: 900px)');
    const normalizePage = pathname => (pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
    const currentPage = normalizePage(window.location.pathname);
    const updateNavHeight = () => {
        document.documentElement.style.setProperty('--sticky-nav-height', `${Math.ceil(stickyNav?.getBoundingClientRect().height || 0)}px`);
    };
    const setMenu = expanded => {
        nav?.classList.toggle('active', expanded);
        hamburgerBtn?.classList.toggle('open', expanded);
        hamburgerBtn?.setAttribute('aria-expanded', String(expanded));
        if (nav) {
            nav.inert = mobile.matches && !expanded;
            nav.setAttribute('aria-hidden', String(nav.inert));
        }
        updateNavHeight();
    };
    const scrollToSection = (id, { behavior = 'auto', focus = true } = {}) => {
        const target = document.getElementById(id);
        if (!target || target.closest('[hidden]')) return false;
        setMenu(false);
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : behavior;
        target.scrollIntoView({ block: 'start', behavior: motion });
        if (focus) {
            if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
        }
        return true;
    };
    window.mammothNavigation = { scrollToSection };
    if (hamburgerBtn) {
        hamburgerBtn.type = 'button';
        hamburgerBtn.setAttribute('aria-controls', nav?.id || 'primary-navigation');
        hamburgerBtn.addEventListener('click', () => setMenu(!nav?.classList.contains('active')));
    }
    if (nav && !nav.id) nav.id = 'primary-navigation';
    setMenu(false);
    mobile.addEventListener('change', () => setMenu(false));
    window.addEventListener('resize', updateNavHeight);
    window.addEventListener('pageshow', () => setMenu(false));
    if (window.ResizeObserver && stickyNav) new window.ResizeObserver(updateNavHeight).observe(stickyNav);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && nav?.classList.contains('active')) {
            event.preventDefault();
            setMenu(false);
            hamburgerBtn?.focus({ preventScroll: true });
        }
    });
    document.addEventListener('click', event => {
        const link = event.target.closest('a[href]');
        if (event.defaultPrevented || !link || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || link.getAttribute('target') === '_blank') return;
        const destination = new URL(link.getAttribute('href'), window.location.href);
        const current = new URL(window.location.href);
        if (destination.origin !== current.origin || destination.pathname !== current.pathname || destination.search !== current.search || !destination.hash) return;
        let id;
        try { id = decodeURIComponent(destination.hash.slice(1)); } catch { return; }
        if (!document.getElementById(id)) return;
        event.preventDefault();
        if (current.hash !== destination.hash) window.history.pushState(null, '', destination.href);
        scrollToSection(id, { behavior: 'smooth' });
    });
    nav?.querySelectorAll('a').forEach(link => {
        const target = new URL(link.getAttribute('href'), window.location.href);
        if (normalizePage(target.pathname) === currentPage) link.setAttribute('aria-current', 'page');
    });

    const accountLink = nav?.querySelector('.nav-account');
    const renderAccountLink = (user = readCachedUser()) => {
        if (!accountLink) return;
        const name = user?.displayName || user?.email?.split('@')[0];
        accountLink.textContent = name ? `Hello, ${name}` : 'Sign in';
        accountLink.setAttribute('aria-label', name ? `Hello, ${name}. Open your account` : 'Sign in to your account');
        accountLink.classList.toggle('is-signed-in', Boolean(name));
        accountLink.setAttribute('href', `./account.html#${name ? 'orders-card' : 'auth-card'}`);
    };

    const readCachedUser = () => {
        try { return JSON.parse(localStorage.getItem('mammothUser') || 'null'); } catch { return null; }
    };

    renderAccountLink();
    window.addEventListener('mammoth-auth-changed', event => renderAccountLink(event.detail));
    window.addEventListener('storage', event => {
        if (event.key === 'mammothUser') renderAccountLink(readCachedUser());
    });

    // Preserve reload/back restoration; only new arrivals should land on an anchor.
    const navigationType = window.performance?.getEntriesByType('navigation')[0]?.type;
    const freshArrival = navigationType !== 'reload' && navigationType !== 'back_forward';
    let accountTarget = null;
    let interacted = false;
    ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(type => window.addEventListener(type, () => { interacted = true; }, { once: true, passive: true }));
    const alignArrival = () => {
        if (!freshArrival || interacted) return;
        let id;
        try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
        if (currentPage === 'account') id = accountTarget || (document.getElementById('auth-card')?.hidden ? 'orders-card' : 'auth-card');
        if (id) scrollToSection(id);
    };
    window.addEventListener('mammoth-account-ready', event => {
        const nextTarget = event.detail?.target;
        if (currentPage !== 'account' || !['auth-card', 'orders-card'].includes(nextTarget) || nextTarget === accountTarget) return;
        const previousTarget = accountTarget;
        accountTarget = nextTarget;
        if ((freshArrival && !interacted) || previousTarget) {
            window.history.replaceState(null, '', `#${nextTarget}`);
            scrollToSection(nextTarget);
        }
    });

    requestAnimationFrame(alignArrival);
    window.addEventListener('load', alignArrival);
});
