import assert from 'node:assert/strict';
import { FULFILLMENT_METHODS, validateFulfillment } from '../checkout-rules.mjs';

const pickup = { method: FULFILLMENT_METHODS.MARKET_PICKUP, marketId: 'market_atlantic', pickupDate: '2026-11-08', allowedPickupDates: ['2026-11-08'] };
assert.deepEqual(Object.values(FULFILLMENT_METHODS), ['market_pickup']);
assert.deepEqual(validateFulfillment(pickup), []);
for (const method of ['local_delivery', 'special_order', '', undefined]) {
  assert.deepEqual(validateFulfillment({ ...pickup, method, totalJars: 6, notes: 'Legacy request', deliveryAddress: { street: '1 Main St', city: 'Jacksonville', state: 'FL', zip: '32202' } }), ['Only market pickup is available.']);
}
assert.match(validateFulfillment({ ...pickup, marketId: '' })[0], /market pickup location/i);
assert.match(validateFulfillment({ ...pickup, pickupDate: '' })[0], /pickup date/i);
for (const pickupDate of ['11/08/2026', '2026-11-09']) {
  assert.match(validateFulfillment({ ...pickup, pickupDate })[0], /available listed pickup date/i);
}
assert.match(validateFulfillment({ ...pickup, allowedPickupDates: [] })[0], /available listed pickup date/i);
console.log('checkout rules tests passed');
