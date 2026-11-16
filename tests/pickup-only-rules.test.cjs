const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Static contract checks, not a substitute for Firestore emulator evaluation.
const rules = fs.readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8')
  .replace(/\/\/[^\n]*/g, '');

function collectionBlock(collection, parameter) {
  const start = `match /${collection}/{${parameter}} {`;
  const offset = rules.indexOf(start);
  assert.notEqual(offset, -1, `missing ${collection} rules`);
  const end = rules.indexOf('}', offset + start.length);
  assert.notEqual(end, -1, `unterminated ${collection} rules`);
  return rules.slice(offset + start.length, end).trim();
}

function compact(text) {
  return text.replace(/\s+/g, ' ').trim();
}

test('only promotions remain publicly readable settings; delivery policy is retired', () => {
  assert.equal(compact(collectionBlock('settings', 'settingId')),
    "allow read: if settingId == 'promotions'; allow write: if false;");
});

test('pickup markets and products remain public and client immutable', () => {
  for (const [collection, parameter] of [['markets', 'marketId'], ['products', 'productId']]) {
    assert.equal(compact(collectionBlock(collection, parameter)),
      'allow read: if true; allow write: if false;');
  }
});

test('historical orders and their receipts stay owner/admin readable and client immutable', () => {
  assert.equal(compact(collectionBlock('orders', 'orderId')),
    'allow create, update, delete: if false; allow read: if request.auth != null '
      + '&& (resource.data.customerUid == request.auth.uid || request.auth.token.admin == true);');
});

test('payment event and binding records remain inaccessible to every client', () => {
  for (const [collection, parameter] of [['stripeEvents', 'eventId'], ['paymentBindings', 'intentId']]) {
    assert.equal(compact(collectionBlock(collection, parameter)),
      'allow read, write: if false;');
  }
});

test('unmatched documents and historical subcollections retain implicit default deny', () => {
  assert.match(rules, /^\s*rules_version = '2';\s*service cloud\.firestore\s*\{/);
  const matches = [...rules.matchAll(/\bmatch\s+([^\s]+)\s*\{/g)].map(match => match[1]);
  assert.deepEqual(matches, [
    '/databases/{database}/documents',
    '/orders/{orderId}',
    '/stripeEvents/{eventId}',
    '/paymentBindings/{intentId}',
    '/products/{productId}',
    '/markets/{marketId}',
    '/settings/{settingId}',
  ]);
  // No extra top-level grant may silently make an otherwise denied path public.
  assert.equal([...rules.matchAll(/\ballow\s+/g)].length, 10);
});
