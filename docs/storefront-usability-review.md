# Mammoth Broth Co. — storefront usability review

## Implemented locally

- Sign in now targets the real sign-in panel, below the sticky navigation—not the large logo. Authenticated account-state changes target the visible orders panel.
- Shared page links target relevant content sections. Banner image dimensions are reserved, sticky-nav margins are included in measured offsets, and browser Back/reload scroll restoration is preserved.
- Mobile menus remove collapsed links from keyboard navigation, close with Escape, restore button focus, and remain internally scrollable on short screens.
- Cart/confirmation dialogs share background-scroll locking, keyboard focus entry/trapping, Escape closing, and focus restoration without moving the underlying page.
- Story/account pages without a cart dialog retain a working link to checkout. Back-to-top initializes correctly after restored scrolling and respects reduced motion.
- All eight storefront pages use the same primary navigation, heading/body fonts, button families, focus/disabled states, practical control sizes, and bounded dialog styling. The existing cave background remains selected.

## Verification and publication boundary

- `npm run test`: **37 passing, 0 failing**. Separate syntax checks for `nav.js`, `effects.js`, and `dialog.mjs` passed; `git diff --check` passed.
- Browser layout audit: **24 checks** across Home, Shop, Our Story, Markets, Contact, Account, Thank You, and Admin at 1440×900, 390×844, and 320×700. No horizontal overflow, duplicate IDs, captured runtime errors, or sampled controls below the 44px target; section targets were not hidden behind navigation.
- Browser interactions verified: real mobile Sign in navigation; cart Tab wrap/Escape/focus/scroll restoration; cart-to-checkout alignment; Story cart fallback; short-screen menu scrolling at 320×300; browser Back restored the previous 700px scroll position.
- Three real catalog products loaded during shop checks. No production order, payment, or email was created by this UI audit. Real provider sign-in and physical iOS behavior were not exercised.
- At the time of this pre-deployment review, these frontend changes were **local, uncommitted, and not pushed/deployed**. Earlier Firebase/backend repairs are separate. The user's existing `IDEA.md` edit was not changed; publication requires its own production verification.

## Earlier requests used

- Earlier Mammoth session `20260831_160449_195e4c`, user message **10727**: working payments and checkout; market pickup; Monday local delivery for five jars or more; special-order notes and owner approval before payment; restore market messaging. This later request supersedes the earlier temporary market pause.
- Same session, user message **10410**: a reversible market pause and printable page QR codes. Keep printed URLs stable and avoid hardcoded calendar drift.
- `docs/Mammoth Site Design.txt:367–508`: conversion-focused home/shop pages, product details, sourcing/process, real social proof, local pickup instructions, and contact/wholesale paths.
- `docs/Site Text Update.txt:1–22`: distinct beef/chicken descriptions and practical usage examples. Product and dietary claims still require business verification; old prototype prices are not current catalog authority.
- Unrelated Metronominal conversations were excluded.

## Ten proposed next improvements

1. **Finish real card payments first.** Complete provider configuration and signed webhook handling, then verify a real test-mode payment-to-order flow before exposing online payment as operational.
2. **Complete the special-request approval loop.** Give the owner explicit approve/decline controls; send a payment link only after approval, with the approved items and price visible to the customer.
3. **Make Monday delivery eligibility obvious.** Once delivery is operational, check the service area early, show the five-jar minimum and delivery fee/date before checkout, and enforce the same rules on the server.
4. **Use one authoritative pickup calendar.** Drive banners, market pages, checkout dates, cancellations, addresses, and operating hours from the same maintained data instead of separate hardcoded schedules.
5. **Show real availability and cutoff times.** Add per-batch/per-market capacity and order deadlines, enforced server-side, so customers cannot reserve sold-out stock or miss a pickup cutoff.
6. **Offer secure guest receipt/status links.** Let guest customers retrieve a receipt and pickup instructions without creating an account, using scoped, unguessable links—not public order queries.
7. **Expand verified product details.** Add actual jar photos, volume, ingredients/allergens, storage/shelf life, and usage examples; clearly distinguish mushroom broth from animal-based products. Use genuine testimonials only.
8. **Pair the brand language with plain checkout labels.** Keep the cave identity, but make Cart, Checkout, pickup date, payment due, and approval status immediately understandable. Add a final order-summary review and inline field errors.
9. **Allow controlled order changes.** Offer authenticated or securely linked quantity changes/cancellation before a clearly stated cutoff, with server-side stock and approval checks and a refreshed receipt.
10. **Make jar QR visits task-focused.** Keep existing printed URLs working, then offer prominent product/care instructions, reorder, and next-pickup actions; add market-specific links without making customers traverse the full banner/homepage.

## Background options

Original deterministic procedural artwork was generated with Pillow/numpy, not a diffusion model or stock textures:

- **Limestone / Ochre** — warm mineral texture, closest to the existing cave palette.
- **Quiet Parchment** — light, restrained prehistoric linework; my preference for commerce/readability.
- **Charcoal / Ember** — dark stone with subtle mineral seams; suited to a hero or story section with light text.

Each is a **1024×1024 seamless PNG and lossless WebP**. Opposite decoded edge pixels match exactly. `assets/background-options/comparison-board.png` shows all three behind an illustrative UI specimen; it is not a screenshot of a deployed redesign or real product photography. `manifest.json` records dimensions, file sizes, hashes, and seam checks. Reproduce with `python scripts/generate-background-options.py` (Pillow and numpy required).

**No new background has been applied.**
