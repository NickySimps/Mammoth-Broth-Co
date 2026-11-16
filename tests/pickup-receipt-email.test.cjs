const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderReceiptEmail } = require("../firebase/functions/receipt-email.cjs");

const orderId = "a1".repeat(32);

test("staff lookup copy never invites pickup regardless of the receipt status", () => {
  const statuses = [
    "Your order was canceled. No pickup is confirmed.",
    "Payment received, but fulfillment needs manual review. No pickup is confirmed.",
    "Your order was declined. No payment was collected.",
    "Your order is recorded for pickup and will be ready at the selected market on the date below. Payment is due at pickup; bring your order reference.",
    "Payment received. Thank you.",
  ];
  let firstCard;
  for (const text of statuses) {
    const packet = renderReceiptEmail(text, orderId);
    const card = packet.html.split("<pre")[0];
    assert.match(card, /<h1\b[^>]*>Order lookup for staff<\/h1>/);
    assert.match(card, /Staff sign-in required\./);
    assert.match(card, /This code only helps staff find your order\./);
    assert.match(card, /It does not confirm payment, pickup availability, or fulfillment\./);
    assert.match(card, /Follow the order status below\./);
    assert.doesNotMatch(card, /Show this code at pickup|ready for pickup|pickup is confirmed/i);
    if (firstCard === undefined) firstCard = card;
    assert.equal(card, firstCard, "lookup card must not infer pickup eligibility from receipt text");
    assert.ok(packet.html.includes(text), "original status wording must remain unchanged");
    const locator = `https://mammothbroth.com/staff.html#order=${orderId}`;
    assert.ok(card.includes(`href="${locator}"`));
    assert.ok(card.includes(`src="cid:${packet.attachments[0].cid}"`));
    assert.doesNotMatch(card, /receipt\.html|[?&]token=|checkout\.stripe|api\.qrserver|quickchart/i);
  }
});
