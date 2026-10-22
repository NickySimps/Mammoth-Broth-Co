import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { qrcode } from '../vendor/qrcode-generator.mjs';

function element(tagName = 'div') {
  return { tagName, attributes: {}, children: [], hidden: false, textContent: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; if (name === 'href') delete this.href; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, fn) { this[type] = fn; }
  };
}

function receiptDocument() {
  const nodes = new Map();
  return { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element,
    createElementNS(namespace, tagName) { assert.equal(namespace, 'http://www.w3.org/2000/svg'); return element(tagName); }
  };
}

test('locally rendered staff QR encodes only the exact order lookup URL with a four-module quiet zone', async () => {
  assert.ok(existsSync('receipt-order-qr.mjs'), 'dedicated local order QR renderer must exist');
  const { showOrderQr, clearOrderQr } = await import('../receipt-order-qr.mjs');
  const document = receiptDocument();
  const receipt = { orderId: 'Abc_123-XYZ', orderName: '<img src=x onerror=bad()>', receiptToken: 'SECRET', email: 'private@example.com' };
  const href = 'https://mammothbroth.com/staff.html#order=Abc_123-XYZ';
  showOrderQr(document, receipt);
  assert.equal(document.getElementById('receipt-order-qr').hidden, false);
  assert.equal(document.getElementById('receipt-order-link').href, href);
  assert.equal(document.getElementById('receipt-order-reference').textContent, `Reference: ${receipt.orderName}`);
  const svg = document.getElementById('receipt-order-code').children[0];
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.attributes.role, 'img');
  assert.ok(svg.attributes['aria-label']);
  const expected = qrcode(0, 'M'); expected.addData(href, 'Byte'); expected.make();
  const size = expected.getModuleCount();
  assert.equal(svg.attributes.viewBox, `0 0 ${size + 8} ${size + 8}`);
  const [background, ...modules] = svg.children;
  assert.equal(background.attributes.fill, '#fff');
  assert.equal(background.attributes.width, String(size + 8));
  const coordinates = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (expected.isDark(row, col)) coordinates.push(`${col + 4},${row + 4}`);
  assert.deepEqual(modules.map(rect => `${rect.attributes.x},${rect.attributes.y}`), coordinates, 'matrix must match only the public staff URL');
  for (const rect of modules) {
    assert.equal(rect.tagName, 'rect'); assert.equal(rect.attributes.fill, '#000');
    assert.equal(rect.attributes.width, '1'); assert.equal(rect.attributes.height, '1');
  }
  assert.doesNotMatch(JSON.stringify(svg), /SECRET|private@example|onerror|receiptToken|token=/);
  clearOrderQr(document);
  assert.equal(document.getElementById('receipt-order-qr').hidden, true);
  assert.equal(document.getElementById('receipt-order-code').children.length, 0);
  assert.equal(document.getElementById('receipt-order-reference').textContent, '');
  assert.equal(document.getElementById('receipt-order-link').href, undefined);
});
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
      assert.ok(section.includes(`src="./assets/qr/${id}.png" width="110" height="110"`));
    }
    assert.doesNotMatch(section, /token=|order=|api\.qrserver|checkout\.stripe/);
    assert.match(html, /id="receipt-print"[^>]*disabled/);
  }
  const css = readFileSync('receipt-qr.css', 'utf8');
  assert.match(css, /@media print/);
  assert.match(css, /#receipt-link/);
  assert.match(css, /break-inside:\s*avoid/);
});

test('staff lookup is the primary hidden QR beside the verified receipt details on both pages', () => {
  for (const name of ['receipt.html', 'thank-you.html']) {
    const html = readFileSync(name, 'utf8');
    assert.match(html, /id="receipt-order-qr"[^>]*hidden/);
    assert.ok(html.indexOf('id="receipt-order-qr"') > html.indexOf('id="receipt-details"'));
    assert.ok(html.indexOf('id="receipt-order-qr"') < html.indexOf('id="receipt-payment"'));
    assert.match(html, /Show this code at pickup/);
    assert.match(html, /Staff sign-in required\. Scanning does not mark this order paid or collected\./);
    assert.match(html, /id="receipt-order-link"[^>]*rel="noreferrer/);
    assert.match(html, /id="receipt-order-reference"/);
  }
});

test('primary QR is larger than compact public codes on screen and print without tint or private-link printing', () => {
  const css = readFileSync('receipt-qr.css', 'utf8');
  assert.match(css, /\.receipt-order-code svg\s*\{[^}]*width:\s*280px;[^}]*max-width:\s*100%;[^}]*height:\s*auto;/);
  assert.match(css, /\.receipt-order-code svg\s*\{[^}]*background:\s*#fff;[^}]*filter:\s*none;/);
  assert.match(css, /\.receipt-qr-grid img\s*\{[^}]*width:\s*110px;[^}]*height:\s*110px;/);
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /\.receipt-order-code svg\s*\{[^}]*width:\s*55mm;/);
  assert.match(print, /\.receipt-qr-grid img\s*\{[^}]*width:\s*28mm;/);
  assert.match(css, /\.receipt-order-qr\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(print, /#receipt-link[^}]*display:\s*none\s*!important/);
});

test('printed receipt uses compact headings rather than oversized storefront typography', () => {
  const print = readFileSync('receipt-qr.css', 'utf8').split('@media print')[1];
  assert.match(print, /\.confirmation-panel h1\s*\{[^}]*font-size:\s*24pt/);
  assert.match(print, /\.confirmation-panel p\s*\{[^}]*margin:\s*4px 0/);
});

test('print and staff code enable only after verification, clear while loading and on failed refresh', async () => {
  const orderQr = await import('../receipt-order-qr.mjs');
  const document = receiptDocument();
  const node = id => document.getElementById(id);
  let ok = true, prints = 0, pending;
  let receipt = { orderId: 'fixture', orderName: 'Fixture', items: [], status: 'pending', paymentMethod: 'pickup' };
  const context = vm.createContext({ ...ui, ...orderQr, URL, URLSearchParams,
    location: { hash: '#order=fixture&token=fixture-proof', pathname: '/receipt.html' },
    history: { replaceState() {} }, sessionStorage: { getItem() {}, setItem() {} },
    window: { print() { prints++; } }, document,
    fetch: () => new Promise(resolve => { pending = () => resolve({ ok, json: async () => ({ result: receipt }) }); })
  });
  vm.runInContext(readFileSync('receipt.mjs', 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
  assert.equal(node('receipt-order-qr').hidden, true, 'loading must hide primary QR');
  assert.equal(node('receipt-order-code').children.length, 0);
  pending();
  await new Promise(setImmediate);
  assert.equal(node('receipt-print').disabled, false, 'verified receipt should be printable');
  assert.equal(node('receipt-order-qr').hidden, false);
  assert.equal(node('receipt-order-link').href, 'https://mammothbroth.com/staff.html#order=fixture');
  node('receipt-print').click();
  assert.equal(prints, 1);
  for (const status of ['cancelled', 'refunded', 'completed', 'paid_requires_review']) {
    receipt = { ...receipt, status };
    const loading = node('receipt-refresh').click();
    assert.equal(node('receipt-order-qr').hidden, true);
    assert.equal(node('receipt-order-code').children.length, 0);
    assert.equal(node('receipt-order-link').href, undefined);
    pending(); await loading;
    assert.equal(node('receipt-order-qr').hidden, false, 'verified terminal receipts retain locator, not payment authority');
    assert.match(node('receipt-status').textContent, status === 'paid_requires_review' ? /fulfillment is not confirmed/i : new RegExp(status, 'i'));
  }
  ok = false;
  const failed = node('receipt-refresh').click(); pending(); await failed;
  assert.equal(node('receipt-print').disabled, true, 'failed refresh must not print stale verified details');
  assert.equal(node('receipt-order-qr').hidden, true);
  assert.equal(node('receipt-order-code').children.length, 0);
  assert.equal(node('receipt-order-reference').textContent, '');
  assert.equal(node('receipt-order-link').href, undefined);
  ok = true; receipt = { ...receipt, orderId: 'invalid/id' };
  const invalid = node('receipt-refresh').click(); pending(); await invalid;
  assert.equal(node('receipt-order-qr').hidden, true, 'invalid server locator cannot become a QR');
  assert.match(node('receipt-status').textContent, /unavailable/i);
});
