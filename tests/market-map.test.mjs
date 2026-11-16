import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');
const markets = read('markets.html');

test('each market has an accessible clickable map link with exact-address directions', () => {
  const venues = [
    ['Atlantic Beach', '800 Seminole Road, Atlantic Beach, FL 32233'],
    ['Palm Valley', '148 Canal Blvd, Palm Valley, FL 32082'],
    ['Murray Hill', '3438 Mayflower St, Jacksonville, FL 32205'],
    ['Ponte Vedra', '377 S Roscoe Blvd, Ponte Vedra Beach, FL 32082'],
  ];
  for (const [name, address] of venues) {
    const escaped = address.replaceAll('&', '&amp;');
    assert.ok(markets.includes(escaped), `${name} must show ${address}`);
    const directions = [...markets.matchAll(/href="(https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=[^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
    assert.ok(directions.some(url => decodeURIComponent(url.split('query=')[1].replaceAll('+', ' ')) === address), `${name} directions must use its exact street address`);
    assert.match(markets, /aria-label="Open interactive map and directions/);
  }
  assert.equal((markets.match(/class="market-map-link"/g) || []).length, 4);
  assert.equal((markets.match(/rel="noopener noreferrer"/g) || []).length, 4);
});

test('Ponte Vedra schedule reflects the requested Friday 10 AM–1 PM time', () => {
  const ponte = markets.match(/<article class="market-card"[^>]*data-market="ponte"[\s\S]*?<\/article>/)?.[0];
  assert.ok(ponte);
  assert.match(ponte, /10 AM–1 PM/);
});

test('home and markets pages visibly use local optimized broth photography', () => {
  for (const page of ['index.html', 'markets.html']) {
    const html = read(page);
    assert.match(html, /assets\/mammoth-products\/mammoth-products-hero\.webp/);
    assert.match(html, /alt="Three jars of Mammoth Broth products displayed together"/);
    assert.match(html, /<img[^>]+(?:loading="lazy"|fetchpriority="high")/s);
    if (page === 'markets.html') assert.match(html, /class="market-photo-strip[\s\S]*?<img[^>]+loading="lazy"/);
  }
});

test('supplemental page styles are linked without modifying the shared stylesheet contract', () => {
  for (const page of ['index.html', 'markets.html']) assert.match(read(page), /href="supplemental-pages\.css"/);
  const css = read('supplemental-pages.css');
  assert.match(css, /\.market-map-link/);
  assert.match(css, /@media/);
});
