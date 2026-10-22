# Jar QR landing page

## Scope and destinations

New entry point: `https://mammothbroth.com/jar.html`.

- `assets/jar-qr.png` (888 × 888, four-module quiet zone, error correction M) and `assets/jar-qr.svg` encode that URL. The SVG is the vector print master. Do not crop the quiet zone. Verify the page is deployed and scan a physical proof before printing labels; this task does not deploy it.
- Existing printed page QRs and `generate_qr.py` are unchanged. Home, shop, our-story, markets, contact, account, and thank-you destinations remain intact.
- Optional example: `jar.html?product=prod_beef&market=market_atlantic`. Product and market values must match exact active IDs returned by the existing catalog; duplicate, malformed, reserved-object-key, and unknown IDs are ignored. No redirect or arbitrary URL parameter is supported.
- Product IDs are Firestore document IDs, not display names. The page loads products and markets using the existing `store.js` read APIs. It does not create a parallel market schedule.

## Customer behavior

Primary links immediately reach `shop.html#products-section` and `markets.html#market-calendar`, without traversing the full homepage banner. Product details link to the existing shop product section; the existing shop does not expose per-product fragment IDs, so none are invented.

Selecting a product never adds anything. Only **Add 1 jar & review order** can add one currently available catalog product to the existing `mammothCart` local-storage cart, preserving existing quantities, then navigate to `shop.html#order-section`. It does not place an order, take payment, or reserve inventory. Invalid/damaged/blocked carts fail closed instead of being replaced, and the action cannot exceed the existing 12-jar limit. Checkout still verifies availability and pricing.

A valid optional market identifies context from the actual market catalog. It does not silently choose a pickup location, promise a date, or change checkout. Customers confirm pickup in the shop. No delivery promise is made.

No verified batch-specific care instructions were present in the inspected catalog/page sources. The page directs customers to their physical label and the existing `contact.html#main-content` for storage, reheating, ingredient, or allergen questions. No shelf-life, ingredient, allergen, or heating rules are invented.

There are no analytics, account actions, cloud mutations, order submissions, or third-party QR requests from this page. It uses only the existing product/market read APIs; the reorder action writes only the local cart after the customer's click.

## Failure paths

A failed or five-second catalog read timeout leaves normal shop/contact/market links usable. Reference-only Beef Broth (`prod_beef`) and Chicken Broth (`prod_chicken`) names/IDs come from `seed-db.html`; no copied prices, stock, ingredients, or schedule are used. In this mode reordering stays disabled and no market-specific claim is shown. A missing market read does not invent a replacement market. With JavaScript disabled, the static links and explicit noscript help remain available.

## Test-first evidence (October 22, 2026)

Each implementation slice was preceded by an observed failing test:

1. ID resolver: `jar module must exist` → one passing test.
2. Explicit-action local reorder: `explicit reorder action must exist` → two passing tests.
3. Landing/controller: `landing controller must exist` / `jar HTML must exist` → four passing tests.
4. QR asset: `new jar QR must exist` → five passing tests including decoding.
5. Reserved catalog keys: `reserved object keys are never usable catalog IDs` → five passing tests again.

Commands:

```sh
node --test tests/jar*.mjs
node --check jar.mjs
git diff --check -- jar.html jar.mjs jar.css tests/jar.test.mjs tests/jar-qr.test.mjs docs/jar-qr.md
```

Final scoped result: **5 tests passed, 0 failed, 0 skipped**. Python OpenCV was available: the new jar PNG and all seven existing public page QR PNGs decoded to their exact expected URLs. The test skips decoding explicitly when Python/OpenCV is unavailable. QR generation used local Python `qrcode`, not a cloud service.

Full `npm test` was also run while other agents were changing the shared repository. The last observed snapshot had **69 tests, 62 passed, 7 failed**, all outside `jar*`: admin lifecycle/owner queue, commerce UI card setup/stale setup/delivery, legacy functions, and navigation. These shared files were not edited by this task; rerun the full suite after the parallel work settles.

## Real-browser evidence

Served locally at `http://127.0.0.1:8910` and checked in Chromium:

- 390 × 844, 320 × 720, 375 × 568, and 1280 × 900 viewports: no horizontal overflow. Primary controls measured at least 48 px high on desktop. Desktop and mobile screenshots are `assets/jar-desktop.png` and `assets/jar-mobile.png`.
- The actual catalog returned `mushroom`, `prod_beef`, and `prod_chicken`; the selector populated from those reads, not only the reference fallback.
- Valid `prod_beef` / `market_atlantic` selected Beef Broth and displayed the actual Atlantic Beach catalog name. Initial scan produced zero cart writes. Clicking the real mounted reorder button once produced exactly one local write: `{prod_chicken: 2, prod_beef: 1}`, with navigation target `./shop.html#order-section`. Navigation was intercepted for this test; no checkout/order request was made, and prior local cart state was restored.
- Blocking `store.js` in the browser exercised the real fallback: reference product selected, reorder disabled, generic market guidance, no cart, no horizontal overflow.
- An external-URL product value and unknown market left the selector empty and reorder disabled, without a cart write or redirect.
- Keyboard Tab reached **Skip to jar help** with a visible solid focus outline.
- Fetched actual HTML and verified all four destination anchors exist: shop products, shop order, market calendar, contact main content.
- Installed a browser error/unhandled-rejection monitor before a fresh load, asserted its sentinel, then read back **zero runtime errors** and removed the preload monitor.

One screenshot attempt timed out and a later browser session restart hit a Windows lock/permission error; a fresh named session completed the final checks. Neither was an application error.

## Recreate QR assets locally

From the repository root with Python `qrcode` and Pillow available:

```sh
python -c "import qrcode; from qrcode.image.svg import SvgPathImage; qr=qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,box_size=24,border=4); qr.add_data('https://mammothbroth.com/jar.html'); qr.make(fit=True); qr.make_image(fill_color='#30241f',back_color='#fff8e7').save('assets/jar-qr.png'); qr.make_image(image_factory=SvgPathImage).save('assets/jar-qr.svg')"
node --test tests/jar-qr.test.mjs
```

No commits or deployments were performed.
