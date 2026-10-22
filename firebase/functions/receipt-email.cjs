"use strict";

const qrcode = require("qrcode-generator");

// Accept copy and an internal reference, never a caller-supplied destination.
function renderReceiptEmail(text, orderId) {
  if (typeof orderId !== "string" || !/^[a-f0-9]{64}$/.test(orderId)) {
    throw new TypeError("Invalid order reference.");
  }
  const staffUrl = `https://mammothbroth.com/staff.html#order=${orderId}`;
  const qr = qrcode(0, "M");
  qr.addData(staffUrl, "Byte");
  qr.make();
  // createDataURL(cellSize, margin) uses pixel units. Keep a four-module
  // quiet zone and integer module pixels in the locally generated GIF.
  const content = Buffer.from(qr.createDataURL(4, 16).split(",")[1], "base64");
  const cid = `pickup-order-${orderId}@mammothbroth.com`;
  const escaped = text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mammoth order</title></head>
<body style="margin:0;padding:16px;background-color:#ffffff;color:#222222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#ffffff;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;table-layout:fixed;">
<tr><td align="center" style="padding:16px;font-family:Arial,sans-serif;background-color:#ffffff;">
<h1 style="font-size:22px;line-height:1.3;">Show this code at pickup</h1>
<a href="${staffUrl}" style="color:#222222;"><img src="cid:${cid}" alt="Staff order lookup QR code" width="280" height="280" style="display:block;width:280px;height:280px;max-width:100%;border:0;background-color:#ffffff;"><br>Open this order for staff</a>
<p style="font-size:14px;line-height:1.5;">Staff sign-in required. Scanning does not confirm payment or fulfillment.</p>
</td></tr>
<tr><td style="padding:16px;font-family:Arial,sans-serif;">
<pre style="margin:0;font-family:Arial,sans-serif;font-size:16px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;word-wrap:break-word;">${escaped}</pre>
</td></tr>
<tr><td style="padding:16px;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;">
<p>These QR codes open public pages only, not your private receipt or payment details.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#ffffff;">
<tr><td align="center" style="padding:16px;background-color:#ffffff;">
<a href="https://mammothbroth.com/shop.html#products-section" style="color:#222222;">Reorder from our shop<br>
<img src="https://mammothbroth.com/assets/qr/shop.png" alt="QR code to reorder from the public Mammoth Broth shop" width="120" height="120" style="display:block;width:120px;height:120px;border:0;background-color:#ffffff;"></a>
</td></tr>
<tr><td align="center" style="padding:16px;background-color:#ffffff;">
<a href="https://mammothbroth.com/jar.html" style="color:#222222;">Jar help<br>
<img src="https://mammothbroth.com/assets/qr/jar.png" alt="QR code for public Mammoth Broth jar help" width="120" height="120" style="display:block;width:120px;height:120px;border:0;background-color:#ffffff;"></a>
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  return {
    html,
    attachments: [{
      filename: "pickup-order.gif", content, cid,
      contentType: "image/gif", contentDisposition: "inline",
    }],
  };
}

module.exports = { renderReceiptEmail };
