import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const elements = new Map();
const node = id => {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', addEventListener(type, callback) { this[type] = callback; } });
  return elements.get(id);
};
const shell = { innerHTML: '<section>Original dashboard</section>' };
let observe;
let finish;
const context = vm.createContext({
  console, document: { querySelector: () => shell, getElementById: node },
  getCurrentUser: () => ({ uid: 'cached' }),
  watchUser: callback => { observe = callback; },
  isAdmin: async user => !!user?.admin,
  getAllOrders: () => new Promise(resolve => { finish = resolve; })
});
const source = (await readFile(new URL('../admin.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
vm.runInContext(source, context);
assert.equal(typeof observe, 'function', 'Dashboard must observe authoritative auth changes');
const pending = observe({ uid: 'operator', admin: true });
await new Promise(setImmediate);
await observe(null);
assert.match(shell.innerHTML, /Admin access required/);
finish([{ customerName: 'Previous account customer', totalAmount: 2500 }]);
await pending;
assert.match(shell.innerHTML, /Admin access required/, 'Old account queries must not restore dashboard after sign-out');
assert.doesNotMatch(node('orders-table').innerHTML, /Previous account customer/);
context.renderDashboard([{ fulfillmentMethod: 'special_order', specialNotes: 'Review this request', totalAmount: 2500 }]);
assert.match(node('market-breakdown').innerHTML, /Special requests/);
assert.doesNotMatch(node('market-breakdown').innerHTML, /Next market/);
console.log('admin auth lifecycle regression tests passed');
