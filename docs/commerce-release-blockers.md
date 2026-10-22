# Commerce release status — approved for disabled-ordering publication

The user authorized publication without Stripe. Final release review approved this explicitly disabled-ordering mode: catalog, cart planning, jar landing, receipt/admin screens and protected backend may be published; order creation, online payment and automatic email are NOT operational. Frontend App Check key remains empty and deployed payment/email flags must be false. Full release suite: 119 passed, 0 failed, 0 skipped; backend ESLint and Node.js 22 manifest/lock consistency verified. Activation prerequisites below remain mandatory before accepting orders.

Selected scope: card payments, special-order approval/payment link, Monday delivery eligibility, secure guest receipts, task-focused jar QR landing.

Publication completed in disabled-ordering mode. Commit 7171af2 and follow-up 8e48bf4 were pushed to origin/vanilla. Firebase Functions/rules and Hosting were deployed, and the custom root/www hosts were read back. All 11 functions reported ACTIVE on nodejs22 with payments/email false. No live payment or customer email was created. The requested browser pickup test was attempted but rejected by missing App Check configuration; no receipt/reference was issued. See docs/publication-verification.md for final evidence.

## Verification

After explicit user authorization to change app.js, checkout integration was implemented and independently rerun by the parent: npm test — 97 tests, 97 passed, 0 failed, 0 skipped. App-specific tests cover first-submit mount vs second-submit confirmation, full customer pending-order request, stale async invalidation, fail-closed delivery and quote changes, and blocking charge when no receipt capability was returned. Scoped whitespace verification passed. A separate optional backend documentation write previously reached an approval gate; it has not been retried.

Latest parent full rerun: 117 tests passed, 0 failed, 0 skipped; syntax and whitespace checks passed. Independent rereview PASSED the three specified security/recovery boundaries with no findings remaining in that scope (not a whole-application or live-service security certification).

1. Removed IP/forwarded-header limiter identity. Both creation callables enforce SDK-verified Firebase App Check. Installed real v1 HTTP runtime rejected forged/missing attestation behind trust-proxy with no order/provider work. Email-hash/global budgets remain layered limits, not complete distributed-abuse protection.
2. Receipt paid_requires_review now explicitly says payment received, fulfillment unconfirmed, owner reconciliation/refund required, do not pay again; pickup/delivery promises and payment actions are hidden.
3. Browser generates and persists a 32-random-byte, 64-lowercase-hex receipt capability before first creation. Hash-only server storage and matching capability/payload/UID/expiry/revocation checks protect retries and client-secret disclosure. Provider-failure retries retain usable proof; legacy proof cannot be insecurely reissued.

Reviewer ran 67 focused tests and reread updated app.js before rerunning 21 frontend tests plus negative in-memory probes. Parent browser check confirmed three catalog products and explicit rejection of order creation when App Check is unconfigured; no order was submitted.

## Other release blockers

- Register the Firebase web app with App Check, provision a real Enterprise public site key and approved production domains, set commerce-config.mjs, and verify real attestation. Empty configuration intentionally rejects creation, including signed-in orders and retries. Catalog/receipt reads remain independent.
- App.js integration and local suite are complete; verify actual provider/deployed flows after configuration. Do not equate local mocks with live payment verification.
- Confirm actual owner-approved market schedules/timezone and occurrence capacity/cutoffs before modifying live data. Public live market reads found names but no structured schedule; new backend intentionally rejects these unconfigured pickups.
- Confirm delivery ZIP allowlist, fee, cutoff and timezone/business-date policy; otherwise leave delivery disabled.
- Provision rotated Stripe secret, webhook signing secret, email secret, sender and origin via trusted dashboards/prompts. Payment/email flags default disabled; do not silently claim operational payments/email.
- Preserve unrelated pre-existing IDEA.md edit.
- Run real test-mode Stripe signed webhook/order/receipt/admin/email end-to-end verification with authorized provider access; production browser/mobile/QR checks after actual deployment.

Backend changes already verified in rereview: unpaid card setup no longer reserves capacity, settlement reserves transactionally or records paid_requires_review; email single-recipient validation; frozen approval recovery; authoritative orderName; matching-order receipt restoration; timezone/occurrence-bound pickup validation. These verified improvements do not override the remaining blockers above.
