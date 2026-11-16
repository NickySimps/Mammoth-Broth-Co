const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pickupEmailCopy } = require('../firebase/functions/pickup-email-copy.cjs');

const root = path.resolve(__dirname, '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const acceptedPickup = {
  fulfillmentMethod: 'market_pickup', orderName: 'Mammoth-12345678',
  status: 'pending', paymentMethod: 'pickup', marketName: 'Atlantic Beach Farmers Market',
  pickupDate: '2026-11-22', currency: 'usd', subtotal: 5000, discountAmount: 0,
  deliveryFee: 0, totalAmount: 5000,
  items: [{ name: 'Beef Broth', quantity: 2, price: 2500, itemTotal: 5000 }],
};

test('shop explains how to order and what market pickup means without implying checkout is currently open', () => {
  const html = read('shop.html');
  const steps = html.match(/<section\b[^>]*id="pickup-order-steps"[\s\S]*?<\/section>/)?.[0] || '';
  assert.ok(steps, 'a dedicated, named pickup instruction section is required');
  assert.match(steps, /<ol\b/);
  assert.match(steps, /choose your broth/i);
  assert.match(steps, /market and.*date/i);
  assert.match(steps, /recorded only after.*accept/i);
  assert.match(steps, /ready at the market and date you selected/i);
  assert.match(steps, /order reference/i);
  assert.match(steps, /payment is due at pickup/i);
  assert.match(html, /Online ordering is temporarily unavailable/i);
});

test('accepted checkout and private receipt clearly explain readiness and the order reference', () => {
  assert.match(read('checkout.js'), /ready at the selected market/i);
  assert.match(read('checkout.js'), /Bring your order reference/i);
  assert.match(read('receipt.mjs'), /ready at the selected market and date shown/i);
  assert.match(read('receipt.mjs'), /Bring your order reference/i);
});

test('pickup confirmation email records the exact selected market and date and readiness', () => {
  const text = pickupEmailCopy(acceptedPickup);
  assert.match(text, /recorded/i);
  assert.match(text, /ready at the selected market/i);
  assert.match(text, /Market: Atlantic Beach Farmers Market/);
  assert.match(text, /Pickup date: 2026-11-22/);
  assert.match(text, /order reference/i);
  assert.match(text, /payment is due at pickup/i);
});
