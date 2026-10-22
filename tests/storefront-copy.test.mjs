import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = page => readFile(new URL(`../${page}.html`, import.meta.url), 'utf8');

test('home and market pages qualify ordering availability instead of promising an online reservation', async () => {
  for (const page of ['index', 'markets']) {
    const source = await html(page);
    assert.match(source, /current ordering availability/i, page);
    assert.doesNotMatch(source, />Reserve the next batch<|>Pre-Order Now<|Reserve online, then|This ensures you secure/i, page);
  }
});

test('visible contact email addresses match their existing mailto destinations', async () => {
  const source = await html('contact');
  const addresses = [...source.matchAll(/<a href="mailto:([^"]+)">([^<]+)<\/a>/g)];
  assert.ok(addresses.length > 0);
  for (const [, destination, label] of addresses) assert.equal(label.trim(), destination);
});

test('public copy does not choose between the conflicting unconfirmed simmer durations', async () => {
  for (const page of ['index', 'about']) {
    const text = (await html(page)).replace(/<[^>]+>/g, ' ');
    assert.equal(/\b(?:24|48)[\s-]+hours?\b/i.test(text), false, `${page}: confirm the duration with the owner before advertising it`);
  }
});

test('contact page refers to the market schedule without a stale weekend-only location count', async () => {
  const source = await html('contact');
  const text = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.equal(/\bthree\b.{0,120}\bweekend\b/i.test(text), false);
  assert.match(source, /href="\.\/markets\.html#main-content"/);
});
