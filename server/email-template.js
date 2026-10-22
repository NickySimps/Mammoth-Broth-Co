function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function text(value, fallback = '') {
  return escapeHtml(value || fallback);
}

function orderUrl(order) {
  const reference = order.orderId || order.firestoreId || order.orderName;
  return `https://mammothbroth.com/thank-you.html?order=${encodeURIComponent(reference || 'pending')}`;
}

function qrImageUrl(url) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=12&color=48-43-36&bgcolor=255-250-240&data=${encodeURIComponent(url)}`;
}

function displayDetails(order) {
  const special = order.fulfillmentMethod === 'special_order' || order.paymentMethod === 'special_order';
  const delivery = !special && order.fulfillmentMethod === 'local_delivery';
  const status = special && (!order.status || order.status === 'pending') ? 'awaiting_approval' : order.status;
  const statusLabel = ({ pending: 'Reserved', awaiting_approval: 'Awaiting approval', payment_processing: 'Payment processing', paid: 'Payment received', confirmed: 'Confirmed', ready_for_pickup: 'Ready for pickup', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded' })[status] || 'Status unavailable';
  const paymentLabel = status === 'refunded' ? 'Refunded' : special ? 'Payment not confirmed; terms after approval' : status === 'paid' ? 'Paid online' : status === 'payment_processing' ? 'Payment processing' : status === 'cancelled' ? 'Order cancelled' : order.paymentMethod === 'pickup' ? 'Pay at pickup' : 'Payment pending';
  const address = order.deliveryAddress || {};
  return {
    statusLabel, paymentLabel,
    heading: special ? 'Your special request is on the ledger.' : 'Your order is on the ledger.',
    subtitle: special ? 'Special requests require approval before fulfillment.' : delivery ? 'Small-batch nourishment, with local delivery selected.' : 'Small-batch nourishment, with market pickup selected.',
    note: special ? 'Items are not reserved. Availability, fulfillment and payment terms must be confirmed after review.' : 'Check your order status and fulfillment details below for the latest information.',
    fulfillmentLabel: special ? 'Special request details' : delivery ? 'Local delivery details' : 'Pickup details',
    location: special ? 'Awaiting review' : delivery ? 'Local delivery' : order.marketName || 'Your selected farmers market',
    details: special ? [order.specialNotes || 'We will contact you to discuss your request.'] : delivery ? [[address.street, address.city, address.state, address.zip].filter(Boolean).join(', ') || 'Delivery address pending', 'Delivery timing will be confirmed.'] : [order.pickupDate || 'Next available market', order.pickupWindow || order.time, order.marketAddress || order.address].filter(Boolean),
    reminder: special ? 'Keep your order name handy when discussing your request.' : delivery ? 'Keep your order name handy for delivery questions.' : 'Keep this order name handy at pickup.',
    footer: special ? 'This message acknowledges your request only; it does not guarantee stock, fulfillment or payment.' : 'This message records your current order status; it is not a shipping notice.'
  };
}

function confirmationEmail(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemRows = items.length ? items.map(item => `<tr><td style="padding:15px 0;border-bottom:1px solid #e5d7bc;color:#382b24;font-size:15px"><strong>${text(item.quantity, '1')} × ${text(item.name, 'Mammoth broth')}</strong>${item.description ? `<br><span style="font-size:12px;color:#766653">${text(item.description)}</span>` : ''}</td><td style="padding:15px 0;border-bottom:1px solid #e5d7bc;text-align:right;color:#382b24;font-size:15px;white-space:nowrap">${money(item.itemTotal)}</td></tr>`).join('') : '<tr><td style="padding:15px 0;color:#766653">Your preorder details are available in your account.</td><td></td></tr>';
  const subtotal = order.subtotal ?? order.totalAmount;
  const discount = Number(order.discountAmount || 0);
  const display = displayDetails(order);
  const { paymentLabel, statusLabel } = display;
  const fulfillmentDetails = display.details.map(detail => `<div style="margin:6px 0">${text(detail)}</div>`).join('');
  const orderLink = orderUrl(order);
  const qrUrl = qrImageUrl(orderLink);
  const preheader = `Your Mammoth preorder ${order.orderName || ''} is ${statusLabel.toLowerCase()}.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(preheader)}</title></head>
<body style="margin:0;background:#efe3cd;color:#382b24;font-family:Georgia,'Times New Roman',serif;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${text(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#efe3cd"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fffaf0;border:1px solid #d5bd93;box-shadow:0 8px 30px rgba(60,40,20,.12)">
<tr><td style="padding:32px 34px;background:#2f251e;color:#fff7e6;border-bottom:5px solid #b55431"><div style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:3px;color:#f0b05e;font-weight:bold">MAMMOTH BROTH CO.</div><h1 style="margin:17px 0 6px;font-size:34px;line-height:1.08;font-weight:normal;color:#fff7e6">${text(display.heading)}</h1><p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#eadfca">${text(display.subtitle)}</p></td></tr>
<tr><td style="padding:32px 34px 10px"><p style="margin:0 0 14px;font-size:18px;line-height:1.5">Hi ${text(order.customerName, 'there')},</p><p style="margin:0;font-size:16px;line-height:1.65;color:#59483a">Thanks for supporting our little broth operation. ${text(display.note)}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:26px 0;background:#f5ead7;border:1px solid #dfcda9"><tr><td style="padding:22px"><div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;color:#a3482d;font-weight:bold">${text(statusLabel).toUpperCase()}</div><h2 style="margin:9px 0 5px;font-size:24px;font-weight:normal;color:#382b24">${text(order.orderName, 'Mammoth preorder')}</h2><p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#766653">${text(display.reminder)}</p></td></tr></table>
<h2 style="margin:20px 0 8px;font-size:21px;font-weight:normal;color:#382b24">${text(display.fulfillmentLabel)}</h2><div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#59483a;padding:15px 0;border-top:1px solid #dfcda9;border-bottom:1px solid #dfcda9"><strong>${text(display.location)}</strong>${fulfillmentDetails}</div>
<h2 style="margin:26px 0 8px;font-size:21px;font-weight:normal;color:#382b24">Your order</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${itemRows}</table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:15px;font-family:Arial,sans-serif;font-size:14px;color:#59483a"><tr><td style="padding:4px 0">Subtotal</td><td align="right">${money(subtotal)}</td></tr>${discount > 0 ? `<tr><td style="padding:4px 0;color:#9a472c">Bundle savings</td><td align="right" style="color:#9a472c">−${money(discount)}</td></tr>` : ''}<tr><td style="padding:13px 0 4px;border-top:1px solid #cdb98f;font-size:17px;color:#382b24"><strong>Total</strong></td><td align="right" style="padding:13px 0 4px;border-top:1px solid #cdb98f;font-size:17px;color:#382b24"><strong>${money(order.totalAmount)}</strong></td></tr></table>
<div style="margin:25px 0;padding:17px;background:#2f251e;color:#fff7e6;font-family:Arial,sans-serif;font-size:14px;line-height:1.6"><strong style="color:#f0b05e">Payment:</strong> ${text(paymentLabel)}<br><strong style="color:#f0b05e">Order status:</strong> ${text(statusLabel)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:26px 0;background:#f5ead7;border:1px solid #dfcda9"><tr><td align="center" style="padding:20px"><img src="${qrUrl}" width="180" height="180" alt="QR code linking to order ${text(order.orderName, 'details')}" style="display:block;width:180px;height:180px;margin:0 auto 14px;border:8px solid #fffaf0"><h2 style="margin:0 0 7px;font-size:19px;font-weight:normal;color:#382b24">Open your order details</h2><p style="margin:0;font-family:Arial,sans-serif;font-size:13px;line-height:1.5;color:#59483a">Scan the code to open your order details and check the current status.</p><p style="margin:12px 0 0;font-family:Arial,sans-serif;font-size:12px;word-break:break-all"><a href="${orderLink}" style="color:#a3482d">Open order link</a></p></td></tr></table>
<h2 style="margin:24px 0 8px;font-size:21px;font-weight:normal;color:#382b24">A few good things to know</h2><ul style="margin:0;padding-left:20px;color:#59483a;font-family:Arial,sans-serif;font-size:14px;line-height:1.7"><li>${text(display.reminder)}</li><li>Keep your broth refrigerated or frozen when you get home.</li><li>After thawing, enjoy within 7 days.</li><li>Questions or changes? Reply to this email or reach us at <a href="mailto:hello@mammothbroth.com" style="color:#a3482d">hello@mammothbroth.com</a>.</li></ul>
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0 10px"><tr><td style="background:#b55431;border-radius:4px"><a href="https://mammothbroth.com/account.html" style="display:inline-block;padding:15px 22px;color:#fffaf0;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold">View your order ledger</a></td><td style="padding-left:10px"><a href="https://mammothbroth.com/shop.html" style="display:inline-block;padding:14px 18px;border:1px solid #b55431;border-radius:4px;color:#9a472c;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold">Shop the next batch</a></td></tr></table></td></tr>
<tr><td style="padding:24px 34px;background:#f5ead7;border-top:1px solid #dfcda9;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#766653">Made in small batches by Mammoth Broth Co.<br><a href="https://instagram.com/mammothbrothco" style="color:#9a472c">Follow the fire @mammothbrothco</a><br><span>${text(display.footer)}</span></td></tr>
</table></td></tr></table></body></html>`;
}

function confirmationText(order) {
  const items = (order.items || []).map(item => `- ${item.quantity} × ${item.name}: ${money(item.itemTotal)}`).join('\n');
  const display = displayDetails(order);
  return `MAMMOTH BROTH CO.\n\n${display.heading}\n${display.subtitle}\n\nHi ${order.customerName || 'there'},\n\nThanks for supporting our little broth operation. ${display.note}\n\nORDER: ${order.orderName || 'Mammoth preorder'}\nSTATUS: ${display.statusLabel}\n\n${display.fulfillmentLabel.toUpperCase()}\n${display.location}\n${display.details.join('\n')}\n\nYOUR ORDER\n${items || 'Details are available in your account.'}\n\nSubtotal: ${money(order.subtotal ?? order.totalAmount)}\n${Number(order.discountAmount || 0) > 0 ? `Bundle savings: -${money(order.discountAmount)}\n` : ''}Total: ${money(order.totalAmount)}\nPayment: ${display.paymentLabel}\n\nORDER DETAILS\nOpen this order: ${orderUrl(order)}\n\n${display.reminder} Keep broth refrigerated or frozen, and enjoy within 7 days after thawing. Questions? Reply to this email or contact hello@mammothbroth.com.\n\n${display.footer}\n\nView your order ledger: https://mammothbroth.com/account.html`;
}

module.exports = { confirmationEmail, confirmationText };
