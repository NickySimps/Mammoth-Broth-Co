# Primary receipt QR: salesperson order lookup

Supersedes the public-only layout in receipt-qr.md.

## Behavior and trust boundary

- Largest QR near verified order details:280px desktop,209px at tested320px viewport,55mm print. Public shop/markets/jar codes remain near the bottom at110px screen/28mm print.
- Main payload: `https://mammothbroth.com/staff.html#order=ORDER_ID`. No customer data, guest receipt capability or payment URL. A locator is not authorization.
- staff.html requires an existing Firebase admin-claim account, using email/password or Google. No new roles/accounts are created. The application reads only one exact document, from the server; no collection or offline-cache fallback. Existing Firestore rules remain unchanged.
- Identity-generation fencing rejects late claim/read responses, including sign-out/back-in races. Private DOM clears immediately on auth changes/sign-out/pagehide. Explicit allowlist rendered with textContent; no proof/hash/provider URL is displayed. No payment/fulfillment writes occur on scan.
- Missing/failed receipt refresh hides and clears main QR/link/reference. Existing cancelled/refunded/review warnings remain. QR generation is local, black/white, four-module quiet zone; pinned MIT library/license/hashes in vendor/README.md.
- Staff clean/.html routes get no-store/no-transform/no-referrer/nosniff/DENY/noindex headers. Credentials remain disabled until JavaScript prevents native submission; passwords clear after attempts.

## Print/email

Print hides private receipt links and payment/refresh/print controls. Compact typography fits the tested one-item fixture on one page; larger orders may paginate. Main55mm code remains larger than28mm public codes.

The active email renderer preserves original plain text/status/reference and recipient checkpoints. Main280px code is a local GIF MIME inline attachment with matching CID; public shop/jar120px codes are near the bottom. Email stays disabled; no mail/provider/payment/delivery flags were enabled and no real email was sent.

## Verified

- Node22.23.4 full suite:196 tests,195 passed,0 failed,1 skipped (existing optional OpenCV decode).
- Observed RED→GREEN regression: a cached paid order cannot replace a fresh server response. Auth/read races, non-admin/wrong-user rejection, single-document reads, safe rendering and no writes covered.
- Parent manual security review completed after external reviewer quota failure; no successful independent final audit is claimed.
- Parent Chromium at320/390/1280px: no overflow; main209/279/280px versus110px secondary, preceding the bottom group. Real-SDK signed-out staff page hides all customer details.
- Parent explicitly intercepted sample receipt marked FIXTURE — NOT A REAL ORDER. One-page Chromium PDF decoded all four exact destinations with local ZXing. Private fixture proof absent from PDF text/link annotations. Stub restored; no live order fabricated.
- Live anonymous exact-order Firestore read denied403. A live authorized staff sign-in/read and physical phone scan remain unverified and require an authorized operator/device.
- Email GIF decodes atnative/260/280px; public PNGs decode at120px. Offline MIME composition tested. Backend ESLint and new-module syntax checks passed.

Repeat:
```
node --test --experimental-vm-modules tests/*.test.mjs tests/*.test.cjs
uv run --python 3.13 --with pillow --with zxing-cpp python tests/receipt-email-qr-decode.py
```

## Publication readback

Code commit e4ae802 pushed to origin/vanilla. The first Firebase deployment stopped after a function-update failure despite exit0; it was not counted as success. The retry explicitly reported all11 successful function updates and hosting release complete.

Root/www/Firebase canonical assets matched the committed source after line-ending normalization: staff HTML/controller/store, lookup helper, receipt controller/QR helper/CSS and vendored generator. Root/www clean and.html staff routes returned200,no-store/no-transform,no-referrer with no analytics injection. Firebase staff.html also returned200 with those headers; its optional extensionless /staff path returned404, so all QR links deliberately use the canonical staff.html route.

All11 functions read back ACTIVE; card/email enable flags remained false. Live anonymous exact-order read still denied403. Actual mammothbroth.com staff page showed sign-in required with no customer DOM; shop still enabled pickup and listed Beef,Chicken,Mushroom in that order. No live authorized staff session, physical-device scan, real email or new test order was performed.
