import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveProductImages } from '../product-images.mjs';

test('each broth resolves a curated, labeled gallery with the lead photo first', () => {
  for (const [id, title] of [['prod_beef','Beef bone broth'],['prod_chicken','Chicken bone broth'],['mushroom','Mushroom broth']]) {
    const images = resolveProductImages({ id, name: title });
    assert.ok(images.length >= 2);
    assert.ok(images.every(image => image.src && image.alt.includes(title)));
    assert.equal(images[0].src, resolveProductImageCompat(id));
  }
});

function resolveProductImageCompat(id) {
  return ({prod_beef:'assets/mammoth-products/beef-bone-broth.webp',prod_chicken:'assets/mammoth-products/chicken-bone-broth.webp',mushroom:'assets/mammoth-products/mushroom-broth.webp'})[id];
}

test('gallery renderer uses native horizontal scrolling, focusable controls and no autoplay', () => {
  const css = readFileSync(new URL('../product-gallery.css', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  assert.match(css, /overflow-x:\s*auto/);
  assert.match(ui, /product-gallery/);
  assert.match(ui, /aria-label/);
  assert.doesNotMatch(ui, /setInterval|autoplay/);
});