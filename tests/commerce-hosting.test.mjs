import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url)));
for (const source of ['/receipt.html', '/thank-you.html', '/admin.html']) {
  test(`${source} does not leak links through referrers or cache private screens`, () => {
    const headers = config.hosting.headers?.find(rule => rule.source === source)?.headers || [];
    assert.equal(headers.find(header => header.key.toLowerCase() === 'referrer-policy')?.value, 'no-referrer');
    assert.equal(headers.find(header => header.key.toLowerCase() === 'cache-control')?.value, 'no-store');
    assert.equal(headers.find(header => header.key.toLowerCase() === 'x-content-type-options')?.value, 'nosniff');
  });
}
