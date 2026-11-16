import { COMMERCE_APP_CHECK_SITE_KEY } from './commerce-config.mjs';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-app-check.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js';
import { getFirestore, collection, getDocs, getDoc, doc, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js';

// IMPORTANT: Replace with your actual Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyCDu1eVuupRSjZ_Y4l5BYLf7n4RNI3OpmA",
  authDomain: "mammoth-broth-co.firebaseapp.com",
  projectId: "mammoth-broth-co",
  storageBucket: "mammoth-broth-co.firebasestorage.app",
  messagingSenderId: "893914225780",
  appId: "1:893914225780:web:e5d6e13da2c32a47438521",
  measurementId: "G-B3J5P98SG5"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
let commerceAppCheck = null;
if (typeof COMMERCE_APP_CHECK_SITE_KEY === 'string' && /^6[A-Za-z0-9_-]{39}$/.test(COMMERCE_APP_CHECK_SITE_KEY)) {
    try {
        commerceAppCheck = initializeAppCheck(app, {
            provider: new ReCaptchaEnterpriseProvider(COMMERCE_APP_CHECK_SITE_KEY),
            isTokenAutoRefreshEnabled: true
        });
    } catch { /* Creation fails closed; catalog and receipt reads stay available. */ }
}
export function isOrderingConfigured() {
    return commerceAppCheck !== null;
}
async function requireCommerceAttestation() {
    if (!commerceAppCheck) throw new Error('Secure ordering is unavailable: App Check is not configured. Please contact us.');
    try {
        const result = await getToken(commerceAppCheck, false);
        if (!result?.token) throw new Error('No attestation');
    } catch {
        throw new Error('Secure ordering is unavailable: App Check verification failed. Please retry or contact us.');
    }
}
export const db = getFirestore(app);
export const auth = getAuth(app);
export const authReady = new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, () => { unsubscribe(); resolve(); }, reject);
});
const functions = getFunctions(app);

export const DEFAULT_PROMOTION = { brothBundleEnabled: true, bundleMinimum: 6, bundlePriceCents: 2000 };

// --- Firestore Functions ---

export async function getProducts() {
    try {
        const productsCol = collection(db, 'products');
        const snapshot = await getDocs(productsCol);
        const products = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id, price: Number(doc.data().priceCents ?? doc.data().price ?? 0) }));
        return products.sort((a, b) => Number(a.sortOrder ?? 999) - Number(b.sortOrder ?? 999));
    } catch (e) {
        console.error("Error fetching products:", e);
        throw e;
    }
}

export async function getMarkets() {
    try {
        const marketsCol = collection(db, 'markets');
        const snapshot = await getDocs(marketsCol);
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => Number(a.sortOrder ?? 999) - Number(b.sortOrder ?? 999));
    } catch (e) {
        console.error("Error fetching markets:", e);
        throw e;
    }
}

export async function saveOrder(order) {
    const ordersCol = collection(db, 'orders');
    const orderWithTimestamp = {
        ...order,
        createdAt: serverTimestamp()
    };
    return addDoc(ordersCol, orderWithTimestamp);
}

// --- Cloud Functions ---
const paymentIntentCallable = httpsCallable(functions, 'createPaymentIntent');
const preorderCallable = httpsCallable(functions, 'createPreorder');
export async function createPaymentIntent(data) {
    await authReady;
    await requireCommerceAttestation();
    try { return await paymentIntentCallable(data); }
    catch { throw new Error('Secure payment setup is unavailable. Retry unchanged details or contact us.'); }
}
export async function createPreorder(data) {
    await authReady;
    await requireCommerceAttestation();
    try { return await preorderCallable(data); }
    catch { throw new Error('Secure order submission is unavailable. Retry unchanged details or contact us.'); }
}

const deliveryQuoteCallable = httpsCallable(functions, 'getDeliveryQuote');
const specialReviewCallable = httpsCallable(functions, 'reviewSpecialOrder');
const retryEmailCallable = httpsCallable(functions, 'retryOrderEmail');
const guestReceiptCallable = httpsCallable(functions, 'getGuestReceipt');
export async function getDeliveryQuote(data) { await authReady; return deliveryQuoteCallable(data); }
export async function reviewSpecialOrder(data) { await authReady; return specialReviewCallable(data); }
export async function retryOrderEmail(data) { await authReady; return retryEmailCallable(data); }
export async function getGuestReceipt(data) { await authReady; return guestReceiptCallable(data); }
// One monthly market change, authorized by the private receipt capability.
// The server alone chooses eligibility, the new date and the pickup window matching market hours.
const reschedulePickupCallable = httpsCallable(functions, 'reschedulePickup');
export async function reschedulePickup({ orderId, receiptToken, marketId, expectedPickupRevision } = {}) {
    await authReady;
    try { return await reschedulePickupCallable({ orderId, receiptToken, marketId, expectedPickupRevision }); }
    catch { throw new Error('Your market change could not be confirmed. Refresh your private receipt or contact us.'); }
}
export async function getDeliveryPolicy() {
    try {
        const snapshot = await getDoc(doc(db, 'settings', 'delivery'));
        return snapshot.exists() ? snapshot.data() : null;
    } catch { return null; } // Missing or denied policy must never enable delivery.
}

// --- Business Logic ---

export async function getPromotionConfig() {
    try {
        const snapshot = await getDoc(doc(db, 'settings', 'promotions'));
        return snapshot.exists() ? snapshot.data() : DEFAULT_PROMOTION;
    } catch (e) {
        console.warn('Promotion unavailable; fixed pickup pricing remains unchanged:', e);
        return { brothBundleEnabled: false };
    }
}

// New pickup orders always use the fixed six-jar/$20 beef-and-chicken offer.
// Legacy callers may still pass promotion metadata, but it is not pricing authority.
export function calculateCartTotal(cart, products) {
    let brothCount = 0;
    let regularTotal = 0;
    let eligibleSavings = 0;
    let items = [];

    for (const productId in cart) {
        const product = products.find(p => p.id === productId);
        if (product) {
            const quantity = cart[productId];
            const itemTotal = product.price * quantity;
            
            items.push({
                productId,
                name: product.name,
                price: product.price,
                quantity,
                itemTotal
            });

            regularTotal += itemTotal;
            // Only canonical catalog IDs qualify, never customer-visible names.
            if (productId === 'prod_beef' || productId === 'prod_chicken' || productId === 'mushroom') {
                brothCount += quantity;
            }
            if (productId === 'prod_beef' || productId === 'prod_chicken') {
                eligibleSavings += Math.max(0, product.price - 2000) * quantity;
            }
        }
    }

    const savings = brothCount >= 6 ? eligibleSavings : 0;
    const finalTotal = regularTotal - savings;

    return {
        items,
        subtotal: regularTotal,
        discount: savings,
        total: finalTotal,
        brothCount
    };
}
