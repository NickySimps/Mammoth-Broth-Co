import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const mod = await import('../order-lookup.mjs').catch(() => ({}));
test('staff QR lookup identifies exactly one order without receipt authorization', () => {
  assert.equal(typeof mod.staffOrderHref, 'function');
  const id = 'a'.repeat(64);
  assert.equal(mod.staffOrderHref(id), `https://mammothbroth.com/staff.html#order=${id}`);
  assert.equal(mod.readStaffOrder(`#order=${id}`), id);
  for (const bad of ['', '#order=', '#order=a&order=b', '#order=a&token=secret', '#order=../orders', '#order=https://evil.test', '#order=%ZZ', '#order=a&x=b', '#token=x', '#order='+ 'a'.repeat(129)]) assert.equal(mod.readStaffOrder(bad), null, bad);
  for (const bad of ['', '../order', 'https://evil.test', '<svg>', 'a&token=b', 'a'.repeat(129), null, 2]) assert.throws(() => mod.staffOrderHref(bad));
});
test('both deployment surfaces protect clean and html staff lookup pages', () => {
  const firebase = JSON.parse(readFileSync('firebase.json', 'utf8'));
  const cloudflare = readFileSync('_headers', 'utf8');
  for (const path of ['/staff', '/staff.html']) {
    const values = Object.fromEntries((firebase.hosting.headers.find(h => h.source === path)?.headers || []).map(h => [h.key, h.value]));
    assert.equal(values['Referrer-Policy'], 'no-referrer');
    assert.match(values['Cache-Control'] || '', /no-store/);
    assert.match(values['Cache-Control'] || '', /no-transform/);
    assert.ok(cloudflare.includes(`${path}\n  Cache-Control: no-store, no-transform`));
  }
});
