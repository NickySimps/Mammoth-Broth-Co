"use strict";
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const { renderReceiptEmail } = require("./receipt-email.cjs");
const { pickupEmailCopy } = require("./pickup-email-copy.cjs");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const DEFAULT_MARKET_TIMEZONE = "America/New_York"; // Legacy receipt display only; new schedules require configuration.
const isCalendarDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
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
    const pickupType = data.pickupType === undefined ? "market" : data.pickupType;
    if (fulfillmentMethod === "market_pickup" && !["market", "monthly"].includes(pickupType))
      error("invalid-argument", "Pickup type must be market or monthly.");
    if (fulfillmentMethod !== "market_pickup" && data.pickupType !== undefined)
      error("invalid-argument", "Pickup type is only valid for market pickup.");
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
      ...(pickupType === "monthly" ? { pickupType } : {}),
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
      const configuredTimezone = typeof market.timezone === "string" && market.timezone.trim() ? market.timezone : null;
      if (!configuredTimezone)
        error("failed-precondition", "Market schedule timezone is not configured.");
      const timezone = configuredTimezone;
      parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
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
      const next = market.pickupDates.filter((d) => d > today).sort()[0];
      if (pickupDate !== next)
        error("failed-precondition", "Pickup must use the next approved market occurrence.");
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
  function marketTimezone(market) {
    const timezone = typeof market?.timezone === "string" && market.timezone.trim() ? market.timezone : null;
    if (!timezone) error("failed-precondition", "Market schedule timezone is not configured.");
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); }
    catch { error("failed-precondition", "Market schedule timezone is invalid."); }
    return timezone;
  }
  function localDateTimeIso(date, time, timezone) {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(time || "");
    if (!dateMatch || !isCalendarDate(date) || !timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59)
      error("failed-precondition", "Monthly pickup start time is invalid.");
    const target = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(timeMatch[1]), Number(timeMatch[2]));
    let guess = target;
    for (let i = 0; i < 4; i++) {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
      const get = type => Number(parts.find(part => part.type === type)?.value);
      const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
      const delta = target - represented;
      if (!delta) return new Date(guess).toISOString();
      guess += delta;
    }
    error("failed-precondition", "Monthly pickup local time is not valid in the market timezone.");
  }
  function monthlyPickupWindow(market, pickupDate) {
    const timezone = marketTimezone(market);
    const startTime = market.pickupWindowStartTime;
    const endTime = market.pickupWindowEndTime;
    const start = Date.parse(localDateTimeIso(pickupDate, startTime, timezone));
    const end = Date.parse(localDateTimeIso(pickupDate, endTime, timezone));
    if (end <= start) error("failed-precondition", "Monthly pickup end time must be on the same day and after its start.");
    return { pickupWindowStartAt: start, pickupWindowEndAt: end, marketTimezone: timezone };
  }
  function nextAlternativeDate(market, afterDate, latestDate) {
    if (!market || market.active === false) return null;
    marketTimezone(market);
    let date = null;
    if (market.pickupDates !== undefined) {
      if (!Array.isArray(market.pickupDates) || market.pickupDates.some(d => typeof d !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`)) ||
          new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d)) return null;
      date = market.pickupDates.filter(d => d > afterDate && d <= latestDate).sort()[0] || null;
    } else {
      const weekday = market.weekday ?? market.day;
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
          (market.weekday !== undefined && market.day !== undefined && market.weekday !== market.day)) return null;
      const cursor = new Date(`${afterDate}T00:00:00Z`);
      for (let i = 1; i <= 7; i++) {
        const candidate = new Date(cursor.getTime() + i * 86400000).toISOString().slice(0, 10);
        if (candidate > latestDate) break;
        if (new Date(`${candidate}T00:00:00Z`).getUTCDay() === weekday) { date = candidate; break; }
      }
    }
    if (!date) return null;
    if (market.capacity !== undefined && (!Number.isSafeInteger(market.capacity) || market.capacity < 0)) return null;
    if (market.reservedCount !== undefined && (!Number.isSafeInteger(market.reservedCount) || market.reservedCount < 0)) return null;
    if (market.capacity > 0 && (market.occurrenceDate !== date || (market.reservedCount || 0) >= market.capacity)) return null;
    if (market.occurrenceDate === date && market.orderCutoffAt !== undefined &&
        (typeof market.orderCutoffAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(market.orderCutoffAt) ||
         !Number.isFinite(Date.parse(market.orderCutoffAt)) || now() >= Date.parse(market.orderCutoffAt))) return null;
    return date;
  }
  function monthlyPickupFields(order) {
    return order.pickupType === "monthly" ? {
      pickupType: "monthly", pickupWindowStartAt: Number.isFinite(order.pickupWindowStartAt) ? new Date(order.pickupWindowStartAt).toISOString() : null,
      pickupWindowEndAt: Number.isFinite(order.pickupWindowEndAt) ? new Date(order.pickupWindowEndAt).toISOString() : null, marketTimezone: order.marketTimezone ?? DEFAULT_MARKET_TIMEZONE,
      pickupRevision: order.pickupRevision ?? 0,
    } : {};
  }
  async function priced(tx, input) {
    const marketRef = input.marketId ? ref("markets", input.marketId) : null;
    const marketSnap = marketRef ? await tx.get(marketRef) : null;
    const market = marketSnap?.data() || {};
    if (marketRef && (!marketSnap.exists || market.active === false))
      error("failed-precondition", "Market is not accepting orders.");
    if (marketRef) marketOccurrence(market, input.pickupDate);
    // Storefront policy is fixed: any six jars qualify, but only these two IDs
    // receive the $20 price. Names and stale promotion drafts grant no eligibility.
    const jarCount = Object.values(input.cart).reduce((s, q) => s + q, 0);
    const items = [];
    for (const [productId, quantity] of Object.entries(input.cart)) {
      if (!["prod_beef", "prod_chicken", "mushroom"].includes(productId))
        error("failed-precondition", "Unsupported catalog product.");
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
    const discountAmount = jarCount >= 6
      ? items.reduce((s, i) => s + (
          ["prod_beef", "prod_chicken"].includes(i.productId)
            ? Math.max(0, i.price - 2000) * i.quantity : 0
        ), 0)
      : 0;
    const delivery = { deliveryFee: 0, deliveryDate: null };
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
      // Retain capability-proven historical retries above, but never open new delivery/special work.
      if (input.fulfillmentMethod !== "market_pickup")
        error("failed-precondition", "New orders are available for market pickup only.");
      // Only Firebase's callable SDK can populate this verified context; never read headers/body for it.
      if (typeof context.app?.appId !== "string" || !context.app.appId)
        error("unauthenticated", "Verified App Check is required for order creation.");
      const { marketRef, market, ...price } = await priced(tx, input);
      const monthly = input.pickupType === "monthly" ? {
        ...monthlyPickupWindow(market, input.pickupDate), pickupRevision: 0,
        pickupReservationCounted: Boolean(preorder && market.capacity > 0),
      } : {};
      const budgets = await creationBudget(tx, input);
      const receiptToken = data.receiptToken;
      const created = {
        ...input,
        ...price,
        ...monthly,
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
        marketName: order.marketName ?? null,
        pickupDate: order.pickupDate ?? null,
        ...monthlyPickupFields(order),
        emailState: order.emailState,
      };
    if (order.paymentIntentId)
      return {
        orderId: orderRef.id,
        orderName: order.orderName,
        receiptToken,
        clientSecret: order.clientSecret,
        totalAmount: order.totalAmount,
        marketName: order.marketName ?? null,
        pickupDate: order.pickupDate ?? null,
        ...monthlyPickupFields(order),
      };
    if (order.fulfillmentMethod !== "market_pickup")
      error("failed-precondition", "Historical delivery payment setup requires owner reconciliation; new orders are pickup only.");
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
      marketName: order.marketName ?? null,
      pickupDate: order.pickupDate ?? null,
      ...monthlyPickupFields(order),
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
      if (order.paymentMethod !== "stripe")
        error("failed-precondition", "Payment conflicts with order state: provider settlement requires Stripe payment method.");
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
        ...(!settled && order.fulfillmentMethod === "market_pickup" && !reviewReason
          ? { pickupReservationCounted: market?.capacity > 0 }
          : {}),
        paymentIntentId: intentId,
        paidAt: order.paidAt || now(),
        ...(!order.paymentEvidence ? {
          paymentEvidence: { source: "stripe", eventId: event.id, paymentIntentId: intentId,
            recordedAt: now(), totalAmount: order.totalAmount, currency: order.currency },
        } : {}),
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
  function pickupChangeUnsafe(order) {
    const present = key => order[key] !== undefined && order[key] !== null;
    const hasValue = key => present(key) && order[key] !== "" && order[key] !== false && order[key] !== 0;
    return (order.fulfillmentStatus !== undefined && order.fulfillmentStatus !== "uncollected") ||
      ["collectedAt", "collectionEvidence"].some(present) ||
      ["reconciliationRequired", "reviewReason", "refundStatus", "refundedAt", "cancelledAt", "canceledAt", "refundId", "refundAmount", "amountRefunded", "disputeStatus"].some(hasValue);
  }
  function orderReference(orderId) {
    if (!/^[a-f0-9]{64}$/.test(orderId || ""))
      error("invalid-argument", "Invalid order reference.");
    return ref("orders", orderId);
  }
  async function recordMarketPickupAction(data = {}, context = {}) {
    // Authorization precedes validation, reference construction and every database read.
    requireAdmin(context);
    const actorUid = context.auth.uid;
    if (typeof actorUid !== "string" || !actorUid || actorUid.length > 128)
      error("permission-denied", "Verified admin identity required.");
    const fields = ["orderId", "operationId", "action", "expectedRevision", "expectedTotalAmount", "expectedCurrency"];
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        Object.keys(data).length !== fields.length || fields.some((key) => !Object.hasOwn(data, key)) ||
        typeof data.orderId !== "string" || !/^[a-f0-9]{64}$/.test(data.orderId) ||
        typeof data.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.operationId) ||
        !["record_payment", "record_collection", "record_payment_and_collection"].includes(data.action) ||
        !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0 ||
        !Number.isSafeInteger(data.expectedTotalAmount) || data.expectedTotalAmount < 1 || data.expectedTotalAmount > 99999999 ||
        typeof data.expectedCurrency !== "string" || !/^[a-z]{3}$/.test(data.expectedCurrency))
      error("invalid-argument", "Exact pickup action, UUID, revision, amount and currency required; no payment details accepted.");
    const orderRef = orderReference(data.orderId);
    // Globally scoped operation IDs prevent accidental reuse across orders or actors.
    const auditRef = ref("pickupActionAudits", hash(data.operationId.toLowerCase()));
    const requestDigest = hash(stable(data));
    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(orderRef);
      const prior = await tx.get(auditRef);
      if (prior.exists) {
        const audit = prior.data();
        if (audit.actorUid !== actorUid || audit.requestDigest !== requestDigest)
          error("failed-precondition", "Pickup operation replay conflict.");
        return audit.outcome;
      }
      if (!snapshot.exists) error("not-found", "Order not found.");
      const order = snapshot.data();
      const revision = order.pickupAdminRevision === undefined ? 0 : order.pickupAdminRevision;
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER ||
          revision !== data.expectedRevision || order.totalAmount !== data.expectedTotalAmount ||
          order.currency !== data.expectedCurrency)
        error("failed-precondition", "Pickup ledger revision, amount or currency changed; refresh before acting.");
      if (order.fulfillmentMethod !== "market_pickup")
        error("failed-precondition", "Only market pickup orders are supported.");
      const recordPayment = data.action !== "record_collection";
      const recordCollection = data.action !== "record_payment";
      // Unknown fulfillment/review/adverse states are not evidence of a safe handover.
      const hasValue = (key) => order[key] !== undefined && order[key] !== null && order[key] !== "" && order[key] !== false && order[key] !== 0;
      const present = (key) => order[key] !== undefined && order[key] !== null;
      if (["collectedAt", "collectionEvidence"].some(present) ||
          (order.fulfillmentStatus !== undefined && order.fulfillmentStatus !== "uncollected") ||
          ["reconciliationRequired", "reviewReason", "refundStatus", "refundedAt", "cancelledAt", "canceledAt", "refundId", "refundAmount", "amountRefunded", "disputeStatus"].some(hasValue))
        error("failed-precondition", "Order needs reconciliation or has already been collected.");
      const providerReference = ["paymentIntentId", "checkoutSessionId", "clientSecret", "checkoutUrl"].some(hasValue);
      const activeLease = [["paymentLease", "paymentLeaseUntil"], ["checkoutLease", "checkoutLeaseUntil"]].some(([token, until]) =>
        (hasValue(token) && !Number.isFinite(order[until])) ||
        (present(until) && (!Number.isFinite(order[until]) || order[until] > now())));
      if (recordPayment && (providerReference || activeLease || ["paidAt", "paymentEvidence"].some(present)))
        error("failed-precondition", "Payment evidence or provider setup already exists.");
      if (!recordPayment) {
        if (order.status !== "paid" || !Number.isFinite(order.paidAt) || order.paidAt <= 0)
          error("failed-precondition", "Collection requires verified prior payment.");
        const evidence = order.paymentEvidence;
        if (!evidence || evidence.totalAmount !== order.totalAmount || evidence.currency !== order.currency ||
            !Number.isFinite(evidence.recordedAt) || evidence.recordedAt <= 0)
          error("failed-precondition", "Missing authoritative payment evidence.");
        if (order.paymentMethod === "pickup") {
          if (providerReference || activeLease || evidence.source !== "operator_declaration" ||
              typeof evidence.actorUid !== "string" || !evidence.actorUid ||
              typeof evidence.operationId !== "string" || !/^[0-9a-f-]{36}$/i.test(evidence.operationId))
            error("failed-precondition", "Invalid pickup payment evidence.");
          const paymentAudit = (await tx.get(ref("pickupActionAudits", hash(evidence.operationId.toLowerCase())))).data();
          if (!paymentAudit || paymentAudit.orderId !== data.orderId || paymentAudit.actorUid !== evidence.actorUid ||
              !["record_payment", "record_payment_and_collection"].includes(paymentAudit.action) ||
              paymentAudit.totalAmount !== order.totalAmount || paymentAudit.currency !== order.currency ||
              paymentAudit.recordedAt !== evidence.recordedAt || paymentAudit.after?.status !== "paid")
            error("failed-precondition", "Pickup payment audit mismatch.");
        } else if (order.paymentMethod === "stripe") {
          if (evidence.source !== "stripe" || typeof order.paymentIntentId !== "string" || !/^pi_[-\w]+$/.test(order.paymentIntentId) ||
              evidence.paymentIntentId !== order.paymentIntentId || typeof evidence.eventId !== "string" || !/^evt_[-\w]+$/.test(evidence.eventId))
            error("failed-precondition", "Invalid Stripe payment evidence.");
          const binding = (await tx.get(ref("paymentBindings", order.paymentIntentId))).data();
          const event = (await tx.get(ref("stripeEvents", evidence.eventId))).data();
          if (binding?.orderId !== data.orderId || event?.orderId !== data.orderId ||
              !["payment_intent.succeeded", "checkout.session.completed"].includes(event.type) ||
              typeof event.digest !== "string" || !/^[a-f0-9]{64}$/.test(event.digest))
            error("failed-precondition", "Stripe settlement audit mismatch.");
        } else error("failed-precondition", "Unknown payment method.");
      }
      const before = { status: order.status, fulfillmentStatus: order.fulfillmentStatus ?? "uncollected", revision };
      const recordedAt = now();
      const update = { pickupAdminRevision: revision + 1, status: "paid" };
      if (recordPayment) {
        if (order.paymentMethod !== "pickup" || order.status !== "pending")
          error("failed-precondition", "Only pending pickup payment can be declared.");
        update.paidAt = recordedAt;
        update.paymentEvidence = { source: "operator_declaration", actorUid, operationId: data.operationId, recordedAt, totalAmount: order.totalAmount, currency: order.currency };
      }
      if (recordCollection) {
        update.fulfillmentStatus = "collected";
        update.collectionEvidence = { actorUid, operationId: data.operationId, recordedAt };
        update.collectedAt = recordedAt;
      }
      const after = { status: "paid", fulfillmentStatus: update.fulfillmentStatus ?? before.fulfillmentStatus, revision: update.pickupAdminRevision };
      const outcome = { orderId: data.orderId, operationId: data.operationId, action: data.action, ...after, totalAmount: order.totalAmount, currency: order.currency, recordedAt };
      tx.update(orderRef, update);
      tx.set(auditRef, { orderId: data.orderId, operationId: data.operationId, action: data.action, actorUid, requestDigest, before, after, totalAmount: order.totalAmount, currency: order.currency, recordedAt, outcome });
      return outcome;
    });
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
      "marketId",
      "pickupDate",
      "deliveryDate",
      "checkoutUrl",
    ])
      result[key] = o[key] ?? null;
    Object.assign(result, monthlyPickupFields(o));
    result.items = o.items.map((item) =>
      Object.fromEntries(
        ["productId", "name", "quantity", "price", "itemTotal"].map((k) => [
          k,
          item[k],
        ]),
      ),
    );
    if (o.pickupType === "monthly") {
      const windowEnd = o.pickupWindowEndAt;
      const eligible = o.fulfillmentMethod === "market_pickup" && isCalendarDate(o.pickupDate) &&
        ["pending", "confirmed", "ready_for_pickup", "paid"].includes(o.status) &&
        o.marketChangeUsed !== true && !pickupChangeUnsafe(o) &&
        Number.isFinite(windowEnd) && now() <= windowEnd && Number.isSafeInteger(o.pickupRevision ?? 0);
      const options = [];
      if (eligible) {
        let marketDocs = [];
        try { marketDocs = (await db.collection("markets").get()).docs || []; } catch { /* receipt remains available without transfer options */ }
        const latestDate = new Date(Date.parse(`${o.pickupDate}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
        for (const marketSnapshot of marketDocs) {
          const marketId = marketSnapshot.id;
          const market = marketSnapshot.data();
          if (!/^[-\w]{1,100}$/.test(marketId || "") || marketId === o.marketId ||
              typeof market.name !== "string" || !market.name.trim()) continue;
          try {
            if (nextAlternativeDate(market, o.pickupDate, latestDate))
              options.push({ marketId, marketName: market.name.trim() });
          } catch { /* malformed market configuration is not offered to a customer */ }
        }
      }
      result.marketChangeOptions = options;
      result.marketChangeEligible = eligible && options.length > 0;
    }
    return result;
  }
  async function reschedulePickup(data = {}) {
    const fields = ["orderId", "receiptToken", "marketId", "expectedPickupRevision"];
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        Object.keys(data).length !== fields.length || fields.some(key => !Object.hasOwn(data, key)) ||
        typeof data.orderId !== "string" || !/^[a-f0-9]{64}$/.test(data.orderId) ||
        typeof data.receiptToken !== "string" || !/^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/.test(data.receiptToken) ||
        typeof data.marketId !== "string" || !/^[-\w]{1,100}$/.test(data.marketId) ||
        !Number.isSafeInteger(data.expectedPickupRevision) || data.expectedPickupRevision < 0 || data.expectedPickupRevision >= Number.MAX_SAFE_INTEGER)
      error("invalid-argument", "A valid receipt capability, alternative market and pickup revision are required.");
    const orderRef = orderReference(data.orderId);
    const auditRef = ref("pickupRescheduleAudits", data.orderId);
    const targetRef = ref("markets", data.marketId);
    const requestDigest = hash(stable({ orderId: data.orderId, marketId: data.marketId, expectedPickupRevision: data.expectedPickupRevision }));
    return db.runTransaction(async tx => {
      const snapshot = await tx.get(orderRef);
      const auditSnapshot = await tx.get(auditRef);
      if (!snapshot.exists) error("not-found", "Order not found.");
      const order = snapshot.data();
      if (!/^[a-f0-9]{64}$/.test(order.receiptTokenHash || "") || order.receiptRevoked ||
          !Number.isFinite(order.receiptExpiresAt) || order.receiptExpiresAt <= now() ||
          !timingSafeEqual(Buffer.from(hash(data.receiptToken), "hex"), Buffer.from(order.receiptTokenHash, "hex")))
        error("permission-denied", "Invalid or expired receipt.");
      if (auditSnapshot.exists) {
        const audit = auditSnapshot.data();
        if (audit.requestDigest !== requestDigest) error("failed-precondition", "This order already used its one market change.");
        return audit.outcome;
      }
      const revision = order.pickupRevision ?? 0;
      if (order.fulfillmentMethod !== "market_pickup" || order.pickupType !== "monthly")
        error("failed-precondition", "Only eligible one-time monthly pickup orders can be moved.");
      if (!["pending", "confirmed", "ready_for_pickup", "paid"].includes(order.status) ||
          order.marketChangeUsed === true || pickupChangeUnsafe(order))
        error("failed-precondition", "This pickup can no longer be changed.");
      if (!Number.isSafeInteger(revision) || revision !== data.expectedPickupRevision)
        error("failed-precondition", "Pickup details changed; refresh your receipt before trying again.");
      if (!isCalendarDate(order.pickupDate) || !Number.isFinite(order.pickupWindowEndAt) || now() > order.pickupWindowEndAt)
        error("failed-precondition", "The market-change window has closed.");
      if (data.marketId === order.marketId) error("invalid-argument", "Choose a different market.");
      const currentMarketRef = ref("markets", order.marketId);
      const currentMarketSnapshot = await tx.get(currentMarketRef);
      const targetSnapshot = await tx.get(targetRef);
      if (!targetSnapshot.exists || targetSnapshot.data().active === false)
        error("failed-precondition", "Alternative market is not accepting pickup orders.");
      const currentMarket = currentMarketSnapshot.data() || {};
      const targetMarket = targetSnapshot.data();
      const latestDate = new Date(Date.parse(`${order.pickupDate}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
      const pickupDate = nextAlternativeDate(targetMarket, order.pickupDate, latestDate);
      if (!pickupDate) error("failed-precondition", "No eligible alternative market date is available within 7 days.");
      const window = monthlyPickupWindow(targetMarket, pickupDate);
      const reservationCounted = order.pickupReservationCounted === true && targetMarket.capacity > 0;
      if (order.pickupReservationCounted === true) {
        if (!Number.isSafeInteger(currentMarket.reservedCount) || currentMarket.reservedCount < 1)
          error("failed-precondition", "Original market reservation needs owner review.");
        tx.update(currentMarketRef, { reservedCount: currentMarket.reservedCount - 1 });
      }
      if (reservationCounted)
        tx.update(targetRef, { reservedCount: (targetMarket.reservedCount || 0) + 1 });
      const recordedAt = now();
      const outcome = {
        orderId: data.orderId, marketId: data.marketId, marketName: targetMarket.name,
        pickupDate, marketTimezone: window.marketTimezone,
        pickupWindowStartAt: new Date(window.pickupWindowStartAt).toISOString(),
        pickupWindowEndAt: new Date(window.pickupWindowEndAt).toISOString(), pickupRevision: revision + 1,
      };
      tx.update(orderRef, {
        marketId: data.marketId, marketName: targetMarket.name, pickupDate,
        ...window, pickupRevision: revision + 1, marketChangeUsed: true,
        pickupReservationCounted: reservationCounted,
        marketChangeRequestDigest: requestDigest, marketChangedAt: recordedAt,
        emailVersion: (Number.isSafeInteger(order.emailVersion) ? order.emailVersion : 0) + 1,
        emailState: "pending",
      });
      tx.set(auditRef, {
        orderId: data.orderId, requestDigest, fromMarketId: order.marketId,
        toMarketId: data.marketId, fromPickupDate: order.pickupDate,
        toPickupDate: pickupDate, recordedAt, outcome,
      });
      return outcome;
    });
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
      let text =
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
      if (order.pickupType === "monthly") text = pickupEmailCopy(order) || text;
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
  async function getDeliveryQuote() {
    error("failed-precondition", "Delivery is unavailable; choose market pickup.");
  }
  return {
    createPaymentIntent: create,
    createPreorder: (data, context) => create(data, context, true),
    processStripeEvent,
    recordMarketPickupAction,
    reschedulePickup,
    getGuestReceipt,
    revokeGuestReceipt,
    reviewSpecialOrder,
    resumePaymentSetup,
    retryOrderEmail,
    deliverOrderEmail,
    getDeliveryQuote,
  };
};
