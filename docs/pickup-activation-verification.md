# Pay-at-pickup activation verification

## Approved configuration

The user explicitly approved enabling reCAPTCHA Enterprise (including possible quota-overage charges) and using the existing advertised market weekdays in America/New_York timezone. Stripe and automatic email remain disabled.

- reCAPTCHA Enterprise API and Firebase App Check API read back ENABLED.
- Production SCORE website key has domain checking enabled; allowed hosts restricted to mammothbroth.com, www.mammothbroth.com, mammoth-broth-co.web.app and mammoth-broth-co.firebaseapp.com.
- Firebase web App Check configuration read back the registered public key, 3600s TTL and existing minimum valid score 0.5. No debug token or relaxed risk threshold.
- Existing market documents updated with only numeric weekday and timezone using update masks and update-time preconditions: Atlantic 0, Palm 2, Murray 3, Ponte Vedra 5. No invented capacities, cutoff times or stock changes.

## Local release evidence

Reviewed complete working candidate including prior audit fixes and schedule helper. Independent activation review found no security/logic blocker. Verified official portable Node.js22 archive checksum before use because default machine Node had changed to20. npm test on Node22.23.4:155tests,154passed,0failed,1skipped (unrelated OpenCV-dependent QR decoder). Backend ESLint and scoped whitespace checks passed.

## Real deployed pickup order

Backend/rules deployed before hosting. On https://mammoth-broth-co.web.app/shop.html, an isolated real browser submitted the normal Pay at Pickup flow. No successful response mocks, debug attestation, direct-admin order creation or card charge.

- Test identity clearly marked TEST ONLY; non-deliverable example.invalid email.
- One mushroom broth jar; selected Atlantic Beach; computed pickup date2026-10-25.
- createPreorder returned HTTP200 with authoritative reference Mammoth-deb38375.
- Exact order independently read via authenticated Firestore GET: deb3837579b10b4c005fdbe355ecf7a0d61022d95691bdd0f46fd77e01b006da.
- Persisted status pending, paymentMethod pickup, fulfillmentMethod market_pickup, marketId market_atlantic, pickupDate2026-10-25, totalAmount2500cents, one mushroom jar, receipt hash present.
- Private receipt followed through actual confirmation link returned HTTP200 and showed the same reference/items/total/date, payment due at pickup, no card-pay link, no runtime errors. Query/fragment scrubbed before receipt request. No receipt proof is recorded in this documentation; verification capabilities were revoked after cleanup.
- Customer confirmation correctly says email pending/not delivered. No email or card payment sent.

## Publication status

Firebase backend/rules/hosting were deployed and verified before commit 07628c2 was pushed to origin/vanilla. The GitHub remote SHA readback matched. Root/www/Firebase hosts then returned app.js, commerce-config.mjs and schedule-helper.mjs matching source after line-ending normalization.

A second real Pay at Pickup test on mammothbroth.com saved Mammoth-ed7e2574 (order ed7e2574c872447706c34225e74a3841ac2818ba0ffa6992a4449599b83319d1): one mushroom jar,2500cents,Atlantic Beach,2026-10-25,pending/pickup. Exact Firestore readback and normal private receipt confirmed the same details. No alert/provider error, no card-pay link, and zero third-party receipt scripts.

After successful verification, both exact test orders were marked cancelled/isTest=true with update-time preconditions and strict test-identity checks. Both test receipt capabilities were revoked; no real customer record was changed. Before revocation, the refreshed custom-domain receipt correctly showed cancellation and hid fulfillment/payment promises. No test order should be fulfilled.

Final readback: all11 functions ACTIVE/nodejs22; payments/email flags false. Unattested createPreorder still returns401 UNAUTHENTICATED. Root and www receipt routes return200,no-store/no-transform,no-referrer and no analytics injection. The no-UA command-line probe hit Cloudflare403; normal-browser User-Agent probes and actual browser succeeded.

## Still excluded

Stripe, delivery checkout and automatic email are not activated. Food/product facts, physical devices, real provider sign-in and owner account session remain outside this verification. Preserve unrelated IDEA.md changes and unselected artwork.
