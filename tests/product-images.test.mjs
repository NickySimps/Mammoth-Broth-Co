import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveProductImage } from '../product-images.mjs';

const project = new URL('../', import.meta.url);
const photos = {
  prod_beef: 'assets/mammoth-products/beef-bone-broth.webp',
  prod_chicken: 'assets/mammoth-products/chicken-bone-broth.webp',
  mushroom: 'assets/mammoth-products/mushroom-broth.webp',
};

test('canonical broth IDs use the new photos even when Firestore has stale image URLs', () => {
  for (const [id, expected] of Object.entries(photos)) {
    assert.equal(resolveProductImage({ id, imageUrl: 'assets/old-photo.jpg' }), expected);
  }
});

test('unknown products preserve their configured image and use the brand fallback only if absent', () => {
  assert.equal(resolveProductImage({ id: 'limited-batch', imageUrl: 'assets/limited.jpg' }), 'assets/limited.jpg');
  assert.equal(resolveProductImage({ id: 'limited-batch' }), 'assets/mammothbrothlogo.jpg');
  assert.equal(resolveProductImage(null), 'assets/mammothbrothlogo.jpg');
});

test('optimized assortment photo is used as the visible shop hero', () => {
  const html = readFileSync(fileURLToPath(new URL('../shop.html', import.meta.url)), 'utf8');
  assert.match(html, /src="\.\/assets\/mammoth-products\/mammoth-products-hero\.webp"/);
  assert.match(html, /Three jars of Mammoth Broth products displayed together/);
});

test('selected source photos are optimized, valid WebP assets', () => {
  for (const path of [...Object.values(photos), 'assets/mammoth-products/mammoth-products-hero.webp']) {
    const file = fileURLToPath(new URL(path, project));
    const bytes = readFileSync(file);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', `${path} must be RIFF`);
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', `${path} must be WebP`);
    assert.ok(statSync(file).size < 300_000, `${path} should be web-optimized`);
  }
});
