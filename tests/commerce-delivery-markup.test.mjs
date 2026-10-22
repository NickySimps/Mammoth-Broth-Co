import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('delivery quote is an explicit non-submit action with an accessible live result before payment', () => {
  const html = readFileSync(new URL('../shop.html', import.meta.url), 'utf8');
  assert.match(html, /<button\b[^>]*id="delivery-quote-button"[^>]*type="button"/);
  assert.match(html, /id="delivery-quote-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(html.indexOf('id="delivery-quote-status"') < html.indexOf('id="payment-heading"'));
});
