import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { innerHTML: '' });
  return nodes.get(id);
};
const context = vm.createContext({
  document: { getElementById: node, querySelectorAll: () => [] },
  window: { dispatchEvent() {} },
  CustomEvent: class {},
  calculateCartTotal: () => ({ items: [{ name: 'Broth', quantity: 1, productId: 'beef' }], total: 2000, discount: 0 })
});
const source = (await readFile(new URL('../ui.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function');
vm.runInContext(source, context);
context.updateCartSummary({ beef: 1 }, [], () => {}, {});
const buttons = node('cart-summary').innerHTML.match(/<button\b[^>]*>/g);
assert.equal(buttons.length, 2);
for (const button of buttons) {
  assert.match(button, /type="button"/, 'Cart quantity buttons must never submit the checkout form');
  assert.match(button, /aria-label="[^"]+"/, 'Quantity controls need descriptive accessible names');
}
console.log('cart control regression tests passed');
