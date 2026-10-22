import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pages = ['index', 'shop', 'about', 'markets', 'contact', 'account', 'thank-you', 'admin'];

test('every primary Sign in link targets the actual sign-in form', () => {
    for (const page of pages) {
        const html = readFileSync(`${page}.html`, 'utf8');
        const link = html.match(/<a\b[^>]*class="[^"]*nav-account[^\"]*"[^>]*>/)?.[0];
        assert.ok(link?.includes('href="./account.html#auth-card"'), `${page}: Sign in must bypass the banner`);
    }
});

function navigationHarness({ mobile = true, reducedMotion = false, navigationType = 'navigate' } = {}) {
    const documentEvents = {};
    const windowEvents = {};
    const css = {};
    const scrolls = [];
    const elements = {};
    function element(id) {
        const attrs = {};
        const classes = new Set();
        return elements[id] = {
            id, hidden: false, tabIndex: -1, inert: false, attrs, style: {},
            classList: { contains: key => classes.has(key), toggle(key, force) { const on = force ?? !classes.has(key); if (on) classes.add(key); else classes.delete(key); return on; }, remove: key => classes.delete(key) },
            setAttribute: (key, value) => { attrs[key] = String(value); },
            getAttribute: key => attrs[key] ?? null,
            hasAttribute: key => key in attrs,
            addEventListener(type, callback) { this[type] = callback; },
            getBoundingClientRect: () => ({ height: 72, top: 0, bottom: 72 }),
            getClientRects: () => [{}],
            closest(selector) { return selector === '[hidden]' ? (this.hidden ? this : null) : this; },
            scrollIntoView: options => scrolls.push({ id, ...options }),
            focus(options) { this.focusOptions = options; },
        };
    }
    const nav = element('primary-navigation');
    const button = element('mobile-menu-btn');
    const account = element('account-link');
    account.setAttribute('href', './account.html#auth-card');
    nav.querySelectorAll = () => [account];
    nav.querySelector = () => account;
    element('sticky-nav');
    element('auth-card');
    element('orders-card').hidden = true;
    const document = {
        documentElement: { style: { setProperty: (name, value) => { css[name] = value; } } },
        getElementById: id => elements[id] || null,
        querySelector: selector => selector === 'nav' ? nav : selector === '.sticky-nav-container' ? elements['sticky-nav'] : null,
        addEventListener(type, callback) { documentEvents[type] = callback; },
    };
    const location = { pathname: '/account.html', hash: '#auth-card', href: 'http://localhost/account.html#auth-card' };
    const history = { pushState(_state, _unused, url) { location.hash = new URL(url, location.href).hash; }, replaceState(_state, _unused, url) { location.hash = new URL(url, location.href).hash; } };
    const window = {
        location, history,
        matchMedia: query => ({ matches: query.includes('reduced-motion') ? reducedMotion : mobile, addEventListener() {} }),
        addEventListener(type, callback) { windowEvents[type] = callback; },
        requestAnimationFrame: callback => callback(),
        performance: { getEntriesByType: () => [{ type: navigationType }] },
    };
    const context = vm.createContext({ document, window, history, location, URL, localStorage: { getItem: () => null }, requestAnimationFrame: window.requestAnimationFrame, performance: window.performance });
    vm.runInContext(readFileSync('nav.js', 'utf8'), context);
    documentEvents.DOMContentLoaded();
    return { window, documentEvents, windowEvents, nav, button, account, elements, css, scrolls };
}

test('account anchors land on the form, account-state changes land on the visible panel', () => {
    const h = navigationHarness();
    assert.equal(h.scrolls.at(-1)?.id, 'auth-card');
    assert.equal(h.scrolls.at(-1)?.block, 'start');
    assert.equal(h.elements['auth-card'].focusOptions?.preventScroll, true);
    h.elements['auth-card'].hidden = true;
    h.elements['orders-card'].hidden = false;
    h.windowEvents['mammoth-account-ready']({ detail: { target: 'orders-card' } });
    assert.equal(h.scrolls.at(-1)?.id, 'orders-card');
    assert.equal(h.window.location.hash, '#orders-card');
});

test('collapsed mobile menu is inert, Escape closes it and restores its button', () => {
    const h = navigationHarness();
    assert.equal(h.nav.inert, true);
    h.button.click();
    assert.equal(h.nav.inert, false);
    assert.equal(h.button.attrs['aria-expanded'], 'true');
    h.documentEvents.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(h.nav.inert, true);
    assert.equal(h.button.attrs['aria-expanded'], 'false');
    assert.equal(h.button.focusOptions?.preventScroll, true);
    assert.equal(h.css['--sticky-nav-height'], '72px');
});

test('same-page scrolling closes mobile navigation and honors reduced motion', () => {
    const h = navigationHarness({ reducedMotion: true });
    h.button.click();
    h.documentEvents.click({ target: h.account, button: 0, preventDefault() {} });
    assert.equal(h.nav.inert, true);
    assert.equal(h.scrolls.at(-1)?.behavior, 'auto');
});

test('reload and browser history restoration do not forcibly reset the scroll position', () => {
    for (const navigationType of ['reload', 'back_forward']) {
        const h = navigationHarness({ navigationType });
        assert.equal(h.scrolls.length, 0, navigationType);
    }
});
