import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

async function loadFloating({ hasModal = false, scrollY = 500, reducedMotion = true } = {}) {
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
    const context = vm.createContext({ document, window, console, localStorage: { getItem: () => null }, getProducts: async () => [], calculateCartTotal: () => ({ items: [], total: 0, discount: 0 }), openDialog: modal => { modal.style.display = 'block'; }, closeDialog: modal => { modal.style.display = 'none'; }, setTimeout });
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
