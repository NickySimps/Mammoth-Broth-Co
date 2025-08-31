const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();

// Configure your email transport
// IMPORTANT: Replace with your own email service provider's details
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'your-email@gmail.com',
        pass: 'your-email-password'
    }
});

exports.sendOrderConfirmationEmail = functions.firestore
    .document('orders/{orderId}')
    .onCreate((snap, context) => {
        const orderData = snap.data();

        // Email to the customer
        const mailOptionsCustomer = {
            from: 'your-email@gmail.com',
            to: orderData.customerEmail,
            subject: 'Your Mammoth Broth Co. Order Confirmation',
            html: `<h1>Thanks for your order, ${orderData.customerName}!</h1>
                   <p>We've received your preorder and will have it ready for you at the ${orderData.marketId}.</p>
                   <p>Order Details:</p>
                   <ul>
                       ${Object.keys(orderData.cart).map(productId => `<li>${productId} x ${orderData.cart[productId]}</li>`).join('')}
                   </ul>`
        };

        // Email to the admin
        const mailOptionsAdmin = {
            from: 'your-email@gmail.com',
            to: 'admin-email@example.com', // Replace with your admin email
            subject: 'New Preorder Received',
            html: `<h1>A new preorder has been placed!</h1>
                   <p>Customer: ${orderData.customerName} (${orderData.customerEmail})</p>
                   <p>Market: ${orderData.marketId}</p>
                   <p>Order Details:</p>
                   <ul>
                        ${Object.keys(orderData.cart).map(productId => `<li>${productId} x ${orderData.cart[productId]}</li>`).join('')}
                   </ul>`
        };

        return Promise.all([transporter.sendMail(mailOptionsCustomer), transporter.sendMail(mailOptionsAdmin)])
            .then(res => console.log('Emails sent successfully'))
            .catch(err => console.error('Error sending emails:', err));
    });
const admin = require("firebase-admin");
const stripe = require("stripe")(functions.config().stripe.secret_key);
const cors = require("cors")({origin: true});

admin.initializeApp();

exports.createPaymentIntent = functions.https.onCall(async (data, context) => {
    const { cart, customerName, customerEmail, marketId } = data;
    const db = admin.firestore();

    try {
        // 1. Calculate total amount from Firestore to prevent client-side manipulation
        let totalAmount = 0;
        const productPromises = Object.keys(cart).map(productId => 
            db.collection('products').doc(productId).get()
        );
        const productSnapshots = await Promise.all(productPromises);

        const orderItems = productSnapshots.map(doc => {
            if (!doc.exists) {
                throw new functions.https.HttpsError('not-found', `Product with ID ${doc.id} not found.`);
            }
            const productData = doc.data();
            const quantity = cart[doc.id];
            totalAmount += productData.price * quantity;
            return { 
                productId: doc.id, 
                name: productData.name, 
                price: productData.price, 
                quantity 
            };
        });

        // 2. Create an order document in Firestore
        const orderRef = await db.collection('orders').add({
            customerName,
            customerEmail,
            marketId,
            items: orderItems,
            totalAmount,
            status: 'created', // Initial status
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 3. Create a Stripe Payment Intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalAmount,
            currency: 'usd',
            receipt_email: customerEmail,
            metadata: { orderId: orderRef.id }
        });

        // 4. Update the order with the Payment Intent ID
        await orderRef.update({ paymentIntentId: paymentIntent.id });

        // 5. Return the client secret to the frontend
        return { clientSecret: paymentIntent.client_secret };

    } catch (error) {
        console.error("Error creating payment intent:", error);
        throw new functions.https.HttpsError('internal', 'Unable to create payment intent', error);
    }
});

exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = functions.config().stripe.webhook_secret;

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
    } catch (err) {
        console.error('Webhook signature verification failed.', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            const orderId = paymentIntent.metadata.orderId;
            
            console.log(`PaymentIntent for ${orderId} was successful!`);

            // Update the order status in Firestore
            await admin.firestore().collection('orders').doc(orderId).update({ 
                status: 'paid',
                paidAt: admin.firestore.FieldValue.serverTimestamp()
            });
            // The Trigger Email extension will handle sending the email from here.
            break;

        case 'payment_intent.payment_failed':
            const failedPaymentIntent = event.data.object;
            const failedOrderId = failedPaymentIntent.metadata.orderId;
            console.log(`Payment failed for order: ${failedOrderId}`);
            await admin.firestore().collection('orders').doc(failedOrderId).update({ 
                status: 'failed',
                failureReason: failedPaymentIntent.last_payment_error?.message
            });
            break;

        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({received: true});
});

