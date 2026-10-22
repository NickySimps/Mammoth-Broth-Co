import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const targets = {
  shop: 'https://mammothbroth.com/shop.html#products-section',
  markets: 'https://mammothbroth.com/markets.html#market-calendar',
  contact: 'https://mammothbroth.com/contact.html#main-content',
  jar: 'https://mammothbroth.com/jar.html'
};
test('public QR assets have an exact safe destination manifest and downloadable print masters', () => {
  const manifestPath = 'assets/qr/destinations.json';
  assert.ok(existsSync(manifestPath), 'public QR destination manifest must exist');
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), targets);
  for (const name of Object.keys(targets)) {
    const png = readFileSync(`assets/qr/${name}.png`);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const svg = readFileSync(`assets/qr/${name}.svg`, 'utf8');
    assert.match(svg, /<svg/);
    assert.match(svg, /<path/);
    assert.doesNotMatch(svg, /<script|https?:\/\/(?!www\.w3\.org)/);
  }
});
