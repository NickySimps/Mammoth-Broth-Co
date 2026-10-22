# Disabled-ordering publication verification

## Published artifact

- Git branch: vanilla; code commits 7171af2 (reviewed commerce release) and 8e48bf4 (Cloudflare private-route headers).
- Parent verified origin/vanilla readback against pushed commits.
- Firebase project: mammoth-broth-co. Functions and Firestore rules deployed before hosting. Hosting release command succeeded.
- Readback: all 11 functions ACTIVE on nodejs22; COMMERCE_PAYMENTS_ENABLED=false and COMMERCE_EMAIL_ENABLED=false on every function.
- No Stripe setup, secret rotation, payment, SMTP delivery or production business-setting writes were performed.

## Local verification

- npm test: 120 passed, 0 failed, 0 skipped after Cloudflare header regression test.
- Backend ESLint and whitespace checks passed. Independent release review approved unavailable-ordering publication, not operational checkout.
- Unrelated IDEA.md edit remains uncommitted. No environment-file credentials committed.

## Live readback

- Firebase hosting shop.html, jar.html, receipt.html, app.js and commerce-config.mjs returned HTTP 200; initial deployed bytes matched source.
- mammothbroth.com and www.mammothbroth.com serve the new availability warning, jar landing and receipt screens; Cloudflare redirects .html routes to clean routes.
- app.js differs only by line endings after text normalization; initial HTML differences were Cloudflare's analytics injection.
- Added Cloudflare Pages _headers and verified custom root/www private clean and .html routes now return Cache-Control: no-store, no-transform and Referrer-Policy: no-referrer. Receipt/thank-you also have restrictive CSP. Analytics injection absent on checked private routes.
- 390px live browser: jar and receipt measured scrollWidth=390, no horizontal overflow. Receipt without capability shows private-link help, no account requirement and zero external scripts.
- Public custom-domain catalog loaded three products and the configured market selector.

## Live security probes (no valid creation)

- createPreorder without attestation: HTTP 401 UNAUTHENTICATED.
- createPaymentIntent without attestation: HTTP 401 UNAUTHENTICATED.
- getGuestReceipt malformed probe: HTTP 400 INVALID_ARGUMENT, no order data.
- reviewSpecialOrder unauthenticated: HTTP 403 PERMISSION_DENIED.

## Requested mock pickup test

- Actual live shop UI used a clearly marked deployment-test customer and non-deliverable example.invalid email.
- Added one mushroom broth jar, selected Atlantic Beach pickup, UI date 2026-10-25, and clicked Pay at Pickup.
- Submission produced: “Secure ordering is unavailable or could not be verified. Retry unchanged details or contact us before creating another order.”
- Confirmation dialog remained hidden; no order reference or receipt was issued; local order history and saved receipt were unchanged. No charge or email occurred. Browser cart restored after the test.
- This was a real blocked customer flow, not a successful mock sale or a mocked successful API response. Creation is blocked before provider/order work while the App Check key is absent. No bypass/debug token/direct admin order was used.

## Activation remains incomplete

- Provision/register Enterprise site key + Firebase App Check with actual domains and verify real attestation before enabling creation.
- Confirm authoritative pickup timezone/schedules/occurrences and reconcile capacity; public market documents currently have names but no structured scheduling fields.
- Delivery service-area/fee/cutoff approval remains outstanding; delivery unavailable.
- Stripe and email remain disabled and require separate secure configuration and end-to-end tests.

The deployed site is available for browsing/cart planning and contact. It is not accepting online pickup orders yet.
