import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

async function loadFloating({ hasModal = false, scrollY = 500, reducedMotion = true, promotion = { brothBundleEnabled: false }, products = [], cart = {} } = {}) {
    const elements = new Map();
    const created = [];
    const events = {};
    const scrolls = [];
    let initialize;
    function node() {
        const classes = new Set();
        const element = { style: {}, listeners: {}, attrs: {}, hidden: false, innerHTML: '',
            setAttribute(key, value) { this.attrs[key] = value; },
            addEventListener(type, callback) { this.listeners[type] = callback; },
            appendChild(child) { return child; },
            querySelector: () => null,
            classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key), toggle(key, force) { const on = force ?? !classes.has(key); if (on) classes.add(key); else classes.delete(key); } },
        };
        created.push(element);
        return element;
    }
    for (const id of ['floating-cart-count', ...(hasModal ? ['cart-modal', 'cart-modal-close', 'cart-modal-items', 'cart-modal-footer', 'cart-modal-total'] : [])]) elements.set(id, node());
    const window = { scrollY, matchMedia: () => ({ matches: reducedMotion }), addEventListener: (type, callback) => { events[type] = callback; }, scrollTo: options => scrolls.push(options) };
    const document = { createElement: node, body: node(), getElementById: id => elements.get(id) || null, querySelector: () => null, addEventListener: (_type, callback) => { initialize = callback; } };
    const context = vm.createContext({ document, window, console, localStorage: { getItem: () => JSON.stringify(cart) }, getProducts: async () => products, getPromotionConfig: async () => promotion, DEFAULT_PROMOTION: { brothBundleEnabled: true, bundleMinimum: 6, bundlePriceCents: 2000 }, openDialog: modal => { modal.style.display = 'block'; }, closeDialog: modal => { modal.style.display = 'none'; }, setTimeout });
    vm.runInContext(readFileSync('store.js', 'utf8').slice(readFileSync('store.js', 'utf8').indexOf('export function calculateCartTotal')).replace('export function', 'function'), context);
    vm.runInContext(readFileSync('floating-buttons.js', 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
    await initialize();
    return { created, events, scrolls, elements, cart: created.find(element => element.className === 'float-btn floating-cart'), back: created.find(element => element.className === 'float-btn back-to-top') };
}

test('cart links on pages without a modal still navigate to the shop checkout', async () => {
    const h = await loadFloating();
    let prevented = false;
    h.cart.listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, false, 'Story/account links must not become dead buttons');
    assert.equal(h.cart.href, './shop.html#order-section');
});

test('back-to-top initializes from restored scroll and honors reduced motion', async () => {
    const h = await loadFloating();
    assert.equal(h.created.find(element => element.className === 'floating-buttons-container').classList.contains('scrolled'), true);
    h.back.listeners.click();
    assert.equal(h.scrolls.at(-1)?.behavior, 'auto');
    assert.equal(h.back.type, 'button');
    const top = await loadFloating({ scrollY: 0 });
    assert.equal(top.back.hidden, true, 'Invisible back-to-top must not be keyboard focusable');
});

test('modal uses fixed six-jar mixed pickup pricing despite legacy promotion metadata', async () => {
    const products = [{ id: 'prod_beef', name: 'Beef Broth', price: 2500 }, { id: 'prod_chicken', name: 'Chicken Broth', price: 2500 }, { id: 'mushroom', name: 'Mushroom Broth', price: 1800 }];
    const h = await loadFloating({ hasModal: true, products, cart: { prod_beef: 2, prod_chicken: 2, mushroom: 2 } });
    h.cart.listeners.click({ preventDefault() {} });
    assert.match(h.elements.get('cart-modal-total').innerHTML, /\$116\.00/, 'Legacy disabled promotions cannot override the fixed pickup offer');
    assert.match(h.elements.get('cart-modal-total').innerHTML, /Savings: -\$20\.00/);
    h.events.cartUpdated({ detail: { count: 6, cart: { prod_beef: 2, prod_chicken: 2, mushroom: 2 }, products, promotion: { brothBundleEnabled: true, bundleMinimum: 4, bundlePriceCents: 100 } } });
    assert.match(h.elements.get('cart-modal-total').innerHTML, /\$116\.00/);
    assert.match(h.elements.get('cart-modal-total').innerHTML, /Savings: -\$20\.00/);
    h.events.cartUpdated({ detail: { count: 5, cart: { prod_beef: 2, prod_chicken: 2, mushroom: 1 }, products, promotion: { bundleMinimum: 4, bundlePriceCents: 100 } } });
    assert.equal(h.elements.get('cart-modal-total').innerHTML, '$118.00', 'Five mixed jars stay at catalog price even when stale metadata advertises four');
});
