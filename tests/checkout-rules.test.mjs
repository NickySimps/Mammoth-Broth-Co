import assert from 'node:assert/strict';
import { FULFILLMENT_METHODS, validateFulfillment } from '../checkout-rules.mjs';

const validBase = { customerName: 'Alex', customerEmail: 'alex@example.com', totalJars: 5 };

assert.deepEqual(validateFulfillment({
  ...validBase,
  method: FULFILLMENT_METHODS.MARKET_PICKUP,
  marketId: 'market_atlantic',
  pickupDate: '2026-09-06'
}), []);

assert.match(validateFulfillment({
  ...validBase,
  method: FULFILLMENT_METHODS.LOCAL_DELIVERY,
  totalJars: 4,
  deliveryAddress: { street: '1 Main St', city: 'Jacksonville', state: 'FL', zip: '32202' }
})[0], /Monday local delivery/i);

assert.deepEqual(validateFulfillment({
  ...validBase,
  method: FULFILLMENT_METHODS.LOCAL_DELIVERY,
  totalJars: 5,
  deliveryAddress: { street: '1 Main St', city: 'Jacksonville', state: 'FL', zip: '32202' }
}), []);

assert.match(validateFulfillment({
  ...validBase,
  method: FULFILLMENT_METHODS.SPECIAL_ORDER,
  notes: ''
})[0], /notes/i);
assert.deepEqual(validateFulfillment({
  ...validBase,
  method: FULFILLMENT_METHODS.SPECIAL_ORDER,
  notes: 'Please make this extra spicy.'
}), []);

console.log('checkout rules tests passed');
