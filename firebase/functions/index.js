"use strict";
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const createCommerce = require("./commerce.cjs");
admin.initializeApp();

// Disabled by default. Enable only AFTER provisioning bound Secret Manager versions.
const paymentsEnabled = process.env.COMMERCE_PAYMENTS_ENABLED === "true";
const emailEnabled = process.env.COMMERCE_EMAIL_ENABLED === "true";
const paymentSecrets = paymentsEnabled ? ["STRIPE_SECRET"] : [];
const mailSecrets = emailEnabled ? ["GMAIL_PASS"] : [];
let stripeClient;
function getStripe() {
  if (!paymentsEnabled || !process.env.STRIPE_SECRET)
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Card payments are disabled or not configured. Choose pickup payment.",
    );
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET);
  return stripeClient;
}
const commerce = createCommerce({
  db: admin.firestore(),
  HttpsError: functions.https.HttpsError,
  origin: process.env.COMMERCE_ORIGIN,
  stripe: {
    paymentIntents: {
      create: (...args) => getStripe().paymentIntents.create(...args),
    },
    checkout: {
      sessions: {
        create: (...args) => getStripe().checkout.sessions.create(...args),
      },
    },
  },
  // Exactly one SMTP recipient per call; commerce owns durable per-recipient checkpoints.
  sendEmail: async ({ recipient, ...message }) => {
    if (!emailEnabled || !process.env.GMAIL_EMAIL || !process.env.GMAIL_PASS)
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Email delivery is not configured.",
      );
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_LOGIN_USER || process.env.GMAIL_EMAIL,
        pass: process.env.GMAIL_PASS,
      },
    });
    const from = `Mammoth Broth Co. <${process.env.GMAIL_EMAIL}>`;
    if (!["customer", "operations"].includes(recipient))
      throw new functions.https.HttpsError("failed-precondition", "Invalid email recipient role.");
    // Separate messages, never CC. Do not chain customer and operations in one call:
    // an operations failure must not erase knowledge of customer acceptance.
    return transporter.sendMail({
      ...message,
      from,
      ...(recipient === "operations" ? {
        to: process.env.GMAIL_EMAIL,
        subject: `Mammoth operations — ${message.subject}`,
      } : {}),
    });
  },
});
const callable = (handler, secrets = [], enforceAppCheck = false) =>
  functions
    .runWith({ secrets, timeoutSeconds: 60, enforceAppCheck })
    .https.onCall(async (data, context) => handler(data, context));
exports.createPaymentIntent = callable((data, context) => {
  getStripe();
  return commerce.createPaymentIntent(data, context);
}, paymentSecrets, true);
exports.createPreorder = callable(commerce.createPreorder, [], true);
exports.getGuestReceipt = callable(commerce.getGuestReceipt);
exports.getDeliveryQuote = callable(commerce.getDeliveryQuote);
exports.revokeGuestReceipt = callable(commerce.revokeGuestReceipt);
exports.reviewSpecialOrder = callable(
  (data, context) => {
    if (context?.auth?.token?.admin !== true)
      throw new functions.https.HttpsError(
        "permission-denied",
        "Owner admin claim required.",
      );
    if (data?.decision === "approve") getStripe();
    return commerce.reviewSpecialOrder(data, context);
  },
  [...paymentSecrets, ...mailSecrets],
);
exports.resumePaymentSetup = callable(
  (data, context) => {
    if (context?.auth?.token?.admin !== true)
      throw new functions.https.HttpsError(
        "permission-denied", "Owner admin claim required.",
      );
    getStripe();
    return commerce.resumePaymentSetup(data, context);
  },
  [...paymentSecrets, ...mailSecrets],
);
exports.retryOrderEmail = callable(commerce.retryOrderEmail, mailSecrets);
exports.stripeWebhook = functions
  .runWith({
    secrets: paymentsEnabled ? ["STRIPE_SECRET", "STRIPE_WEBHOOK_SECRET"] : [],
    timeoutSeconds: 60,
  })
  .https.onRequest(async (request, response) => {
    if (request.method !== "POST")
      return response.status(405).send("POST required");
    if (
      !paymentsEnabled ||
      !process.env.STRIPE_WEBHOOK_SECRET ||
      !process.env.STRIPE_SECRET
    )
      return response.status(503).send("Payments unavailable");
    let event;
    try {
      if (
        !Buffer.isBuffer(request.rawBody) ||
        typeof request.headers["stripe-signature"] !== "string"
      )
        return response.status(400).send("Invalid signature");
      event = getStripe().webhooks.constructEvent(
        request.rawBody,
        request.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      return response.status(400).send("Invalid signature");
    }
    try {
      return response
        .status(200)
        .json(await commerce.processStripeEvent(event));
    } catch (error) {
      // Never log Stripe payloads, customer data, credentials or receipt capabilities.
      return response
        .status(
          ["invalid-argument", "failed-precondition"].includes(error.code)
            ? 400
            : 500,
        )
        .send("Payment event not accepted");
    }
  });
const emailTrigger = () =>
  functions
    .runWith({ secrets: mailSecrets, failurePolicy: true, timeoutSeconds: 60 })
    .firestore.document("orders/{orderId}");
exports.sendOrderConfirmationEmail = emailTrigger().onCreate(
  (snapshot, context) => {
    if (!emailEnabled) return null;
    return commerce.deliverOrderEmail({ orderId: context.params.orderId });
  },
);
exports.sendOrderEmailOnUpdate = emailTrigger().onUpdate((change, context) => {
  if (
    !emailEnabled ||
    change.before.data().emailVersion === change.after.data().emailVersion
  )
    return null;
  return commerce.deliverOrderEmail({ orderId: context.params.orderId });
});
