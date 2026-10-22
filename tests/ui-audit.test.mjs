import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { nextPickupDate } from '../schedule-helper.mjs';

function harness() {
  const document = { activeElement: null };
  function element() {
    return { dataset: {}, children: [], style: {}, listeners: {},
      appendChild(child) { this.children.push(child); },
      setAttribute(name, value) { this[name] = value; },
      focus() { document.activeElement = this; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      contains(node) { return this.children.includes(node); },
      querySelectorAll() { return this.children; },
      querySelector(selector) { return this.children.find(c => selector.includes(`data-id="${c.dataset.id}"`) && selector.includes(`data-change="${c.dataset.change}"`)); },
      set innerHTML(html) { this.html = html; this.children = [...html.matchAll(/<button[^>]*data-id="([^"]+)"[^>]*data-change="([^"]+)"[^>]*>/g)].map(m => ({ ...element(), dataset: { id: m[1], change: m[2] } })); },
      get innerHTML() { return this.html || ''; }
    };
  }
  const nodes = new Map(['product-list', 'market-select', 'cart-summary'].map(id => [id, element()]));
  document.getElementById = id => nodes.get(id);
  document.createElement = element;
  document.querySelectorAll = () => nodes.get('cart-summary').children;
  let event;
  const context = vm.createContext({ document, window: { dispatchEvent(e) { event = e; } }, CustomEvent: class { constructor(type, init) { Object.assign(this, init); } }, nextPickupDate,
    calculateCartTotal: cart => ({ items: Object.entries(cart).map(([productId, quantity]) => ({ productId, quantity, name: productId })), total: 100, discount: 0 }) });
  vm.runInContext(readFileSync('ui.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function'), context);
  return { context, nodes, document, get event() { return event; } };
}

test('unconfigured market IDs do not manufacture available pickup schedules', () => {
  const h = harness();
  h.context.renderMarkets([{ id: 'market_atlantic', name: 'Atlantic' }]);
  assert.equal(h.nodes.get('market-select').children[0].disabled, true);
});

test('cart rerender preserves the same keyboard quantity control', () => {
  const h = harness();
  const render = cart => h.context.updateCartSummary(cart, [], () => {}, {});
  render({ beef: 1, chicken: 1 });
  h.nodes.get('cart-summary').children[1].focus();
  render({ beef: 2, chicken: 1 });
  assert.equal(h.document.activeElement, h.nodes.get('cart-summary').children[1]);
});

test('removing a focused item selects the next surviving control then the summary', () => {
  const h = harness();
  const render = cart => h.context.updateCartSummary(cart, [], () => {}, {});
  render({ beef: 1, chicken: 1 });
  h.nodes.get('cart-summary').children[0].focus();
  render({ chicken: 1 });
  assert.equal(h.document.activeElement, h.nodes.get('cart-summary').children[0]);
  render({});
  assert.equal(h.document.activeElement, h.nodes.get('cart-summary'));
});

test('product story avoids unverified simmer duration and cart event carries promotion', () => {
  const h = harness();
  h.context.renderProducts([{ id: 'beef', name: 'Beef Broth', price: 2000 }], () => {});
  assert.match(h.nodes.get('product-list').children[0].innerHTML, /Small-batch broth/);
  assert.doesNotMatch(h.nodes.get('product-list').children[0].innerHTML, /24-hour/);
  const promotion = { brothBundleEnabled: false };
  h.context.updateCartSummary({ beef: 1 }, [], () => {}, promotion);
  assert.equal(h.event.detail.promotion, promotion);
});
