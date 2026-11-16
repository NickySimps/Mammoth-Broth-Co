import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('market banner compacts after scroll while staying readable and respecting reduced motion', () => {
  const nav = readFileSync('nav.js', 'utf8');
  const css = readFileSync('style.css', 'utf8');
  assert.match(nav, /addEventListener\('scroll'/);
  assert.match(nav, /classList\.toggle\('is-scrolled'/);
  assert.match(css, /\.is-scrolled\s+\.market-banner\s*\{/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
