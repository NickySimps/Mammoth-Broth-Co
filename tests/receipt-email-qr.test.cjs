const { test } = require("node:test");
const assert = require("node:assert/strict");
const { base, admin } = require("./commerce-fixture.cjs");
const { load } = require("./commerce-vm-fixture.cjs");

const orderIdFixture = "a1".repeat(32);
const packet = (text, orderId = orderIdFixture, ...ignored) => require("../firebase/functions/receipt-email.cjs").renderReceiptEmail(text, orderId, ...ignored);
const render = (text, orderId = orderIdFixture, ...ignored) => packet(text, orderId, ...ignored).html;

test("pickup QR is the largest near-top image and is a locally generated inline GIF", () => {
  const result = packet("Order reference unchanged. No pickup is confirmed.");
  assert.equal(typeof result.html, "string");
  assert.equal(result.attachments.length, 1);
  const attachment = result.attachments[0];
  assert.ok(Buffer.isBuffer(attachment.content));
  assert.match(attachment.content.subarray(0, 6).toString(), /^GIF8[79]a$/);
  assert.equal(attachment.contentType, "image/gif");
  assert.equal(attachment.contentDisposition, "inline");
  const images = [...result.html.matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
  assert.equal(images.length, 3);
  assert.ok(images[0].includes(`src="cid:${attachment.cid}"`));
  assert.match(images[0], /width="280"/);
  assert.match(images[0], /height="280"/);
  assert.ok(result.html.indexOf(images[0]) < result.html.indexOf("<pre"));
  assert.ok(result.html.includes(`href="https://mammothbroth.com/staff.html#order=${orderIdFixture}"`));
  assert.match(result.html, /Show this code at pickup/);
  assert.match(result.html, /Staff sign-in required\. Scanning does not confirm payment or fulfillment\./);
});

test("renderer rejects malformed IDs rather than creating arbitrary QR destinations", () => {
  for (const id of [undefined, null, {}, [orderIdFixture], "", "a".repeat(63), "a".repeat(65), "A".repeat(64), ` ${orderIdFixture}`, `${orderIdFixture}\n`, "../orders/private", "https://attacker.invalid", `${orderIdFixture}&token=private`]) {
    assert.throws(() => require("../firebase/functions/receipt-email.cjs").renderReceiptEmail("Receipt", id), /Invalid order reference/);
  }
});

test("inline pickup attachment compiles into MIME without network transport", async () => {
  const nodemailer = require("../firebase/functions/node_modules/nodemailer");
  const result = packet("Order reference & status unchanged.");
  const compiled = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" }).sendMail({
    from: "sender@example.invalid", to: "receiver@example.invalid", subject: "Offline receipt fixture",
    text: "Order reference & status unchanged.", ...result,
  });
  const mime = compiled.message.toString();
  assert.match(mime, /Content-Type: multipart\/related;/i);
  assert.match(mime, /Content-Type: image\/gif; name=pickup-order\.gif/i);
  assert.match(mime, /Content-Disposition: inline; filename=pickup-order\.gif/i);
  assert.ok(mime.replace(/\r?\n[ \t]+/g, " ").includes(`Content-ID: <${result.attachments[0].cid}>`));
  const gifPart = mime.split(/Content-Type: image\/gif/i)[1];
  const encoded = gifPart.split(/\r?\n\r?\n/)[1].split(/\r?\n--/)[0].replace(/\s/g, "");
  assert.deepEqual(Buffer.from(encoded, "base64"), result.attachments[0].content);
});

function receiptText(html) {
  const match = html.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(match, "receipt text must have a preformatted block");
  return match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

test("HTML escapes existing receipt text without changing its content or whitespace", () => {
  const text = `Order <script>alert("x")</script> & 'Mammoth'\n  Total: USD 18.00.\r\nNo pickup is confirmed.\n${"long-reference".repeat(30)}`;
  const html = render(text);
  assert.equal(receiptText(html), text);
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;Mammoth&#39;/);
  assert.match(html, /white-space:\s*pre-wrap/);
  assert.match(html, /overflow-wrap:\s*anywhere/);
  assert.match(html, /word-wrap:\s*break-word/);
  assert.match(html, /<table\b[^>]*role="presentation"/);
  assert.match(html, /background-color:\s*#ffffff/i);
});

test("QR cards use only the fixed first-party public destinations and images", () => {
  const privateText = "Order private-order-id for customer@example.invalid. Pay: https://checkout.stripe.com/private-payment\nReceipt: https://mammothbroth.com/receipt.html#order=private-order-id&token=private-capability";
  const html = render(privateText, orderIdFixture, {
    shopUrl: "https://attacker.invalid/qr?email=customer@example.invalid",
    jarUrl: "https://attacker.invalid/private-order-id",
  });
  assert.equal(receiptText(html), privateText);
  assert.deepEqual([...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]), [
    `https://mammothbroth.com/staff.html#order=${orderIdFixture}`,
    "https://mammothbroth.com/shop.html#products-section",
    "https://mammothbroth.com/jar.html",
  ]);
  const images = [...html.matchAll(/<img\b[^>]*>/g)].map(match => match[0]).slice(1);
  assert.equal(images.length, 2);
  for (const [index, name] of ["shop", "jar"].entries()) {
    assert.match(images[index], new RegExp(`src="https://mammothbroth\\.com/assets/qr/${name}\\.png"`));
    assert.match(images[index], /width="120"/);
    assert.match(images[index], /height="120"/);
    assert.ok(html.indexOf(images[index]) > html.indexOf("</pre>"));
    assert.match(images[index], /alt="[^"]*(?:reorder|jar help)[^"]*"/i);
    assert.match(images[index], /background-color:\s*#ffffff/i);
  }
  assert.doesNotMatch(html, /attacker\.invalid|api\.qrserver|quickchart|chart\.google|data:image/i);
  assert.match(html, /public pages/i);
});

test("real commerce entrypoint adds HTML for both recipients without changing any status/reference text", async (t) => {
  const name = 'MB-REFERENCE-123 <&"\'>';
  const checkout = "https://checkout.stripe.com/c/private-payment";
  const cases = [
    [{ status: "paid_requires_review", checkoutUrl: checkout }, `Payment received for ${name}, but fulfillment needs manual review. No pickup is confirmed. The owner must arrange fulfillment or a refund; please contact us.`],
    [{ status: "paid", checkoutUrl: checkout }, `Payment received for ${name}. Total: USD 25.00. Thank you.`],
    [{ status: "awaiting_payment", fulfillmentMethod: "special_order", checkoutSessionId: "cs_fixture", checkoutUrl: checkout }, `Your special order ${name} is approved. Pay securely: ${checkout}\nTotal: USD 25.00. Approval is not payment.`],
    [{ status: "declined", fulfillmentMethod: "special_order" }, `Your special order ${name} was declined. No payment was collected.`],
    [{ status: "awaiting_approval", fulfillmentMethod: "special_order" }, `Your special-order request ${name} was received and awaits owner approval. No payment has been collected.`],
    [{ status: "unknown", fulfillmentMethod: "special_order" }, `Your special-order request ${name} is pending owner follow-up. No pickup is confirmed.`],
    [{ status: "preorder" }, `Your pickup preorder ${name} was received. Payment is due at pickup.`],
  ];
  for (const [patch, expected] of cases) {
    await t.test(patch.status, async () => {
      const f = load(); // Existing harness stubs SMTP, Stripe, and Firestore: no real sends.
      const { orderId } = await f.handlers.createPreorder({ ...base, paymentMethod: "pickup" });
      const order = f.records.get(`orders/${orderId}`);
      Object.assign(order, { orderName: name, ...patch });
      await f.handlers.retryOrderEmail({ orderId }, admin);
      assert.equal(f.mails.length, 2);
      for (const message of f.mails) {
        assert.equal(message.text, expected);
        assert.equal(typeof message.html, "string", "actual SMTP payload must include HTML");
        assert.equal(receiptText(message.html), expected);
        assert.equal(message.html, render(expected, orderId));
        assert.deepEqual(message.attachments, packet(expected, orderId).attachments);
        assert.equal(message.cc, undefined);
        assert.equal(message.bcc, undefined);
      }
      assert.equal(f.mails[0].to.address, base.customerEmail);
      assert.equal(f.mails[1].to, "ops@example.com");
      assert.equal(f.mails[0].subject, `Mammoth order ${name}`);
      assert.equal(f.mails[1].subject, `Mammoth operations — Mammoth order ${name}`);
      assert.equal(order.emailVersion, 1);
      const saved = f.records.get(`orders/${orderId}`);
      assert.equal(saved.emailCustomerSentVersion, 1);
      assert.equal(saved.emailOperationsSentVersion, 1);
      assert.equal(saved.emailSentVersion, 1);
      await f.handlers.retryOrderEmail({ orderId }, admin);
      assert.equal(f.mails.length, 2, "completed recipients must not be resent");
    });
  }
});

test("disabled email entrypoint remains disabled and never reaches SMTP", async () => {
  const f = load(false);
  const { orderId } = await f.handlers.createPreorder({ ...base, paymentMethod: "pickup" });
  assert.equal(await f.handlers.sendOrderConfirmationEmail({}, { params: { orderId } }), null);
  await assert.rejects(f.handlers.retryOrderEmail({ orderId }, admin), error => error.code === "unavailable");
  assert.equal(f.mails.length, 0);
  assert.equal(f.records.get(`orders/${orderId}`).emailSentVersion, 0);
});
