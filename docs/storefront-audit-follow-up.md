# Storefront audit follow-up — pickup activation verified

Date: 2026-10-22.

**Release gate satisfied for pickup:** the deployed callable accepted a real App Check-backed, no-charge test order (Mammoth-deb38375), the exact Firestore record was independently read back, and its private receipt matched. See pickup-activation-verification.md. Stripe, email and unconfigured delivery remain disabled.

## Verified locally

- Latest activation rerun on verified portable Node.js 22.23.4: **155 tests, 154 passed, 0 failed, 1 skipped**; the unrelated QR decode requires Python OpenCV on this execution environment. Earlier local 155/155 evidence below came from a different installed Python environment.
- Full installed backend ESLint: exit 0 (`node node_modules/eslint/bin/eslint.js .` from `firebase/functions`).
- Scoped whitespace and added module syntax checks passed; Git reports existing Windows line-ending conversion notices, not whitespace errors.
- Browser matrix: all ten customer/owner-facing pages at 1440×900, 390×844 and 320×700 — **30 checks**, no horizontal overflow, broken loaded images, runtime errors, unhandled rejections or captured console errors. Sign-in/content anchors remained below the sticky stack.
- Real browser keyboard Enter increased cart quantity and retained the equivalent quantity-control focus. Removing the last item focused the cart summary. Summary and floating modal displayed the same total for the exercised bundle. Browser cart state was restored after QA.
- Browser schedule helper returned October 25, 2026 for the same New York market boundary instant when browser timezone was Honolulu, Tokyo or New York. Approved-date/day/DST/invalid-policy cases are also covered by automated tests.
- The banner's sibling visitor-timezone/DST bug was reproduced separately before fixing it: a Tokyo visitor saw TODAY instead of TOMORROW, and a New York spring-DST transition mislabeled Tuesday as TOMORROW. Two new regression tests pass. Three real browser timezone checks now give identical market-local banner text and correct sticky geometry.
- Firebase Auth configuration was read with server-side partial field selection excluding OAuth secrets/hash material: email auth and Google/Facebook/Apple providers are enabled; root/www production domains are authorized. This checks configuration, **not** successful OAuth login, customer account creation, or an authenticated owner session.
- Four new cave-painting candidates were independently checked against their manifest for hashes/dimensions and exact tile-edge continuity. Current applied background remains unchanged. The candidate ZIP is outside the repository/hosting root.
- Added/new production-source static scan: 494 lines across 20 files checked for literal secret assignments, private-key material, shell execution and dynamic evaluation; no matches. This is a scoped scan, not a whole-history security certification.

Both independent reviews passed with no security or logic findings. The main reviewer independently ran 153 tests; the banner calendar delta reviewer independently passed the 9-test banner/navigation command and checked closing-hour, rollover and DST behavior. Parent's final full-suite result is 155/155. These checks are not a claim that every production integration or physical device has been exercised.

## Audit fixes implemented

1. Account history now distinguishes actual lifecycle/payment states, especially payment received with fulfillment requiring owner review. Terminal/unknown states do not promise an active pickup; paid special orders do not claim approval/payment is pending.
2. Account-local order fallback requires an exact authenticated `customerUid`; matching a cached guest email does not confer ownership. Guest receipts remain capability-bound.
3. Authorized admin delivery rows show delivery date and escaped address instead of a pickup date.
4. Pickup selection follows structured `pickupDates` or `weekday`/legacy `day` in the market timezone, with invalid schedules/limits failing closed. Legacy ID-based availability guesses were removed.
5. Frontend discounts cannot increase catalog totals; malformed policies do not fabricate savings. Backend promotion values are validated before writes/provider work.
6. Floating cart uses the configured promotion, including promotion updates from the shop, rather than silently applying an unrelated default.
7. Cart quantity rerenders preserve keyboard focus, with a predictable surviving-control or empty-summary fallback.
8. Customer/operations email sends have separate durable version checkpoints. Retry skips recipients already checkpointed. SMTP acceptance followed by a crash/checkpoint failure can still duplicate; this is **not exactly-once delivery**, and historical partial sends cannot be reconstructed.
9. Private receipts handle terminal/unknown states without demanding pickup payment or promising fulfillment. Ordinary card attempts no longer claim special-order approval or owner-approved hosted-payment setup.
10. Unconfigured ordering actions are visibly disabled and guarded against click/Enter submission. The cart remains usable for planning; availability copy no longer promises an online reservation in disabled mode. Configured controls do not retain an inaccessible, contradictory unavailable-status description.
11. Home/market/contact copy no longer calls a fixed Sunday market the next gathering or describes all locations as three weekend locations. Conflicting 24/48-hour simmer numbers were removed pending owner confirmation. Wholesale link text now matches its **unchanged** `.co` destination; the general `.com` address remains unchanged.
12. Market banner is sticky above navigation and labels gatherings in the market's Eastern civil calendar rather than the visitor timezone or DST-sensitive elapsed-day calculation. Measured banner/nav heights update scroll offsets and constrain short-screen mobile menus. Existing background and the owner's `IDEA.md` edit are preserved.

## Activation and verification still required

- App Check API/provider setup completed with explicit user approval for possible quota-overage billing. Production SCORE website key is restricted to approved hosts; Firebase configuration read back with minValidScore 0.5 and one-hour TTL; real domain attestation passed without debug bypass.
- User approved and parent applied numeric weekdays plus America/New_York timezone to the four existing market records using field masks and update-time preconditions, preserving names and other fields. No capacity/cutoff guesses were added.
- Keep card payment, automatic email and unconfigured delivery disabled until their respective merchant secrets, webhook, sender and service-area policy are provisioned and their real paths tested. Local SMTP mocks are not delivered messages.
- Real App Check-backed pickup creation/private receipt verification succeeded on deployed Firebase hosting. Custom-domain release verification is tracked in pickup-activation-verification.md; no Admin SDK order or intercepted success was used.
- Actual provider sign-in, authenticated production owner operations, physical mobile-device checks and real payment/email delivery were not exercised in this follow-up.
- Owner content confirmation remains needed for the canonical `.com` versus `.co` mailbox and actual simmer duration. Technical tests do not establish mailbox deliverability, testimonial authenticity, product claims or food-care suitability.

## Scope preservation

Initial audit work preserved IDEA.md, local Firebase state, temporary directories, and unselected artwork. Following user activation approval, the tested backend/hosting were deployed, approved App Check and schedule settings were configured, and a clearly marked no-charge test order was saved via the normal customer flow. Do not include IDEA.md, caches, temporary directories or unselected artwork in the release commit. No card charge, new customer account or customer email was produced.
