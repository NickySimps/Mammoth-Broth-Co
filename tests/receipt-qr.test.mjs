import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as ui from '../commerce-ui.mjs';

test('receipt and return pages offer public-only reorder, market and jar QR links', () => {
  const targets = JSON.parse(readFileSync('assets/qr/destinations.json', 'utf8'));
  for (const name of ['receipt.html', 'thank-you.html']) {
    const html = readFileSync(name, 'utf8');
    assert.ok(html.includes('receipt-qr.css'), `${name} needs receipt print styles`);
    const section = html.match(/<section class="receipt-qr"[\s\S]*?<\/section>/)?.[0];
    assert.ok(section, `${name} needs useful receipt QR codes`);
    for (const id of ['shop', 'markets', 'jar']) {
      assert.ok(section.includes(`href="${targets[id].replace('https://mammothbroth.com/', './')}"`));
      assert.ok(section.includes(`src="./assets/qr/${id}.png"`));
    }
    assert.doesNotMatch(section, /token=|order=|api\.qrserver|checkout\.stripe/);
    assert.match(html, /id="receipt-print"[^>]*disabled/);
  }
  const css = readFileSync('receipt-qr.css', 'utf8');
  assert.match(css, /@media print/);
  assert.match(css, /#receipt-link/);
  assert.match(css, /break-inside:\s*avoid/);
});

test('print action enables only after a verified receipt and disables again on a failed refresh', async () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { disabled: true, hidden: false, append() {}, replaceChildren() {}, addEventListener(type, fn) { this[type] = fn; } });
    return nodes.get(id);
  };
  let ok = true, prints = 0;
  const context = vm.createContext({ ...ui, URL, URLSearchParams,
    location: { hash: '#order=fixture&token=fixture-proof', pathname: '/receipt.html' },
    history: { replaceState() {} }, sessionStorage: { getItem() {}, setItem() {} },
    window: { print() { prints++; } },
    document: { getElementById: node, createElement: () => ({}) },
    fetch: async () => ({ ok, json: async () => ({ result: { orderId: 'fixture', orderName: 'Fixture', items: [], status: 'pending', paymentMethod: 'pickup' } }) })
  });
  vm.runInContext(readFileSync('receipt.mjs', 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
  await new Promise(setImmediate);
  assert.equal(node('receipt-print').disabled, false, 'verified receipt should be printable');
  node('receipt-print').click();
  assert.equal(prints, 1);
  ok = false;
  await node('receipt-refresh').click();
  assert.equal(node('receipt-print').disabled, true, 'failed refresh must not print stale verified details');
});
