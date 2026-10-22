import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('new jar QR decodes to its documented destination without changing printed page QRs', t => {
  const qr = new URL('../assets/jar-qr.png', import.meta.url);
  assert.ok(existsSync(qr), 'new jar QR must exist');
  const probe = spawnSync('python', ['-c', 'import cv2'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('Python OpenCV unavailable; run documented decode check before printing');
  const decoded = spawnSync('python', ['-c', 'import cv2,sys; image=cv2.imread(sys.argv[1]); value,_,_=cv2.QRCodeDetector().detectAndDecode(image); print(value)', fileURLToPath(qr)], { encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr);
  assert.equal(decoded.stdout.trim(), 'https://mammothbroth.com/jar.html');
  const generator = readFileSync(new URL('../generate_qr.py', import.meta.url), 'utf8');
  for (const [name, page] of [['home', 'index.html'], ['shop', 'shop.html'], ['our-story', 'about.html'], ['markets', 'markets.html'], ['contact', 'contact.html'], ['account', 'account.html'], ['thank-you', 'thank-you.html']]) {
    assert.ok(generator.includes(`"${name}": "${page}"`));
    const existing = new URL(`../assets/${name}-qr.png`, import.meta.url);
    assert.ok(existsSync(existing));
    const legacy = spawnSync('python', ['-c', 'import cv2,sys; value,_,_=cv2.QRCodeDetector().detectAndDecode(cv2.imread(sys.argv[1])); print(value)', fileURLToPath(existing)], { encoding: 'utf8' });
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(legacy.stdout.trim(), page === 'index.html' ? 'https://mammothbroth.com/' : `https://mammothbroth.com/${page}`, `${name} printed destination`);
  }
});
