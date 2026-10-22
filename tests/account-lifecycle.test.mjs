import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const elements = new Map();
const node = id => {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', hidden: false, addEventListener() {} });
  return elements.get(id);
};
let finish;
const context = vm.createContext({
  document: { getElementById: node, querySelectorAll: () => [] }, window: {},
  watchUser() {}, getUserOrders: () => new Promise(resolve => { finish = resolve; })
});
const source = (await readFile(new URL('../account.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
vm.runInContext(source, context);
const pending = context.renderOrders({ uid: 'previous-account' });
await context.renderOrders(null);
finish([{ id: 'previous-order', customerName: 'Previous customer', productSummary: 'Private previous order', items: [] }]);
await pending;
assert.equal(node('orders-list').innerHTML, '', 'A signed-out user must not retain a previous account order response');
assert.equal(context.window.__mammothOrders.size, 0);
assert.equal(node('orders-card').hidden, true);
console.log('account session lifecycle regression tests passed');
