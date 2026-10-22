/* eslint-env node */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require('nodemailer');
const { confirmationEmail, confirmationText } = require('./email-template');
const { createHash } = require('node:crypto');

admin.initializeApp();
const db = admin.firestore();

// Stripe and Mailer configurations
// Set these using: firebase functions:config:set stripe.secret="..." gmail.email="..." gmail.pass="..."
const stripeSecret = (functions.config().stripe && functions.config().stripe.secret) || process.env.STRIPE_SECRET;
const stripe = require("stripe")(stripeSecret || "placeholder_for_deployment");

const gmailEmail = (functions.config().gmail && functions.config().gmail.email) || process.env.GMAIL_EMAIL;
const gmailLoginUser = (functions.config().gmail && functions.config().gmail.login_user) || process.env.GMAIL_LOGIN_USER || gmailEmail;
const gmailPass = (functions.config().gmail && functions.config().gmail.pass) || process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: gmailLoginUser,
        pass: gmailPass
    }
});

function validateReceiving({ cart, fulfillmentMethod = 'market_pickup', marketId, pickupDate, deliveryAddress, specialNotes, paymentMethod }, paymentSetup = false) {
    if (!cart || typeof cart !== 'object' || Array.isArray(cart) || !Object.keys(cart).length) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a cart.');
    }
    const entries = Object.entries(cart);
    if (entries.some(([id, quantity]) => !id || id.includes('/') || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1)) {
        throw new functions.https.HttpsError('invalid-argument', 'Product quantities must be positive whole numbers.');
    }
    const jars = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
    if (jars > 12) throw new functions.https.HttpsError('failed-precondition', 'Maximum order limit is 12 jars per customer.');
    if (!['market_pickup', 'local_delivery', 'special_order'].includes(fulfillmentMethod)) {
        throw new functions.https.HttpsError('invalid-argument', 'Choose a supported fulfillment method.');
    }
    if (fulfillmentMethod === 'market_pickup' && (typeof marketId !== 'string' || !marketId.trim() || marketId.includes('/') || !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate || ''))) {
        throw new functions.https.HttpsError('invalid-argument', 'Market pickup requires a market and pickup date.');
    }
    if (fulfillmentMethod === 'local_delivery' && (jars < 5 || ['street', 'city', 'state', 'zip'].some(field => typeof deliveryAddress?.[field] !== 'string' || !deliveryAddress[field].trim()))) {
        throw new functions.https.HttpsError('failed-precondition', 'Monday local delivery requires 5 jars and a complete address.');
    }
    if (fulfillmentMethod === 'special_order' && (paymentSetup || paymentMethod !== 'special_order')) {
        throw new functions.https.HttpsError('failed-precondition', 'Special orders must be approved before payment.');
    }
    if (fulfillmentMethod === 'special_order' && String(specialNotes || '').trim().length < 10) {
        throw new functions.https.HttpsError('invalid-argument', 'Special orders require notes of at least 10 characters.');
    }
    if (!paymentSetup && ((paymentMethod === 'pickup' && fulfillmentMethod !== 'market_pickup') || (paymentMethod === 'special_order' && fulfillmentMethod !== 'special_order'))) {
        throw new functions.https.HttpsError('invalid-argument', 'That payment method does not match the receiving method.');
    }
}

async function resolveCart(cart, fulfillmentMethod, marketId) {
    const entries = Object.entries(cart);
    const marketRef = fulfillmentMethod === 'market_pickup' ? db.collection('markets').doc(marketId) : null;
    const snapshots = await db.getAll(...(marketRef ? [marketRef] : []), db.collection('settings').doc('promotions'), ...entries.map(([id]) => db.collection('products').doc(id)));
    const marketSnap = marketRef ? snapshots.shift() : null;
    const settingsSnap = snapshots.shift();
    const market = marketSnap?.data() || {};
    if (marketRef && (!marketSnap.exists || market.active === false)) throw new functions.https.HttpsError('failed-precondition', 'That pickup market is not currently accepting orders.');
    if (marketRef && market.orderCutoffAt && Date.now() >= new Date(market.orderCutoffAt).getTime()) throw new functions.https.HttpsError('failed-precondition', 'The order cutoff for that market has passed.');
    if (marketRef && Number(market.capacity || 0) > 0 && Number(market.reservedCount || 0) >= Number(market.capacity)) throw new functions.https.HttpsError('failed-precondition', 'That market is currently full.');
    const items = entries.map(([id, quantity], index) => {
        const snap = snapshots[index];
        if (!snap.exists || snap.data().active === false || snap.data().available === false) throw new functions.https.HttpsError('failed-precondition', `Product ${id} is not currently available.`);
        const product = snap.data();
        const price = Number(product.priceCents ?? product.price);
        if (!Number.isSafeInteger(price) || price <= 0) throw new functions.https.HttpsError('failed-precondition', `Product ${id} has an invalid catalog price.`);
        return { productId: id, name: product.name, price, quantity, itemTotal: price * quantity };
    });
    const promotion = settingsSnap.exists ? settingsSnap.data() : {};
    const brothItems = items.filter(item => /broth/i.test(item.name));
    const brothCount = brothItems.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = items.reduce((sum, item) => sum + item.itemTotal, 0);
    const discount = promotion.brothBundleEnabled !== false && brothCount >= Number(promotion.bundleMinimum ?? 4)
        ? Math.max(0, brothItems.reduce((sum, item) => sum + item.itemTotal, 0) - brothCount * Number(promotion.bundlePriceCents ?? 2000)) : 0;
    const total = subtotal - discount;
    if (!Number.isSafeInteger(total) || total <= 0) throw new functions.https.HttpsError('failed-precondition', 'The catalog total is invalid.');
    return { marketRef, market, items, subtotal, discount, total };
}

exports.createPaymentIntent = functions.https.onCall(async (data, context) => {
    const { cart, fulfillmentMethod = 'market_pickup', marketId } = data || {};
    validateReceiving(data || {}, true);
    const { total } = await resolveCart(cart, fulfillmentMethod, marketId);
    // Create a PaymentIntent with the order amount and currency.
    // Amount is in the smallest currency unit (e.g., cents).
    const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(total),
        currency: "usd",
        automatic_payment_methods: {
            enabled: true,
        },
    });

    return {
        clientSecret: paymentIntent.client_secret,
    };
});

exports.createPreorder = functions.https.onCall(async (data, context) => {
    const { cart, customerName, customerEmail, fulfillmentMethod = 'market_pickup', marketId, pickupDate, deliveryAddress, specialNotes, paymentMethod = 'pickup', paymentIntentId, idempotencyKey, orderName } = data || {};
    if (!cart || !Object.keys(cart).length || !customerName || !customerEmail || !fulfillmentMethod) {
        throw new functions.https.HttpsError('invalid-argument', 'Cart, customer, customer email, and receiving details are required.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
        throw new functions.https.HttpsError('invalid-argument', 'A valid customer email is required.');
    }
    if (paymentMethod !== 'pickup' && paymentMethod !== 'stripe' && paymentMethod !== 'special_order') {
        throw new functions.https.HttpsError('invalid-argument', 'Unsupported payment method.');
    }
    validateReceiving({ ...data, fulfillmentMethod, paymentMethod });
    const { marketRef, market, items, subtotal, discount, total } = await resolveCart(cart, fulfillmentMethod, marketId);
    if (paymentMethod === 'stripe') {
        if (!paymentIntentId) throw new functions.https.HttpsError('invalid-argument', 'A payment confirmation is required.');
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (paymentIntent.status !== 'succeeded' || Number(paymentIntent.amount_received || paymentIntent.amount) !== total || paymentIntent.currency !== 'usd') {
            throw new functions.https.HttpsError('failed-precondition', 'The payment could not be verified.');
        }
    }
    if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 200)) throw new functions.https.HttpsError('invalid-argument', 'Invalid request reference.');
    // The document key is also the transaction's lock: parallel retries cannot create two orders.
    // Payment IDs are globally unique so one paid intent cannot fulfill multiple orders.
    const requestKey = paymentMethod === 'stripe' ? `payment:${paymentIntentId}` : idempotencyKey ? `${String(customerEmail).trim().toLowerCase()}:${idempotencyKey}` : null;
    const orderRef = requestKey ? db.collection('orders').doc(createHash('sha256').update(requestKey).digest('hex')) : db.collection('orders').doc();
    const duplicate = await db.runTransaction(async transaction => {
        const existing = await transaction.get(orderRef);
        if (existing.exists) {
            if (existing.data().customerEmail !== String(customerEmail).trim().toLowerCase()) throw new functions.https.HttpsError('failed-precondition', 'This payment has already been assigned to an order.');
            return true;
        }
        const freshMarket = marketRef ? await transaction.get(marketRef) : null;
        const freshMarketData = freshMarket?.data() || {};
        if (marketRef && (!freshMarket.exists || freshMarketData.active === false)) throw new functions.https.HttpsError('failed-precondition', 'That pickup market is not currently accepting orders.');
        if (marketRef && freshMarketData.orderCutoffAt && Date.now() >= new Date(freshMarketData.orderCutoffAt).getTime()) throw new functions.https.HttpsError('failed-precondition', 'The order cutoff for that market has passed.');
        const capacity = fulfillmentMethod === 'market_pickup' ? Number(freshMarketData.capacity || 0) : 0;
        const reserved = Number(freshMarketData.reservedCount || 0);
        if (capacity > 0 && reserved >= capacity) throw new functions.https.HttpsError('failed-precondition', 'That market is currently full.');
        transaction.set(orderRef, {
            customerUid: context.auth?.uid || null,
            customerName: String(customerName).trim().slice(0, 120),
            customerEmail: String(customerEmail).trim().toLowerCase().slice(0, 200),
            orderName: String(orderName || '').trim().slice(0, 80) || null,
            fulfillmentMethod,
            marketId: marketRef ? marketId : null,
            marketName: market.name || null,
            pickupDate: marketRef ? pickupDate : null,
            deliveryAddress: fulfillmentMethod === 'local_delivery' ? deliveryAddress : null,
            specialNotes: String(specialNotes || '').trim().slice(0, 2000),
            items,
            productSummary: items.map(item => `${item.quantity} × ${item.name}`).join(', '),
            subtotal,
            discountAmount: discount,
            totalAmount: total,
            paymentMethod,
            paymentIntentId: paymentIntentId || null,
            status: paymentMethod === 'special_order' ? 'awaiting_approval' : paymentMethod === 'stripe' ? 'paid' : 'pending',
            idempotencyKey: idempotencyKey || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        if (capacity > 0) transaction.update(marketRef, { reservedCount: reserved + 1 });
        return false;
    });
    return { orderId: orderRef.id, duplicate, totalAmount: total };
});

exports.sendOrderConfirmationEmail = functions.firestore
    .document('orders/{orderId}')
    .onCreate(async (snap, context) => {
        const orderData = snap.data();
        const orderId = context.params.orderId;
        const orderName = orderData.orderName || orderData.orderNumber || `Mammoth-${orderId.slice(0, 8)}`;
        let items = Array.isArray(orderData.items) ? orderData.items : [];

        if (!items.length && orderData.cart) {
            const productSnapshots = await Promise.all(Object.keys(orderData.cart).map(id => db.collection('products').doc(id).get()));
            items = productSnapshots.map(snapshot => {
                const product = snapshot.exists ? snapshot.data() : {};
                const quantity = Number(orderData.cart[snapshot.id] || 0);
                const price = Number(product.priceCents ?? product.price ?? 0);
                return { productId: snapshot.id, name: product.name || `Product ${snapshot.id}`, quantity, price, itemTotal: price * quantity };
            }).filter(item => item.quantity > 0);
        }

        const order = { ...orderData, orderId, orderName, items };
        if (!orderData.orderName) await snap.ref.update({ orderName });
        const sender = gmailEmail;
        const customerMail = {
            from: `"Mammoth Broth Co." <${sender}>`,
            to: order.customerEmail,
            subject: order.fulfillmentMethod === 'special_order' ? `Your Mammoth special-order request ${orderName} was received` : `Your Mammoth preorder ${orderName} was received`,
            html: confirmationEmail(order),
            text: confirmationText(order)
        };
        const operationsMail = {
            from: `"Mammoth Broth Co." <${sender}>`,
            to: sender,
            subject: `New Mammoth preorder ${orderName}`,
            html: confirmationEmail({ ...order, customerName: 'Mammoth team' }),
            text: confirmationText(order)
        };
        try {
            await Promise.all([transporter.sendMail(customerMail), transporter.sendMail(operationsMail)]);
            console.log(`Confirmation emails sent for ${orderName}`);
        } catch (error) {
            console.error('Error sending confirmation emails:', error);
        }
    });
