const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const stripe = require("stripe")(functions.config().stripe.secret);

admin.initializeApp();
const db = admin.firestore();

// --- Helper Function to Calculate Order Amount ---
const calculateOrderAmount = async (cart) => {
  // In a real-world app, you should fetch product prices from a trusted source (e.g., your database) to prevent manipulation.
  return 1400; // For now, a static $14.00. You'll implement the dynamic calculation in the next step.
};
// Configure your email transport
// IMPORTANT: Replace with your own email service provider's details
// It is highly recommended to use environment variables for security.
// Set them using the Firebase CLI:
// firebase functions:config:set gmail.email="your-email@gmail.com" gmail.pass="your-app-password"
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: functions.config().gmail.email,
        pass: functions.config().gmail.pass
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
        const orderData = snap.data();
        const orderId = context.params.orderId;

        // Generate a unique order number
        const orderNumber = `${new Date().getTime()}-${Math.floor(Math.random() * 1000)}`;

        // Update the order with the order number
        await snap.ref.update({ orderNumber });

        // --- Fetch Product Details for Email ---
        const productIds = Object.keys(orderData.cart);
        const productPromises = productIds.map(id => db.collection('products').doc(id).get());
        const productSnapshots = await Promise.all(productPromises);

        const products = {};
        productSnapshots.forEach(doc => {
            if (doc.exists) {
                products[doc.id] = doc.data();
            }
        });

        let total = 0;
        const orderDetailsHtml = Object.entries(orderData.cart).map(([productId, quantity]) => {
            const product = products[productId];
            const itemTotal = (product ? product.price : 0) * quantity;
            total += itemTotal;
            return `<li>${product ? product.name : `Unknown Product (ID: ${productId})`} x ${quantity} - $${itemTotal.toFixed(2)}</li>`;
        }).join('');

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
                    <p><strong>Total: $${total.toFixed(2)}</strong></p>
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
                   <ul style="list-style-type: none; padding: 0;">${orderDetailsHtml}</ul>`
        };

        try {
            await Promise.all([transporter.sendMail(mailOptionsCustomer), transporter.sendMail(mailOptionsAdmin)]);
            console.log('Emails sent successfully');
        } catch (err) {
            console.error('Error sending emails:', err);
        }
    });