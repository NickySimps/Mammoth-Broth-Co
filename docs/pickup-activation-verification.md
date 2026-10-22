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
- Private receipt followed through actual confirmation link returned HTTP200 and showed the same reference/items/total/date, payment due at pickup, no card-pay link, no runtime errors. Query/fragment scrubbed before receipt request; proof not printed in tools or documentation.
- Customer confirmation correctly says email pending/not delivered. No email or card payment sent.

## Publication status

Firebase hosting/backend tested. Commit/push and custom-domain parity are the next publication steps; update this section with their verified outcome. The deliberately named test order remains a test and must not be fulfilled.

## Still excluded

Stripe, delivery checkout and automatic email are not activated. Food/product facts, physical devices, real provider sign-in and owner account session remain outside this verification. Preserve unrelated IDEA.md changes and unselected artwork.
