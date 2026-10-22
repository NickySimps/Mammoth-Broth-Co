"use strict";

// This renderer accepts receipt copy only, never destinations or order data.
function renderReceiptEmail(text) {
  const escaped = text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mammoth order</title></head>
<body style="margin:0;padding:16px;background-color:#ffffff;color:#222222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#ffffff;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;table-layout:fixed;">
<tr><td style="padding:16px;font-family:Arial,sans-serif;">
<pre style="margin:0;font-family:Arial,sans-serif;font-size:16px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;word-wrap:break-word;">${escaped}</pre>
</td></tr>
<tr><td style="padding:16px;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;">
<p>These QR codes open public pages only, not your private receipt or payment details.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#ffffff;">
<tr><td align="center" style="padding:16px;background-color:#ffffff;">
<a href="https://mammothbroth.com/shop.html#products-section" style="color:#222222;">Reorder from our shop<br>
<img src="https://mammothbroth.com/assets/qr/shop.png" alt="QR code to reorder from the public Mammoth Broth shop" width="160" height="160" style="display:block;width:160px;height:160px;border:0;background-color:#ffffff;"></a>
</td></tr>
<tr><td align="center" style="padding:16px;background-color:#ffffff;">
<a href="https://mammothbroth.com/jar.html" style="color:#222222;">Jar help<br>
<img src="https://mammothbroth.com/assets/qr/jar.png" alt="QR code for public Mammoth Broth jar help" width="160" height="160" style="display:block;width:160px;height:160px;border:0;background-color:#ffffff;"></a>
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

module.exports = { renderReceiptEmail };
