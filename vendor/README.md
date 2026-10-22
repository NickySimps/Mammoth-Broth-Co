# Vendored QR generator

Upstream: kazuhikoarase/qrcode-generator, pinned tag `js2.0.4` (MIT).
Downloaded unmodified from these upstream files:

- `https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/js2.0.4/js/dist/qrcode.mjs`
  → `qrcode-generator.mjs`
  SHA-256: `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`
- `https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/js2.0.4/LICENSE`
  → `qrcode-generator.LICENSE`
  SHA-256: `3a850fa5f08101db6f40676c2786e10bd2cd5fff7b12ffdf1e0c434d4e49d90c`

`receipt-order-qr.mjs` consumes only the local matrix-generation API and
creates SVG elements directly. It does not use upstream HTML/image helpers,
remote QR services, data URLs, or `innerHTML`.
