import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('checkout offers only market pickup and keeps accessible availability and payment feedback', () => {
  const html = readFileSync(new URL('../shop.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="(?:delivery-quote-button|delivery-quote-status|delivery-fulfillment-fields|special-order-fields)"/);
  assert.doesNotMatch(html, /value="(?:local_delivery|special_order)"/);
  assert.match(html, /<input\b[^>]*type="hidden"[^>]*name="fulfillment-method"[^>]*value="market_pickup"/);
  assert.match(html, /id="ordering-availability"[^>]*role="status"/);
  assert.match(html, /id="pickup-date"[^>]*required[^>]*aria-describedby="pickup-date-help"/);
  assert.match(html, /id="payment-message"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(html.indexOf('id="market-fulfillment-fields"') < html.indexOf('id="payment-heading"'));
});
