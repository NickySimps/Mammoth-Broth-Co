/* eslint-env node */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// Stripe and Mailer configurations
// Set these using: firebase functions:config:set stripe.secret="..." gmail.email="..." gmail.pass="..."
const stripeSecret = (functions.config().stripe && functions.config().stripe.secret) || process.env.STRIPE_SECRET;
const stripe = require("stripe")(stripeSecret || "placeholder_for_deployment");

const gmailEmail = (functions.config().gmail && functions.config().gmail.email) || process.env.GMAIL_EMAIL;
const gmailPass = (functions.config().gmail && functions.config().gmail.pass) || process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: gmailEmail,
        pass: gmailPass
    }
});

exports.createPaymentIntent = functions.https.onCall(async (data, context) => {
    const { cart } = data;

    if (!cart || Object.keys(cart).length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a cart.');
    }

    // --- Securely calculate the total amount on the server ---
    const productIds = Object.keys(cart);
    const productPromises = productIds.map(id => db.collection('products').doc(id).get());
    const productSnapshots = await Promise.all(productPromises);

    let total = 0;
    productSnapshots.forEach(doc => {
        if (doc.exists) {
            const product = doc.data();
            const quantity = cart[doc.id];
            total += product.price * quantity;
        } else {
            // Handle cases where a product might not exist
            console.warn(`Product with ID ${doc.id} not found in database.`);
        }
    });

    if (total === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Cannot process an order with a total of 0.');
    }

    // Create a PaymentIntent with the order amount and currency.
    // Amount is in the smallest currency unit (e.g., cents).
    const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(total * 100),
        currency: "usd",
        automatic_payment_methods: {
            enabled: true,
        },
    });

    return {
        clientSecret: paymentIntent.client_secret,
    };
});

exports.sendOrderConfirmationEmail = functions.firestore
    .document('orders/{orderId}')
    .onCreate(async (snap, context) => {
        console.log("sendOrderConfirmationEmail triggered");
        const orderData = snap.data();
        const orderId = context.params.orderId;
        console.log(`Processing order: ${orderId}`);

        // Use the fun orderName if available, otherwise generate a timestamp ID
        const orderNumber = orderData.orderName || `${new Date().getTime()}-${Math.floor(Math.random() * 1000)}`;

        // If we generated it (and it wasn't a fun name), update the doc
        if (!orderData.orderName && !orderData.orderNumber) {
            await snap.ref.update({ orderNumber });
        }

        let orderDetailsHtml = '';
        let totalDisplay = '0.00';

        // Check for new 'items' structure
        if (orderData.items && Array.isArray(orderData.items)) {
            orderDetailsHtml = orderData.items.map(item => {
                // itemTotal is in cents
                const price = (item.itemTotal / 100).toFixed(2);
                return `<li>${item.name} x ${item.quantity} - $${price}</li>`;
            }).join('');
            
            if (orderData.totalAmount) {
                totalDisplay = (orderData.totalAmount / 100).toFixed(2);
            }
        } else {
            // --- Fallback: Fetch Product Details for Old Structure ---
            console.log("Using fallback logic for old order structure");
            const productIds = Object.keys(orderData.cart || {});
            const productPromises = productIds.map(id => db.collection('products').doc(id).get());
            const productSnapshots = await Promise.all(productPromises);

            const products = {};
            productSnapshots.forEach(doc => {
                if (doc.exists) {
                    products[doc.id] = doc.data();
                }
            });

            let total = 0;
            orderDetailsHtml = Object.entries(orderData.cart || {}).map(([productId, quantity]) => {
                const product = products[productId];
                const itemTotal = (product ? product.price : 0) * quantity;
                total += itemTotal;
                return `<li>${product ? product.name : `Unknown Product (ID: ${productId})`} x ${quantity} - $${(itemTotal/100).toFixed(2)}</li>`;
            }).join('');
            
            totalDisplay = (total / 100).toFixed(2);
        }

        // Email to the customer
        const mailOptionsCustomer = {
            from: `"Mammoth Broth Co." <${functions.config().gmail.email}>`,
            to: orderData.customerEmail,
            subject: `Your Mammoth Broth Co. Order Confirmation #${orderNumber}`,
            html: `<h1>Thanks for your order, ${orderData.customerName}!</h1>
                   <p>Your order number is: <strong>${orderNumber}</strong></p>
                   <p>We've received your preorder and will have it ready for you at the ${orderData.marketId}.</p>
                   <p>Order Details:</p>
                    <ul style="list-style-type: none; padding: 0;">${orderDetailsHtml}</ul>
                    <p><strong>Total: $${totalDisplay}</strong></p>
                    <p>Payment Method: ${orderData.paymentMethod === 'pickup' ? 'Pay at Pickup' : 'Paid Online'}</p>
                   `
        };

        // Email to the admin
        const mailOptionsAdmin = {
            from: `"Mammoth Broth Co." <${functions.config().gmail.email}>`,
            to: functions.config().gmail.email, // Sending to yourself as admin
            subject: `New Preorder Received #${orderNumber}`,
            html: `<h1>A new preorder has been placed!</h1>
                   <p>Order number: <strong>${orderNumber}</strong></p>
                   <p>Customer: ${orderData.customerName} (${orderData.customerEmail})</p>
                   <p>Market: ${orderData.marketId}</p>
                   <p>Order Details:</p>
                   <ul style="list-style-type: none; padding: 0;">${orderDetailsHtml}</ul>
                   <p><strong>Total: $${totalDisplay}</strong></p>`
        };

        try {
            await Promise.all([transporter.sendMail(mailOptionsCustomer), transporter.sendMail(mailOptionsAdmin)]);
            console.log('Emails sent successfully');
        } catch (err) {
            console.error('Error sending emails:', err);
        }
    });