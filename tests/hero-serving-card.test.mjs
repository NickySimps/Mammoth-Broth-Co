import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('homepage keeps its hero card but replaces the MB/simmer graphic with accessible serving ideas', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /class="home-hero[^\"]*"/);
  assert.doesNotMatch(html, /class="hero-mark"|<span>MB<\/span>/);
  assert.match(html, /<aside class="hero-serving-card" aria-labelledby="serving-ideas-heading">/);
  assert.match(html, /id="serving-ideas-heading"[^>]*>Make it a meal\./);
  for (const idea of ['Sip it warm', 'Start a soup', 'Upgrade your grains']) assert.ok(html.includes(idea));
  const css = readFileSync('style.css', 'utf8');
  assert.doesNotMatch(css, /\.hero-mark\b/);
  assert.match(css, /\.hero-serving-card\b/);
});
