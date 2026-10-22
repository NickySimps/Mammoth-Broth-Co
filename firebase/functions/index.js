/* eslint-env node */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require('nodemailer');
const { confirmationEmail, confirmationText } = require('./email-template');

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

exports.createPaymentIntent = functions.https.onCall(async (data, context) => {
    const { cart, fulfillmentMethod, marketId, pickupDate, deliveryAddress, specialNotes } = data || {};

    if (!cart || Object.keys(cart).length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a cart.');
    }
    const totalJars = Object.values(cart).reduce((sum, quantity) => sum + Number(quantity || 0), 0);
    if (!Number.isInteger(totalJars) || totalJars < 1 || totalJars > 12) {
        throw new functions.https.HttpsError('failed-precondition', 'Orders must contain between 1 and 12 jars.');
    }
    if (fulfillmentMethod === 'market_pickup' && (!marketId || !pickupDate)) {
        throw new functions.https.HttpsError('invalid-argument', 'Market pickup requires a market and pickup date.');
    }
    if (fulfillmentMethod === 'local_delivery') {
        if (totalJars < 5) throw new functions.https.HttpsError('failed-precondition', 'Monday local delivery requires at least 5 jars.');
        if (!deliveryAddress?.street || !deliveryAddress?.city || !deliveryAddress?.state || !deliveryAddress?.zip) {
            throw new functions.https.HttpsError('invalid-argument', 'A complete delivery address is required.');
        }
    }
    if (fulfillmentMethod === 'special_order') {
        throw new functions.https.HttpsError('failed-precondition', 'Special orders must be approved before payment.');
    }

    // --- Securely calculate the total amount on the server ---
    const productIds = Object.keys(cart);
    const productPromises = productIds.map(id => db.collection('products').doc(id).get());
    const productSnapshots = await Promise.all(productPromises);

    let brothCount = 0;
    let brothIndividualSum = 0;
    let nonBrothTotal = 0;

    productSnapshots.forEach(doc => {
        if (doc.exists) {
            const product = doc.data();
            const quantity = cart[doc.id];
            
            // Check if it's a broth product for bundling
            if (product.name && product.name.toLowerCase().includes('broth')) {
                brothCount += quantity;
                brothIndividualSum += product.price * quantity;
            } else {
                nonBrothTotal += product.price * quantity;
            }
        } else {
            throw new functions.https.HttpsError('invalid-argument', `Product ${doc.id} was not found.`);
        }
    });

    if (brothCount > 12) {
        throw new functions.https.HttpsError('failed-precondition', 'Maximum order limit is 12 jars per customer.');
    }

    let brothTotal = 0;
    if (brothCount === 0) {
        brothTotal = 0;
    } else if (brothCount > 3) {
        brothTotal = brothCount * 2000; // $20.00 per jar for > 3 jars
    } else {
        brothTotal = brothIndividualSum;
    }

    const total = brothTotal + nonBrothTotal;

    if (total === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Cannot process an order with a total of 0.');
    }

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
    const totalJars = Object.values(cart).reduce((sum, quantity) => sum + Number(quantity || 0), 0);
    if (fulfillmentMethod === 'market_pickup' && (!marketId || !pickupDate)) {
        throw new functions.https.HttpsError('invalid-argument', 'Market pickup requires a market and pickup date.');
    }
    if (fulfillmentMethod === 'local_delivery' && (totalJars < 5 || !deliveryAddress?.street || !deliveryAddress?.city || !deliveryAddress?.state || !deliveryAddress?.zip)) {
        throw new functions.https.HttpsError('failed-precondition', 'Monday local delivery requires 5 jars and a complete address.');
    }
    if (fulfillmentMethod === 'special_order' && String(specialNotes || '').trim().length < 10) {
        throw new functions.https.HttpsError('invalid-argument', 'Special orders require notes of at least 10 characters.');
    }
    if (fulfillmentMethod === 'special_order' && paymentMethod !== 'special_order') {
        throw new functions.https.HttpsError('failed-precondition', 'Special orders must be approved before payment.');
    }
    const productEntries = Object.entries(cart).map(([id, quantity]) => ({ id, quantity: Number(quantity) }));
    if (productEntries.some(item => !Number.isInteger(item.quantity) || item.quantity < 1)) {
        throw new functions.https.HttpsError('invalid-argument', 'Product quantities must be positive whole numbers.');
    }
    if (productEntries.reduce((sum, item) => sum + item.quantity, 0) > 12) {
        throw new functions.https.HttpsError('failed-precondition', 'Maximum order limit is 12 jars per customer.');
    }
    const marketRef = marketId ? db.collection('markets').doc(marketId) : null;
    const settingsRef = db.collection('settings').doc('promotions');
    const productRefs = productEntries.map(item => db.collection('products').doc(item.id));
    const snapshots = await db.getAll(...(marketRef ? [marketRef] : []), settingsRef, ...productRefs);
    const marketSnap = marketRef ? snapshots.shift() : null;
    const settingsSnap = snapshots.shift();
    const productSnaps = snapshots;
    if (fulfillmentMethod === 'market_pickup' && (!marketSnap?.exists || marketSnap.data().active === false)) {
        throw new functions.https.HttpsError('failed-precondition', 'That pickup market is not currently accepting orders.');
    }
    const market = marketSnap?.data() || {};
    const cutoff = fulfillmentMethod === 'market_pickup' && market.orderCutoffAt ? new Date(market.orderCutoffAt) : null;
    if (cutoff && Number.isFinite(cutoff.getTime()) && Date.now() >= cutoff.getTime()) {
        throw new functions.https.HttpsError('failed-precondition', 'The order cutoff for that market has passed.');
    }
    const products = productEntries.map((entry, index) => {
        const snap = productSnaps[index];
        if (!snap.exists || snap.data().active === false || snap.data().available === false) {
            throw new functions.https.HttpsError('failed-precondition', `Product ${entry.id} is not currently available.`);
        }
        return { ...entry, data: snap.data() };
    });
    const promotion = settingsSnap.exists ? settingsSnap.data() : { brothBundleEnabled: true, bundleMinimum: 4, bundlePriceCents: 2000 };
    const items = products.map(item => ({ productId: item.id, name: item.data.name, price: Number(item.data.priceCents ?? item.data.price ?? 0), quantity: item.quantity, itemTotal: Number(item.data.priceCents ?? item.data.price ?? 0) * item.quantity }));
    const brothItems = items.filter(item => /broth/i.test(item.name));
    const brothCount = brothItems.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = items.reduce((sum, item) => sum + item.itemTotal, 0);
    const bundlePrice = Number(promotion.bundlePriceCents ?? 2000);
    const discount = promotion.brothBundleEnabled !== false && brothCount >= Number(promotion.bundleMinimum ?? 4)
        ? Math.max(0, brothItems.reduce((sum, item) => sum + item.itemTotal, 0) - brothCount * bundlePrice)
        : 0;
    const total = subtotal - discount;
    if (!total) throw new functions.https.HttpsError('invalid-argument', 'Cannot process an order with a total of 0.');
    if (paymentMethod === 'stripe') {
        if (!paymentIntentId) throw new functions.https.HttpsError('invalid-argument', 'A payment confirmation is required.');
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (paymentIntent.status !== 'succeeded' || Number(paymentIntent.amount_received || paymentIntent.amount) !== total || paymentIntent.currency !== 'usd') {
            throw new functions.https.HttpsError('failed-precondition', 'The payment could not be verified.');
        }
    }
    const orderQuery = idempotencyKey ? await db.collection('orders').where('idempotencyKey', '==', idempotencyKey).limit(1).get() : null;
    if (orderQuery && !orderQuery.empty) return { orderId: orderQuery.docs[0].id, duplicate: true };
    const orderRef = db.collection('orders').doc();
    await db.runTransaction(async transaction => {
        const freshMarket = marketRef ? await transaction.get(marketRef) : null;
        const freshMarketData = freshMarket?.data() || {};
        const capacity = fulfillmentMethod === 'market_pickup' ? Number(freshMarketData.capacity || 0) : 0;
        const reserved = Number(freshMarketData.reservedCount || 0);
        if (capacity > 0 && reserved >= capacity) throw new functions.https.HttpsError('failed-precondition', 'That market is currently full.');
        transaction.set(orderRef, {
            customerUid: context.auth?.uid || null,
            customerName: String(customerName).trim().slice(0, 120),
            customerEmail: String(customerEmail).trim().toLowerCase().slice(0, 200),
            orderName: String(orderName || '').trim().slice(0, 80) || null,
            fulfillmentMethod,
            marketId: marketId || null,
            marketName: market.name || null,
            pickupDate: pickupDate || null,
            deliveryAddress: deliveryAddress || null,
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
    });
    return { orderId: orderRef.id, duplicate: false, totalAmount: total };
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
        const sender = functions.config().gmail.email;
        const customerMail = {
            from: `"Mammoth Broth Co." <${sender}>`,
            to: order.customerEmail,
            subject: `Your Mammoth preorder ${orderName} is reserved`,
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
