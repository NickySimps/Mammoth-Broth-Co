import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('functions deploy on the supported Node.js 22 runtime', () => {
  const pkg = JSON.parse(readFileSync(new URL('../firebase/functions/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '22');
});

test('non-payment release clearly tells shoppers ordering is unavailable and offers contact', () => {
  const html = readFileSync(new URL('../shop.html', import.meta.url), 'utf8');
  assert.match(html, /id="ordering-availability"[^>]*role="status"/);
  assert.match(html, /Online ordering is temporarily unavailable/);
  assert.match(html, /No online payments are being accepted/);
  assert.match(html, /href="\.\/contact\.html#main-content"/);
});
