import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pricingCopy = 'Any mix of 6 or more jars qualifies for the beef and chicken bulk price when the offer is active. Mushroom jars count toward the 6-jar minimum but stay at their regular price. Prices and savings depend on current catalog and promotion settings; final pricing is confirmed at checkout.';

function renderCart(cart) {
  const summary = { innerHTML: '', querySelectorAll: () => [] };
  const context = vm.createContext({
    document: { activeElement: null, getElementById: () => summary, querySelectorAll: () => [] },
    window: { dispatchEvent() {} },
    CustomEvent: class { constructor(type, init) { Object.assign(this, init); } },
    calculateCartTotal: () => ({ items: [], total: 18000, discount: 1500 })
  });
  vm.runInContext(read('ui.js').replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function'), context);
  context.updateCartSummary(cart, [], () => {}, {});
  return summary.innerHTML;
}

test('initial, empty and mixed cart explain the exact conditional mixed-jar offer without fixed prices or tax promises', () => {
  const html = read('shop.html');
  const initial = html.match(/<div id="cart-summary">([\s\S]*?)<\/div>/)?.[1];
  for (const copy of [initial, renderCart({}), renderCart({ beef: 2, chicken: 1, mushroom: 3 })]) {
    assert.ok(copy?.includes(pricingCopy), 'Cart must state the exact mixed-jar pricing explanation');
    assert.doesNotMatch(copy, /\$(?:20|25|40)(?:\.00)?\b|tax (?:included|free)|all jars.*bulk price/i);
  }
  assert.ok(html.includes('Delivery subscriptions are not active online.'));
  assert.ok(html.includes('Planning your selection does not create a subscription or authorize payment.'));
});

test('unavailable Stripe error requires prepayment and contact help, not a nonexistent pickup-payment route', () => {
  const source = read('firebase/functions/index.js');
  const getStripe = source.slice(source.indexOf('function getStripe()'), source.indexOf('const commerce ='));
  for (const [paymentsEnabled, env] of [[false, {}], [true, {}]]) {
    const context = vm.createContext({
      paymentsEnabled, process: { env },
      functions: { https: { HttpsError: class extends Error {
        constructor(code, message) { super(message); this.code = code; }
      } } }
    });
    vm.runInContext(getStripe, context);
    assert.throws(() => context.getStripe(), error => {
      assert.equal(error.code, 'failed-precondition');
      assert.equal(error.message, 'Online payment is unavailable. Full payment is required before pickup or delivery. Please contact us for help.');
      assert.doesNotMatch(error.message, /choose pickup payment|pay.at.pickup/i);
      return true;
    });
  }
});
