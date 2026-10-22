# Receipt QR codes

**Superseded layout:** the largest code now opens exact-order staff lookup with independent admin sign-in; public codes are smaller at the bottom. See `staff-order-qr.md` for current behavior and verification. The initial public-only release evidence below is retained as history.

Scope follows the owner's clarification: primarily receipts and order confirmations, not QR blocks throughout the storefront.

## Customer-facing receipts

`receipt.html` and `thank-you.html` offer three static QR codes and normal same-origin links:

- Shop: https://mammothbroth.com/shop.html#products-section
- Public market schedule: https://mammothbroth.com/markets.html#market-calendar
- Jar help: https://mammothbroth.com/jar.html

These do not encode order IDs, customer data, receipt capabilities, approved payment URLs, or an automatic cart action. The public schedule does not change or confirm the order's selected pickup. The existing secure receipt callable and fragment/session capability flow are unchanged.

A Print / save receipt as PDF button enables only after successful receipt loading, and disables on refresh/failure. Print CSS removes navigation, visual backgrounds, refresh/print/payment controls and the private share link. Existing status, reference, items, total and legitimate fulfillment text remain authoritative. A printout is a snapshot; refresh the live receipt for current status. Browser-provided print headers/footers are controlled by the print dialog.

QR images remain same-origin under the existing private-page CSP. No external QR API or analytics was added. Local generation uses black modules on opaque white, medium error correction and a four-module quiet zone. Existing printed QR assets and generate_qr.py remain untouched.

## Email confirmations

The active commerce sender now includes an HTML alternative with locally hosted public shop/jar QR images. Existing plain text, status/reference copy, subject and per-recipient retry checkpoints are preserved. The renderer HTML-escapes receipt text and uses fixed public destinations only. Focused email/commerce tests passed53/53, including all seven text branches, disabled-mail behavior and partial-send retries. Email remains disabled; this change does not configure Gmail or send mail. The obsolete legacy email-template.js is not the active commerce sender and was not modified.

## Generation and verification

```
uv run --python 3.13 --with qrcode --with pillow --with zxing-cpp scripts/public_qr.py
uv run --python 3.13 --with qrcode --with pillow --with zxing-cpp scripts/public_qr.py --verify
node --test tests/public-qr-assets.test.mjs tests/receipt-qr.test.mjs tests/receipt-lifecycle.test.mjs tests/commerce-ui-receipt.test.mjs
```

Four new public masters (shop, markets, contact, jar) are in assets/qr as PNG/SVG, with exact destinations.json. All four PNGs decoded correctly at full resolution and at 160px display size. The receipt uses three; contact is for the optional print sheet.

## Browser/print evidence

- Chromium receipt layout at 320,390,1280px: three images loaded and no horizontal overflow.
- The missing/unavailable receipt remained fail-closed with Print disabled.
- An explicitly intercepted sample receipt response (not an actual order or live callable success) exercised normal receipt rendering and enabled Print. Its reference was marked SAMPLE, not an order. The fetch stub was restored afterward.
- A one-page sample PDF rendered through Chromium decoded all three expected public QR destinations with local ZXing. The private share link and payment/print/refresh controls were hidden in print media.
- Receipt refresh/print and lifecycle focused tests:7 passed,0 failed. Broader full-suite snapshot:170 tests,169 passed,0 failed,1 skipped (existing optional OpenCV QR decode).
- No real order was placed, customer record modified, payment charged or email sent for this QR verification. A physical printed-phone scan remains advisable before a production label run.
