import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
test('Cloudflare clean and html private routes carry no-store and no-referrer', () => {
  assert.ok(existsSync('_headers'), 'Cloudflare Pages needs its own headers file');
  const blocks = new Map(readFileSync('_headers', 'utf8').trim().split(/\n\s*\n/).map(block => { const [path, ...headers] = block.split('\n'); return [path.trim(), headers.join('\n')]; }));
  for (const route of ['/receipt', '/receipt.html', '/thank-you', '/thank-you.html', '/admin', '/admin.html']) {
    assert.match(blocks.get(route) || '', /Cache-Control: no-store/);
    assert.match(blocks.get(route) || '', /Referrer-Policy: no-referrer/);
  }
  for (const route of ['/receipt', '/receipt.html', '/thank-you', '/thank-you.html']) {
    assert.match(blocks.get(route) || '', /Content-Security-Policy:.*script-src 'self'/);
    assert.match(blocks.get(route) || '', /frame-ancestors 'none'/);
  }
});
