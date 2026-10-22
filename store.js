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
export const db = getFirestore(app);
export const auth = getAuth(app);
export const authReady = new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, () => { unsubscribe(); resolve(); }, reject);
});
const functions = getFunctions(app);

export const DEFAULT_PROMOTION = { brothBundleEnabled: true, bundleMinimum: 4, bundlePriceCents: 2000 };

// --- Firestore Functions ---

export async function getProducts() {
    try {
        const productsCol = collection(db, 'products');
        const snapshot = await getDocs(productsCol);
        const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), price: Number(doc.data().priceCents ?? doc.data().price ?? 0) }));
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
    return paymentIntentCallable(data);
}
export async function createPreorder(data) {
    await authReady;
    return preorderCallable(data);
}

// --- Business Logic ---

export async function getPromotionConfig() {
    try {
        const snapshot = await getDoc(doc(db, 'settings', 'promotions'));
        return snapshot.exists() ? { ...DEFAULT_PROMOTION, ...snapshot.data() } : DEFAULT_PROMOTION;
    } catch (e) {
        console.warn('Using local promotion defaults:', e);
        return DEFAULT_PROMOTION;
    }
}

export function calculateCartTotal(cart, products, promotion = DEFAULT_PROMOTION) {
    let brothCount = 0;
    let brothIndividualSum = 0;
    let nonBrothTotal = 0;
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

            // Identify Broth vs Non-Broth
            if (product.name && product.name.toLowerCase().includes('broth')) {
                brothCount += quantity;
                brothIndividualSum += itemTotal;
            } else {
                nonBrothTotal += itemTotal;
            }
        }
    }

    // Apply Bundle Logic
    let brothTotal = 0;
    if (brothCount === 0) {
        brothTotal = 0;
    } else if (promotion.brothBundleEnabled !== false && brothCount >= Number(promotion.bundleMinimum ?? 4)) {
        brothTotal = brothCount * Number(promotion.bundlePriceCents ?? 2000);
    } else {
        brothTotal = brothIndividualSum;
    }

    const finalTotal = brothTotal + nonBrothTotal;
    const regularTotal = brothIndividualSum + nonBrothTotal;
    const savings = regularTotal - finalTotal;

    return {
        items,
        subtotal: regularTotal,
        discount: savings,
        total: finalTotal,
        brothCount
    };
}
