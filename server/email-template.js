function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function text(value, fallback = '') {
  return escapeHtml(value || fallback);
}

function confirmationEmail(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemRows = items.length ? items.map(item => `<tr><td style="padding:15px 0;border-bottom:1px solid #e5d7bc;color:#382b24;font-size:15px"><strong>${text(item.quantity, '1')} × ${text(item.name, 'Mammoth broth')}</strong>${item.description ? `<br><span style="font-size:12px;color:#766653">${text(item.description)}</span>` : ''}</td><td style="padding:15px 0;border-bottom:1px solid #e5d7bc;text-align:right;color:#382b24;font-size:15px;white-space:nowrap">${money(item.itemTotal)}</td></tr>`).join('') : '<tr><td style="padding:15px 0;color:#766653">Your preorder details are available in your account.</td><td></td></tr>';
  const subtotal = order.subtotal ?? order.totalAmount;
  const discount = Number(order.discountAmount || 0);
  const paymentLabel = order.paymentMethod === 'stripe' || order.status === 'paid' ? 'Paid online' : 'Pay at pickup';
  const statusLabel = order.status === 'paid' ? 'Payment received' : order.status === 'confirmed' ? 'Confirmed' : 'Reserved';
  const pickupAddress = order.marketAddress || order.address;
  const pickupTime = order.pickupWindow || order.time;
  const pickupDetails = [order.pickupDate || 'Next available market', pickupTime, pickupAddress].filter(Boolean).map(detail => `<div style="margin:6px 0">${text(detail)}</div>`).join('');
  const preheader = `Your Mammoth preorder ${order.orderName || ''} is ${statusLabel.toLowerCase()}.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(preheader)}</title></head>
<body style="margin:0;background:#efe3cd;color:#382b24;font-family:Georgia,'Times New Roman',serif;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${text(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#efe3cd"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fffaf0;border:1px solid #d5bd93;box-shadow:0 8px 30px rgba(60,40,20,.12)">
<tr><td style="padding:32px 34px;background:#2f251e;color:#fff7e6;border-bottom:5px solid #b55431"><div style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:3px;color:#f0b05e;font-weight:bold">MAMMOTH BROTH CO.</div><h1 style="margin:17px 0 6px;font-size:34px;line-height:1.08;font-weight:normal;color:#fff7e6">Your broth is reserved.</h1><p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#eadfca">Small-batch nourishment, held fresh for your next market pickup.</p></td></tr>
<tr><td style="padding:32px 34px 10px"><p style="margin:0 0 14px;font-size:18px;line-height:1.5">Hi ${text(order.customerName, 'there')},</p><p style="margin:0;font-size:16px;line-height:1.65;color:#59483a">Thanks for supporting our little broth operation. Your preorder is safely on the ledger and we’ll have it ready when you arrive.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:26px 0;background:#f5ead7;border:1px solid #dfcda9"><tr><td style="padding:22px"><div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;color:#a3482d;font-weight:bold">${text(statusLabel).toUpperCase()}</div><h2 style="margin:9px 0 5px;font-size:24px;font-weight:normal;color:#382b24">${text(order.orderName, 'Mammoth preorder')}</h2><p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#766653">Keep this order name handy at pickup.</p></td></tr></table>
<h2 style="margin:20px 0 8px;font-size:21px;font-weight:normal;color:#382b24">Pickup details</h2><div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#59483a;padding:15px 0;border-top:1px solid #dfcda9;border-bottom:1px solid #dfcda9"><strong>${text(order.marketName, 'Your selected farmers market')}</strong>${pickupDetails}</div>
<h2 style="margin:26px 0 8px;font-size:21px;font-weight:normal;color:#382b24">Your order</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${itemRows}</table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:15px;font-family:Arial,sans-serif;font-size:14px;color:#59483a"><tr><td style="padding:4px 0">Subtotal</td><td align="right">${money(subtotal)}</td></tr>${discount > 0 ? `<tr><td style="padding:4px 0;color:#9a472c">Bundle savings</td><td align="right" style="color:#9a472c">−${money(discount)}</td></tr>` : ''}<tr><td style="padding:13px 0 4px;border-top:1px solid #cdb98f;font-size:17px;color:#382b24"><strong>Total</strong></td><td align="right" style="padding:13px 0 4px;border-top:1px solid #cdb98f;font-size:17px;color:#382b24"><strong>${money(order.totalAmount)}</strong></td></tr></table>
<div style="margin:25px 0;padding:17px;background:#2f251e;color:#fff7e6;font-family:Arial,sans-serif;font-size:14px;line-height:1.6"><strong style="color:#f0b05e">Payment:</strong> ${text(paymentLabel)}<br><strong style="color:#f0b05e">Order status:</strong> ${text(statusLabel)}</div>
<h2 style="margin:24px 0 8px;font-size:21px;font-weight:normal;color:#382b24">A few good things to know</h2><ul style="margin:0;padding-left:20px;color:#59483a;font-family:Arial,sans-serif;font-size:14px;line-height:1.7"><li>Bring your order name when you arrive.</li><li>Keep your broth refrigerated or frozen when you get home.</li><li>After thawing, enjoy within 7 days.</li><li>Questions or changes? Reply to this email or reach us at <a href="mailto:hello@mammothbroth.com" style="color:#a3482d">hello@mammothbroth.com</a>.</li></ul>
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0 10px"><tr><td style="background:#b55431;border-radius:4px"><a href="https://mammothbroth.com/account.html" style="display:inline-block;padding:15px 22px;color:#fffaf0;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold">View your order ledger</a></td><td style="padding-left:10px"><a href="https://mammothbroth.com/shop.html" style="display:inline-block;padding:14px 18px;border:1px solid #b55431;border-radius:4px;color:#9a472c;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold">Shop the next batch</a></td></tr></table></td></tr>
<tr><td style="padding:24px 34px;background:#f5ead7;border-top:1px solid #dfcda9;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#766653">Made in small batches by Mammoth Broth Co.<br><a href="https://instagram.com/mammothbrothco" style="color:#9a472c">Follow the fire @mammothbrothco</a><br><span>This message confirms your preorder; it is not a shipping notice.</span></td></tr>
</table></td></tr></table></body></html>`;
}

function confirmationText(order) {
  const items = (order.items || []).map(item => `- ${item.quantity} × ${item.name}: ${money(item.itemTotal)}`).join('\n');
  const paymentLabel = order.paymentMethod === 'stripe' || order.status === 'paid' ? 'Paid online' : 'Pay at pickup';
  return `MAMMOTH BROTH CO.\n\nYour broth is reserved.\n\nHi ${order.customerName || 'there'},\n\nThanks for supporting our little broth operation.\n\nORDER: ${order.orderName || 'Mammoth preorder'}\nSTATUS: ${order.status || 'Reserved'}\n\nPICKUP\n${order.marketName || 'Your selected farmers market'}\n${order.pickupDate || 'Next available market'}${order.pickupWindow ? `\n${order.pickupWindow}` : ''}${order.marketAddress ? `\n${order.marketAddress}` : ''}\n\nYOUR ORDER\n${items || 'Details are available in your account.'}\n\nSubtotal: ${money(order.subtotal ?? order.totalAmount)}\n${Number(order.discountAmount || 0) > 0 ? `Bundle savings: -${money(order.discountAmount)}\n` : ''}Total: ${money(order.totalAmount)}\nPayment: ${paymentLabel}\n\nBring your order name to pickup. Keep broth refrigerated or frozen, and enjoy within 7 days after thawing. Questions? Reply to this email or contact hello@mammothbroth.com.\n\nView your order: https://mammothbroth.com/account.html`;
}

module.exports = { confirmationEmail, confirmationText };
