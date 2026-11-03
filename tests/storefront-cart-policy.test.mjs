import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateFulfillment } from '../checkout-rules.mjs';
import { deliveryEligibility } from '../commerce-ui.mjs';

const address = { street: '1 Main', city: 'Town', state: 'FL', zip: '32204' };
const policy = { enabled: true, zones: [
  { id: 'jacksonville', feeCents: 1000, allowedZips: ['32204', '32205'] },
  { id: 'surrounding', feeCents: 1500, allowedZips: ['32233', '32082'] }
], state: 'FL', minimumJars: 6, cutoffHours: 48 };

test('subscription planning accepts six jars and refuses five across both storefront gates', () => {
  assert.match(validateFulfillment({ method: 'local_delivery', totalJars: 5, subscriptionInterval: 'weekly', deliveryAddress: address }).join(' '), /6–12 jars/);
  assert.deepEqual(validateFulfillment({ method: 'local_delivery', totalJars: 6, subscriptionInterval: 'weekly', deliveryAddress: address }), []);
  assert.match(deliveryEligibility(policy, 5, address), /6 jars/);
  assert.equal(deliveryEligibility(policy, 6, address), '');
  assert.match(deliveryEligibility({ ...policy, minimumJars: 5 }, 6, address), /not configured/i, 'Stale five-jar policy cannot enable delivery');
  assert.match(deliveryEligibility(null, 6, address), /not configured/i);
});

test('shop presents prepaid pickup, unavailable subscription delivery and approval then full special-order payment', async () => {
  const html = await readFile(new URL('../shop.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /pay-at-pickup|Pay at Pickup/i);
  assert.match(html, /6–12 jars/);
  assert.match(html, /id="subscription-availability"[^>]*role="status"[^>]*>Subscription checkout unavailable/);
  assert.match(html, /id="delivery-quote-button"[^>]*disabled/);
  assert.doesNotMatch(html, /one.time delivery|6 jars or more/i);
  assert.match(html, /full payment is required before pickup/i);
  assert.match(html, /after approval, full payment is required before fulfillment/i);
  assert.match(html, /id="payment-availability"/);
  assert.doesNotMatch(html, /id="delivery-state"[^>]*value="FL"/);
});
