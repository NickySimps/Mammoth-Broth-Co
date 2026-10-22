"use strict";
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const { renderReceiptEmail } = require("./receipt-email.cjs");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
module.exports = function commerce({
  db,
  stripe,
  HttpsError,
  now = Date.now,
  origin,
  sendEmail,
}) {
  const error = (code, message) => {
    throw new HttpsError(code, message);
  };
  const ref = (collection, id) => db.collection(collection).doc(id);
  function cartEntries(cart) {
    if (
      !cart ||
      typeof cart !== "object" ||
      Array.isArray(cart) ||
      !Object.keys(cart).length
    )
      error("invalid-argument", "Cart required.");
    const entries = Object.entries(cart).sort(([a], [b]) => a.localeCompare(b));
    if (
      entries.some(
        ([id, q]) =>
          !/^[-\w]{1,100}$/.test(id) || !Number.isSafeInteger(q) || q < 1,
      ) ||
      entries.reduce((s, [, q]) => s + q, 0) > 12
    )
      error(
        "invalid-argument",
        "Product quantities must be positive whole numbers, maximum 12.",
      );
    return entries;
  }
  // Deliberately accepts a bare ASCII mailbox, never an RFC address list/display name.
  function isMailbox(value) {
    return typeof value === "string" &&
      /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
  }
  function normalize(data, context) {
    if (!data || typeof data !== "object" || Array.isArray(data))
      error("invalid-argument", "Order object required.");
    const entries = cartEntries(data.cart);
    if (!/^[-\w]{16,128}$/.test(data.requestId || ""))
      error(
        "invalid-argument",
        "A requestId of 16–128 characters is required.",
      );
    if (
      typeof data.customerName !== "string" ||
      !data.customerName.trim() ||
      data.customerName.length > 120 ||
      typeof data.customerEmail !== "string" ||
      data.customerEmail.length > 200 ||
      !isMailbox(data.customerEmail)
    )
      error("invalid-argument", "Valid customer name and email required.");
    const fulfillmentMethod = data.fulfillmentMethod;
    if (
      !["market_pickup", "special_order", "local_delivery"].includes(
        fulfillmentMethod,
      )
    )
      error("invalid-argument", "Unsupported fulfillment method.");
    if (
      fulfillmentMethod === "market_pickup" &&
      (!/^[-\w]{1,100}$/.test(data.marketId || "") ||
        !/^\d{4}-\d{2}-\d{2}$/.test(data.pickupDate || "") ||
        !Number.isFinite(Date.parse(data.pickupDate + "T00:00:00Z")))
    )
      error(
        "invalid-argument",
        "Valid future pickup date and market required.",
      );
    if (
      fulfillmentMethod === "market_pickup" &&
      new Date(data.pickupDate + "T00:00:00Z").toISOString().slice(0, 10) !==
        data.pickupDate
    )
      error("invalid-argument", "Invalid pickup calendar date.");
    if (
      fulfillmentMethod === "special_order" &&
      (typeof data.specialNotes !== "string" ||
        data.specialNotes.trim().length < 10 ||
        data.specialNotes.length > 2000)
    )
      error(
        "invalid-argument",
        "Special order notes require 10–2000 characters.",
      );
    return {
      requestId: data.requestId,
      cart: Object.fromEntries(entries),
      customerName: data.customerName.trim(),
      customerEmail: data.customerEmail.trim().toLowerCase(),
      customerUid: context.auth?.uid || null,
      fulfillmentMethod,
      marketId: fulfillmentMethod === "market_pickup" ? data.marketId : null,
      pickupDate:
        fulfillmentMethod === "market_pickup" ? data.pickupDate : null,
      specialNotes:
        fulfillmentMethod === "special_order" ? data.specialNotes.trim() : "",
      deliveryAddress:
        fulfillmentMethod === "local_delivery"
          ? addressFields(data.deliveryAddress)
          : null,
    };
  }
  function addressFields(address) {
    if (
      !address ||
      ["street", "city", "state", "zip"].some(
        (k) =>
          typeof address[k] !== "string" ||
          !address[k].trim() ||
          address[k].length > 200,
      )
    )
      error("invalid-argument", "Complete delivery address required.");
    return Object.fromEntries(
      ["street", "city", "state", "zip"].map((k) => [k, address[k].trim()]),
    );
  }
  async function deliveryPolicy(tx, input) {
    const policy = (await tx.get(ref("settings", "delivery"))).data();
    if (
      !policy ||
      policy.enabled !== true ||
      !Array.isArray(policy.allowedZips) ||
      !policy.allowedZips.length ||
      policy.allowedZips.some(
        (z) => typeof z !== "string" || !/^\d{5}$/.test(z),
      ) ||
      !/^[A-Z]{2}$/.test(policy.state || "") ||
      !Number.isSafeInteger(policy.feeCents) ||
      policy.feeCents < 0 ||
      !Number.isSafeInteger(policy.minimumJars) ||
      policy.minimumJars < 5 ||
      policy.minimumJars > 12 ||
      !Number.isSafeInteger(policy.cutoffHours) ||
      policy.cutoffHours < 0 ||
      policy.cutoffHours > 168
    )
      error("failed-precondition", "Delivery policy is not configured.");
    const address = addressFields(input.deliveryAddress);
    if (
      !policy.allowedZips.includes(address.zip) ||
      address.state !== policy.state
    )
      error("failed-precondition", "Address is outside the delivery area.");
    if (
      Object.values(input.cart).reduce((s, q) => s + q, 0) < policy.minimumJars
    )
      error("failed-precondition", "Delivery minimum jars not met.");
    const today = new Date(now());
    today.setUTCHours(0, 0, 0, 0);
    const days = (8 - today.getUTCDay()) % 7 || 7;
    let monday = today.getTime() + days * 86400000;
    if (now() >= monday - policy.cutoffHours * 3600000) monday += 7 * 86400000;
    return {
      deliveryFee: policy.feeCents,
      deliveryDate: new Date(monday).toISOString().slice(0, 10),
    };
  }
  function marketOccurrence(market, pickupDate) {
    let parts;
    try {
      if (typeof market.timezone !== "string" || !market.timezone)
        throw Error("Missing timezone");
      parts = new Intl.DateTimeFormat("en-US", {
        timeZone: market.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(now()));
    } catch {
      error("failed-precondition", "Market schedule timezone is not configured.");
    }
    const part = (type) => parts.find((p) => p.type === type).value;
    const today = `${part("year")}-${part("month")}-${part("day")}`;
    if (!pickupDate || pickupDate <= today)
      error("failed-precondition", "Pickup occurrence must be a future local date.");
    if (market.pickupDates !== undefined) {
      if (!Array.isArray(market.pickupDates) || !market.pickupDates.length ||
          market.pickupDates.some((d) => typeof d !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
            !Number.isFinite(Date.parse(d + "T00:00:00Z")) ||
            new Date(d + "T00:00:00Z").toISOString().slice(0, 10) !== d) ||
          !market.pickupDates.includes(pickupDate))
        error("failed-precondition", "Pickup occurrence is not in the approved schedule.");
    } else {
      const weekday = market.weekday ?? market.day;
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
          (market.weekday !== undefined && market.day !== undefined && market.weekday !== market.day))
        error("failed-precondition", "Market weekday schedule is not configured.");
      const midnight = new Date(today + "T00:00:00Z");
      const days = (weekday - midnight.getUTCDay() + 7) % 7 || 7;
      const next = new Date(midnight.getTime() + days * 86400000).toISOString().slice(0, 10);
      if (pickupDate !== next)
        error("failed-precondition", "Pickup must use the next approved market occurrence.");
    }
    if ((market.capacity !== undefined && (!Number.isSafeInteger(market.capacity) || market.capacity < 0)) ||
        (market.reservedCount !== undefined && (!Number.isSafeInteger(market.reservedCount) || market.reservedCount < 0)))
      error("failed-precondition", "Market occurrence capacity is invalid.");
    if ((market.capacity > 0 || market.reservedCount > 0 || market.orderCutoffAt !== undefined) &&
        market.occurrenceDate !== pickupDate)
      error("failed-precondition", "Market limits must be scoped to this occurrenceDate.");
    if (market.orderCutoffAt !== undefined &&
        (typeof market.orderCutoffAt !== "string" ||
         !/(Z|[+-]\d{2}:\d{2})$/.test(market.orderCutoffAt) ||
         !Number.isFinite(Date.parse(market.orderCutoffAt)) ||
         now() >= Date.parse(market.orderCutoffAt)))
      error("failed-precondition", "Market cutoff passed or invalid.");
    if (market.capacity > 0 && (market.reservedCount || 0) >= market.capacity)
      error("failed-precondition", "Market full.");
  }
  async function priced(tx, input) {
    const marketRef = input.marketId ? ref("markets", input.marketId) : null;
    const marketSnap = marketRef ? await tx.get(marketRef) : null;
    const market = marketSnap?.data() || {};
    if (marketRef && (!marketSnap.exists || market.active === false))
      error("failed-precondition", "Market is not accepting orders.");
    if (marketRef) marketOccurrence(market, input.pickupDate);
    const promotion =
      (await tx.get(ref("settings", "promotions"))).data() || {};
    const bundleEnabled = promotion.brothBundleEnabled === undefined
      ? true : promotion.brothBundleEnabled;
    const bundleMinimum = promotion.bundleMinimum === undefined ? 4 : promotion.bundleMinimum;
    const bundlePriceCents = promotion.bundlePriceCents === undefined ? 2000 : promotion.bundlePriceCents;
    // A disabled promotion may retain old draft pricing; enabled policies fail closed.
    // Bound the per-jar bundle price to USD 1,000, well above the current catalog.
    if (typeof bundleEnabled !== "boolean" || (bundleEnabled &&
        (!Number.isSafeInteger(bundleMinimum) || bundleMinimum < 1 || bundleMinimum > 12 ||
         !Number.isSafeInteger(bundlePriceCents) || bundlePriceCents < 1 || bundlePriceCents > 100000)))
      error("failed-precondition", "Bundle promotion is not configured correctly.");
    const items = [];
    for (const [productId, quantity] of Object.entries(input.cart)) {
      const snap = await tx.get(ref("products", productId));
      const p = snap.data();
      const price = p?.priceCents ?? p?.price;
      if (!snap.exists || p.active === false || p.available === false)
        error("failed-precondition", "Product not available.");
      if (
        !Number.isSafeInteger(price) ||
        price <= 0 ||
        typeof p.name !== "string"
      )
        error("failed-precondition", "Invalid catalog price.");
      items.push({
        productId,
        name: p.name,
        price,
        quantity,
        itemTotal: price * quantity,
      });
    }
    const subtotal = items.reduce((s, i) => s + i.itemTotal, 0);
    const broth = items.filter((i) => /broth/i.test(i.name));
    const count = broth.reduce((s, i) => s + i.quantity, 0);
    const discountAmount =
      bundleEnabled &&
      count >= bundleMinimum
        ? Math.max(
            0,
            broth.reduce((s, i) => s + i.itemTotal, 0) -
              count * bundlePriceCents,
          )
        : 0;
    const delivery =
      input.fulfillmentMethod === "local_delivery"
        ? await deliveryPolicy(tx, input)
        : { deliveryFee: 0, deliveryDate: null };
    const totalAmount = subtotal - discountAmount + delivery.deliveryFee;
    if (
      !Number.isSafeInteger(totalAmount) ||
      totalAmount < 1 ||
      totalAmount > 99999999
    )
      error("failed-precondition", "Invalid catalog total.");
    return {
      items,
      subtotal,
      discountAmount,
      totalAmount,
      ...delivery,
      currency: "usd",
      marketName: market.name || null,
      marketRef,
      market,
    };
  }
  async function creationBudget(tx, input) {
    // No IP security boundary: Express trust-proxy and forwarding headers are not identity.
    // Fixed bucket namespace bounds limiter storage without requiring a TTL scheduler.
    // Collisions intentionally share a conservative limit; email is NOT verified ownership.
    const windowMs = 15 * 60 * 1000;
    const budgets = [];
    const emailBucket = hash(input.customerEmail).slice(0, 4);
    for (const [id, limit] of [[`v2-email-${emailBucket}`, 3], ["v2-global", 1000]]) {
      const budgetRef = ref("commerceRateLimits", id);
      const previous = (await tx.get(budgetRef)).data();
      const current = previous && now() < previous.windowStart + windowMs
        ? previous : { windowStart: now(), count: 0 };
      if (current.count >= limit)
        error("resource-exhausted", "Too many new order attempts; retry later using the same request.");
      budgets.push({ budgetRef, value: { ...current, count: current.count + 1 } });
    }
    return budgets;
  }
  async function create(data = {}, context = {}, preorder = false) {
    const input = normalize(data, context);
    if (typeof data.receiptToken !== "string" || !/^[a-f0-9]{64}$/.test(data.receiptToken))
      error("invalid-argument", "A 32-byte lowercase hex receiptToken is required.");
    const receiptTokenHash = hash(data.receiptToken);
    if (preorder) {
      if (
        data.paymentIntentId ||
        !(
          (data.paymentMethod === "pickup" &&
            input.fulfillmentMethod === "market_pickup") ||
          (data.paymentMethod === "special_order" &&
            input.fulfillmentMethod === "special_order")
        )
      )
        error(
          "invalid-argument",
          "Preorder payment method must match pickup or special order.",
        );
    } else if (input.fulfillmentMethod === "special_order")
      error(
        "failed-precondition",
        "Special orders require approval before payment.",
      );
    input.paymentMethod = preorder ? data.paymentMethod : "stripe";
    const fingerprint = hash(stable(input));
    const orderRef = ref("orders", hash(input.requestId));
    const { order, receiptToken } = await db.runTransaction(async (tx) => {
      const existing = await tx.get(orderRef);
      if (existing.exists) {
        if (existing.data().fingerprint !== fingerprint)
          error("failed-precondition", "Request conflict.");
        if (!existing.data().receiptTokenHash ||
            !/^[a-f0-9]{64}$/.test(existing.data().receiptTokenHash) ||
            !timingSafeEqual(Buffer.from(existing.data().receiptTokenHash, "hex"),
              Buffer.from(receiptTokenHash, "hex")) ||
            existing.data().receiptRevoked || !Number.isFinite(existing.data().receiptExpiresAt) ||
            existing.data().receiptExpiresAt <= now())
          error("permission-denied", "Invalid or expired request capability.");
        return { order: existing.data(), receiptToken: data.receiptToken };
      }
      // Only Firebase's callable SDK can populate this verified context; never read headers/body for it.
      if (typeof context.app?.appId !== "string" || !context.app.appId)
        error("unauthenticated", "Verified App Check is required for order creation.");
      const { marketRef, market, ...price } = await priced(tx, input);
      const budgets = await creationBudget(tx, input);
      const receiptToken = data.receiptToken;
      const created = {
        ...input,
        ...price,
        fingerprint,
        orderName: `Mammoth-${orderRef.id.slice(0, 8)}`,
        status: preorder
          ? input.fulfillmentMethod === "special_order"
            ? "awaiting_approval"
            : "pending"
          : "awaiting_payment",
        paymentIntentId: null,
        paymentBinding: randomBytes(32).toString("hex"),
        receiptTokenHash: hash(receiptToken),
        receiptExpiresAt: now() + 30 * 86400000,
        receiptRevoked: false,
        createdAt: now(),
        emailState: preorder ? "pending" : "none",
        emailVersion: preorder ? 1 : 0,
        emailSentVersion: 0,
        emailCustomerSentVersion: 0,
        emailOperationsSentVersion: 0,
      };
      for (const { budgetRef, value } of budgets) tx.set(budgetRef, value);
      tx.set(orderRef, created);
      if (preorder && market.capacity > 0)
        tx.update(marketRef, {
          reservedCount: (market.reservedCount || 0) + 1,
        });
      return { order: created, receiptToken };
    });
    if (preorder)
      return {
        orderId: orderRef.id,
        orderName: order.orderName,
        receiptToken,
        totalAmount: order.totalAmount,
        emailState: order.emailState,
      };
    if (order.paymentIntentId)
      return {
        orderId: orderRef.id,
        orderName: order.orderName,
        receiptToken,
        clientSecret: order.clientSecret,
        totalAmount: order.totalAmount,
      };
    const lease = randomBytes(16).toString("hex");
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(orderRef)).data();
      if (current.paymentLeaseUntil > now())
        error(
          "unavailable",
          "Payment setup in progress; retry the same request.",
        );
      if (now() - current.createdAt > 23 * 3600000)
        error(
          "failed-precondition",
          "Payment setup expired; contact owner for reconciliation.",
        );
      tx.update(orderRef, {
        paymentLease: lease,
        paymentLeaseUntil: now() + 120000,
      });
    });
    let intent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: order.totalAmount,
          currency: "usd",
          automatic_payment_methods: { enabled: true },
          metadata: { orderId: orderRef.id, binding: order.paymentBinding },
        },
        { idempotencyKey: `order-${orderRef.id}` },
      );
    } catch {
      await db.runTransaction(async (tx) => {
        const o = (await tx.get(orderRef)).data();
        if (o.paymentLease === lease)
          tx.update(orderRef, { paymentLeaseUntil: 0 });
      });
      error(
        "unavailable",
        "Payment provider unavailable; retry unchanged request.",
      );
    }
    if (!intent.id || !intent.client_secret)
      error("unavailable", "Invalid payment provider response.");
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(orderRef)).data();
      const binding = await tx.get(ref("paymentBindings", intent.id));
      if (
        (current.paymentIntentId && current.paymentIntentId !== intent.id) ||
        (binding.exists && binding.data().orderId !== orderRef.id)
      )
        error("failed-precondition", "Payment binding conflict.");
      tx.set(ref("paymentBindings", intent.id), { orderId: orderRef.id });
      tx.update(orderRef, {
        paymentIntentId: intent.id,
        clientSecret: intent.client_secret,
        paymentLeaseUntil: 0,
      });
    });
    return {
      orderId: orderRef.id,
      orderName: order.orderName,
      receiptToken,
      clientSecret: intent.client_secret,
      totalAmount: order.totalAmount,
    };
  }
  async function processStripeEvent(event) {
    if (!/^evt_[-\w]+$/.test(event?.id || ""))
      error("invalid-argument", "Invalid event.");
    if (
      event.type !== "payment_intent.succeeded" &&
      event.type !== "checkout.session.completed"
    )
      return { ignored: true };
    const payment = event.data?.object;
    if (!payment || !/^[-\w]{64}$/.test(payment.metadata?.orderId || ""))
      error("failed-precondition", "Payment metadata mismatch.");
    const orderId = payment.metadata.orderId;
    const digest = hash(stable({ type: event.type, payment }));
    return db.runTransaction(async (tx) => {
      const eventRef = ref("stripeEvents", event.id),
        orderRef = ref("orders", orderId);
      const prior = await tx.get(eventRef);
      const snapshot = await tx.get(orderRef);
      if (prior.exists) {
        if (prior.data().digest !== digest)
          error("failed-precondition", "Event replay conflict.");
        return { duplicate: true };
      }
      if (!snapshot.exists)
        error("failed-precondition", "Unknown payment order.");
      const order = snapshot.data();
      const checkout = event.type === "checkout.session.completed";
      const intentId = checkout ? payment.payment_intent : payment.id;
      if (typeof intentId !== "string" || !/^pi_[-\w]+$/.test(intentId))
        error("failed-precondition", "Payment intent mismatch.");
      const bindingRef = ref("paymentBindings", intentId);
      const binding = await tx.get(bindingRef);
      const amount = checkout ? payment.amount_total : payment.amount_received;
      if (
        payment.metadata.binding !== order.paymentBinding ||
        payment.currency !== order.currency ||
        amount !== order.totalAmount ||
        (!checkout &&
          (payment.status !== "succeeded" ||
            payment.amount !== order.totalAmount)) ||
        (checkout &&
          (payment.payment_status !== "paid" ||
            payment.mode !== "payment" ||
            order.checkoutSessionId !== payment.id)) ||
        (order.paymentIntentId && order.paymentIntentId !== intentId) ||
        (binding.exists && binding.data().orderId !== orderId)
      )
        error("failed-precondition", "Payment binding or amount mismatch.");
      if (!["awaiting_payment", "paid", "paid_requires_review"].includes(order.status))
        error("failed-precondition", "Payment conflicts with order state.");
      const settled = ["paid", "paid_requires_review"].includes(order.status);
      let reviewReason = order.reviewReason || null;
      let marketRef, market;
      if (!settled && order.fulfillmentMethod === "market_pickup") {
        marketRef = ref("markets", order.marketId);
        const snap = await tx.get(marketRef);
        market = snap.data();
        try {
          if (!snap.exists || market.active === false)
            error("failed-precondition", "Market is not accepting orders.");
          marketOccurrence(market, order.pickupDate);
        } catch (cause) {
          if (cause.code !== "failed-precondition") throw cause;
          reviewReason = cause.message;
        }
      }
      const status = settled ? order.status : reviewReason ? "paid_requires_review" : "paid";
      if (!settled && !reviewReason && market?.capacity > 0)
        tx.update(marketRef, { reservedCount: (market.reservedCount || 0) + 1 });
      tx.set(bindingRef, { orderId });
      tx.set(eventRef, {
        orderId,
        digest,
        type: event.type,
        processedAt: now(),
      });
      tx.update(orderRef, {
        status,
        reviewReason,
        reconciliationRequired: status === "paid_requires_review",
        paymentIntentId: intentId,
        paidAt: order.paidAt || now(),
        ...(!settled
          ? { emailVersion: order.emailVersion + 1, emailState: "pending" }
          : {}),
      });
      return { duplicate: settled, status };
    });
  }
  const requireAdmin = (context) => {
    if (context?.auth?.token?.admin !== true)
      error("permission-denied", "Owner admin claim required.");
  };
  function orderReference(orderId) {
    if (!/^[a-f0-9]{64}$/.test(orderId || ""))
      error("invalid-argument", "Invalid order reference.");
    return ref("orders", orderId);
  }
  async function getGuestReceipt({ orderId, token } = {}) {
    const snapshot = await orderReference(orderId).get();
    const o = snapshot.data();
    if (
      !snapshot.exists ||
      typeof token !== "string" ||
      !/^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/.test(token) ||
      !/^[a-f0-9]{64}$/.test(o.receiptTokenHash || "") ||
      o.receiptRevoked ||
      !Number.isFinite(o.receiptExpiresAt) ||
      o.receiptExpiresAt <= now() ||
      !timingSafeEqual(
        Buffer.from(hash(token), "hex"),
        Buffer.from(o.receiptTokenHash, "hex"),
      )
    )
      error("permission-denied", "Invalid or expired receipt.");
    const result = { orderId };
    for (const key of [
      "orderName",
      "status",
      "paymentMethod",
      "fulfillmentMethod",
      "subtotal",
      "discountAmount",
      "deliveryFee",
      "totalAmount",
      "currency",
      "marketName",
      "pickupDate",
      "deliveryDate",
      "checkoutUrl",
    ])
      result[key] = o[key] ?? null;
    result.items = o.items.map((item) =>
      Object.fromEntries(
        ["productId", "name", "quantity", "price", "itemTotal"].map((k) => [
          k,
          item[k],
        ]),
      ),
    );
    return result;
  }
  async function revokeGuestReceipt({ orderId } = {}, context = {}) {
    requireAdmin(context);
    const orderRef = orderReference(orderId);
    await db.runTransaction(async (tx) => {
      if (!(await tx.get(orderRef)).exists)
        error("not-found", "Order not found.");
      tx.update(orderRef, { receiptRevoked: true });
    });
    return { orderId, revoked: true };
  }
  function approvedTerms(data) {
    if (
      !Array.isArray(data.items) ||
      data.items.length < 1 ||
      data.items.length > 50
    )
      error("invalid-argument", "Approved items required.");
    const items = data.items.map((i) => {
      if (
        !i ||
        !/^[-\w]{1,100}$/.test(i.productId || "") ||
        typeof i.name !== "string" ||
        !i.name.trim() ||
        i.name.length > 120 ||
        !Number.isSafeInteger(i.quantity) ||
        i.quantity < 1 ||
        i.quantity > 1000 ||
        !Number.isSafeInteger(i.price) ||
        i.price < 1
      )
        error("invalid-argument", "Invalid approved items.");
      return {
        productId: i.productId,
        name: i.name.trim(),
        quantity: i.quantity,
        price: i.price,
        itemTotal: i.price * i.quantity,
      };
    });
    const totalAmount = items.reduce((s, i) => s + i.itemTotal, 0);
    if (
      !Number.isSafeInteger(totalAmount) ||
      totalAmount > 99999999 ||
      data.totalAmount !== totalAmount
    )
      error("invalid-argument", "Approved total must equal item total.");
    return { items, totalAmount };
  }
  function checkoutOrigin() {
    let url;
    try {
      url = new URL(origin);
    } catch {
      error("failed-precondition", "HTTPS checkout origin not configured.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      error("failed-precondition", "HTTPS checkout origin not configured.");
    return url.origin;
  }
  async function reviewSpecialOrder(data = {}, context = {}) {
    requireAdmin(context);
    if (!["approve", "decline"].includes(data.decision))
      error("invalid-argument", "Choose approve or decline.");
    const terms = data.decision === "approve" ? approvedTerms(data) : null;
    const baseOrigin = terms ? checkoutOrigin() : null;
    const orderRef = orderReference(data.orderId),
      decisionHash = hash(stable({ decision: data.decision, terms }));
    const lease = randomBytes(16).toString("hex");
    const order = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(orderRef);
      if (!snapshot.exists) error("not-found", "Order not found.");
      const o = snapshot.data();
      if (o.fulfillmentMethod !== "special_order")
        error("failed-precondition", "Only special orders can be reviewed.");
      if (o.reviewHash && o.reviewHash !== decisionHash)
        error("failed-precondition", "Review transition conflict.");
      if (!o.reviewHash && o.status !== "awaiting_approval")
        error("failed-precondition", "Review transition conflict.");
      if (o.reviewHash && (o.checkoutSessionId || data.decision === "decline"))
        return o;
      if (o.checkoutLeaseUntil > now())
        error(
          "unavailable",
          "Checkout setup in progress; retry unchanged approval.",
        );
      if (o.approvedAt && now() - o.approvedAt > 23 * 3600000)
        error(
          "failed-precondition",
          "Checkout expired; reconcile with provider before retrying.",
        );
      const update = terms
        ? {
            ...terms,
            subtotal: terms.totalAmount,
            discountAmount: 0,
            deliveryFee: 0,
            status: "awaiting_payment",
            emailState: "blocked_payment_setup",
            paymentMethod: "stripe",
            reviewHash: decisionHash,
            approvedAt: o.approvedAt || now(),
            reviewedBy: context.auth.uid,
            checkoutLease: lease,
            checkoutLeaseUntil: now() + 120000,
          }
        : {
            status: "declined",
            reviewHash: decisionHash,
            reviewedBy: context.auth.uid,
            reviewedAt: now(),
            emailVersion: o.emailVersion + 1,
            emailState: "pending",
          };
      tx.update(orderRef, update);
      return { ...o, ...update };
    });
    if (data.decision === "decline")
      return { orderId: data.orderId, status: order.status, checkoutUrl: null };
    let checkoutUrl = order.checkoutUrl;
    if (!order.checkoutSessionId) {
      let session;
      try {
        session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            payment_method_types: ["card"],
            client_reference_id: data.orderId,
            customer_email: order.customerEmail,
            line_items: order.items.map((i) => ({
              price_data: {
                currency: "usd",
                unit_amount: i.price,
                product_data: { name: i.name },
              },
              quantity: i.quantity,
            })),
            metadata: { orderId: data.orderId, binding: order.paymentBinding },
            payment_intent_data: {
              metadata: {
                orderId: data.orderId,
                binding: order.paymentBinding,
              },
            },
            success_url: `${baseOrigin}/receipt.html#order=${encodeURIComponent(data.orderId)}`,
            cancel_url: `${baseOrigin}/receipt.html#order=${encodeURIComponent(data.orderId)}`,
          },
          { idempotencyKey: `approval-${data.orderId}` },
        );
      } catch {
        await db.runTransaction(async (tx) => {
          const o = (await tx.get(orderRef)).data();
          if (o.checkoutLease === lease)
            tx.update(orderRef, { checkoutLeaseUntil: 0 });
        });
        error("unavailable", "Checkout unavailable; retry unchanged approval.");
      }
      if (
        typeof session.id !== "string" ||
        !/^cs_[-\w]+$/.test(session.id) ||
        typeof session.url !== "string" ||
        !/^https:\/\/checkout\.stripe\.com\//.test(session.url)
      )
        error("unavailable", "Invalid checkout response.");
      checkoutUrl = session.url;
      await db.runTransaction(async (tx) => {
        const o = (await tx.get(orderRef)).data();
        if (
          o.reviewHash !== decisionHash ||
          (o.checkoutSessionId && o.checkoutSessionId !== session.id)
        )
          error("failed-precondition", "Checkout binding conflict.");
        tx.update(orderRef, {
          checkoutSessionId: session.id,
          checkoutUrl: session.url,
          checkoutLeaseUntil: 0,
          emailVersion: 2,
          emailState: "pending",
        });
      });
    }
    // Email failure must never roll back approval/payment setup. Durable pending work is retried by trigger/admin.
    try {
      await deliverOrderEmail({ orderId: data.orderId });
    } catch {
      /* durable pending state retained */
    }
    return { orderId: data.orderId, status: order.status, checkoutUrl };
  }
  async function resumePaymentSetup({ orderId } = {}, context = {}) {
    requireAdmin(context);
    const snapshot = await orderReference(orderId).get();
    if (!snapshot.exists) error("not-found", "Order not found.");
    const order = snapshot.data();
    if (order.fulfillmentMethod !== "special_order" || !order.reviewHash ||
        order.status !== "awaiting_payment")
      error("failed-precondition", "Only frozen approved special orders can resume checkout.");
    return reviewSpecialOrder({
      orderId, decision: "approve", items: order.items, totalAmount: order.totalAmount,
    }, context);
  }
  async function deliverOrderEmail({ orderId } = {}) {
    const orderRef = orderReference(orderId);
    const lease = randomBytes(16).toString("hex");
    const order = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(orderRef);
      if (!snapshot.exists) error("not-found", "Order not found.");
      const o = snapshot.data();
      if (o.fulfillmentMethod === "special_order" && o.status === "awaiting_payment" &&
          (!o.checkoutSessionId || !o.checkoutUrl)) return { paymentSetupPending: true };
      if (!o.emailVersion || o.emailSentVersion >= o.emailVersion) return null;
      if (o.emailLeaseUntil > now())
        error("unavailable", "Email delivery in progress.");
      tx.update(orderRef, {
        emailState: "sending",
        emailLease: lease,
        emailLeaseUntil: now() + 120000,
        emailAttempts: (o.emailAttempts || 0) + 1,
        // Legacy aggregate sent means both recipients completed. Legacy partial
        // failures cannot be reconstructed; their first retry can still duplicate.
        emailCustomerSentVersion: o.emailCustomerSentVersion ?? o.emailSentVersion ?? 0,
        emailOperationsSentVersion: o.emailOperationsSentVersion ?? o.emailSentVersion ?? 0,
      });
      return o;
    });
    if (!order) return { orderId, delivered: true };
    if (order.paymentSetupPending) return { orderId, delivered: false, suppressed: true };
    try {
      const text =
        order.status === "paid_requires_review"
          ? `Payment received for ${order.orderName}, but fulfillment needs manual review. No pickup is confirmed. The owner must arrange fulfillment or a refund; please contact us.`
          : order.status === "paid"
          ? `Payment received for ${order.orderName}. Total: USD ${(order.totalAmount / 100).toFixed(2)}. Thank you.`
          : order.checkoutUrl
            ? `Your special order ${order.orderName} is approved. Pay securely: ${order.checkoutUrl}\nTotal: USD ${(order.totalAmount / 100).toFixed(2)}. Approval is not payment.`
            : order.status === "declined"
              ? `Your special order ${order.orderName} was declined. No payment was collected.`
              : order.status === "awaiting_approval"
                ? `Your special-order request ${order.orderName} was received and awaits owner approval. No payment has been collected.`
                : order.fulfillmentMethod === "special_order"
                  ? `Your special-order request ${order.orderName} is pending owner follow-up. No pickup is confirmed.`
                  : `Your pickup preorder ${order.orderName} was received. Payment is due at pickup.`;
      if (!isMailbox(order.customerEmail))
        error("failed-precondition", "Stored customer email is not a single mailbox.");
      // Injection contract: one recipient per awaited sendEmail call. Checkpoint
      // each acceptance before attempting the other recipient. SMTP is not
      // exactly-once: crash/timeout after acceptance but before this durable
      // checkpoint can cause a duplicate on retry (SMTP has no idempotency key).
      const receipt = renderReceiptEmail(text, orderId);
      for (const [recipient, field] of [
        ["customer", "emailCustomerSentVersion"],
        ["operations", "emailOperationsSentVersion"],
      ]) {
        const needed = await db.runTransaction(async (tx) => {
          const o = (await tx.get(orderRef)).data();
          if (o.emailLease !== lease || o.emailLeaseUntil <= now())
            error("unavailable", "Email delivery lease expired.");
          if (o[field] >= order.emailVersion) return false;
          tx.update(orderRef, { emailLeaseUntil: now() + 120000 });
          return true;
        });
        if (!needed) continue;
        await sendEmail({
          recipient,
          ...(recipient === "customer" ? { to: { address: order.customerEmail } } : {}),
          subject: `Mammoth order ${order.orderName}`,
          text,
          ...receipt,
        });
        await db.runTransaction(async (tx) => {
          const o = (await tx.get(orderRef)).data();
          if (o.emailLease !== lease || o.emailLeaseUntil <= now())
            error("unavailable", "Email delivery lease expired.");
          tx.update(orderRef, { [field]: order.emailVersion });
        });
      }
      await db.runTransaction(async (tx) => {
        const o = (await tx.get(orderRef)).data();
        if (o.emailLease === lease)
          tx.update(orderRef, {
            emailSentVersion: order.emailVersion,
            emailState:
              o.emailVersion === order.emailVersion ? "sent" : "pending",
            emailLeaseUntil: 0,
          });
      });
      return { orderId, delivered: true };
    } catch {
      await db.runTransaction(async (tx) => {
        const o = (await tx.get(orderRef)).data();
        if (o.emailLease === lease)
          tx.update(orderRef, { emailState: "pending", emailLeaseUntil: 0 });
      });
      error("unavailable", "Email delivery failed; retry available.");
    }
  }
  const retryOrderEmail = (data, context) => {
    requireAdmin(context);
    return deliverOrderEmail(data);
  };
  async function getDeliveryQuote({ cart, address } = {}) {
    const input = {
      cart: Object.fromEntries(cartEntries(cart)),
      fulfillmentMethod: "local_delivery",
      deliveryAddress: addressFields(address),
    };
    return db.runTransaction(async (tx) => {
      const price = await priced(tx, input);
      return Object.fromEntries(
        [
          "deliveryFee",
          "deliveryDate",
          "subtotal",
          "discountAmount",
          "totalAmount",
          "currency",
        ].map((k) => [k, price[k]]),
      );
    });
  }
  return {
    createPaymentIntent: create,
    createPreorder: (data, context) => create(data, context, true),
    processStripeEvent,
    getGuestReceipt,
    revokeGuestReceipt,
    reviewSpecialOrder,
    resumePaymentSetup,
    retryOrderEmail,
    deliverOrderEmail,
    getDeliveryQuote,
  };
};
