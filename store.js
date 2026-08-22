import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js';
import { getFirestore, collection, getDocs, getDoc, doc, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js';

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
const db = getFirestore(app);
const functions = getFunctions(app);

export const DEFAULT_PROMOTION = { brothBundleEnabled: true, bundleMinimum: 4, bundlePriceCents: 2000 };

// --- Firestore Functions ---

export async function getProducts() {
    try {
        const productsCol = collection(db, 'products');
        const snapshot = await getDocs(productsCol);
        const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), price: Number(doc.data().priceCents ?? doc.data().price ?? 0) }));
        if (!products.some(product => product.id === 'mushroom')) {
            products.push({
                id: 'mushroom',
                name: 'Mushroom Broth',
                description: 'A rich five-mushroom umami broth with roasted onion, garlic, celery, and seaweed. Simmered for 12+ hours with lion’s mane, maitake, shiitake, porcini, and oyster mushrooms—deep enough for ramen, grains, sauces, or a warming sip.',
                price: 2200,
                imageUrl: 'assets/MushroomBroth.svg'
            });
        }
        return products.sort((a, b) => Number(a.sortOrder ?? 999) - Number(b.sortOrder ?? 999));
    } catch (e) {
        console.error("Error fetching products:", e);
        return [
          { id: 'beef', name: 'Beef Bone Broth', description: 'Deep, rich, and restorative. 24-hour simmered from grass-fed, grass-finished cattle.', price: 2000, imageUrl: 'assets/BeefBroth.webp' },
          { id: 'chicken', name: 'Chicken Bone Broth', description: 'Clean, light, and versatile. Pasture-raised, corn- and soy-free chicken.', price: 1800, imageUrl: 'assets/ChickenBroth.webp' },
          { id: 'mushroom', name: 'Mushroom Broth', description: 'A rich five-mushroom umami broth with roasted onion, garlic, celery, and seaweed. Simmered for 12+ hours with lion’s mane, maitake, shiitake, porcini, and oyster mushrooms—deep enough for ramen, grains, sauces, or a warming sip.', price: 2200, imageUrl: 'assets/MushroomBroth.svg' }
        ];
    }
}

export async function getMarkets() {
    try {
        const marketsCol = collection(db, 'markets');
        const snapshot = await getDocs(marketsCol);
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => Number(a.sortOrder ?? 999) - Number(b.sortOrder ?? 999));
    } catch (e) {
        console.error("Error fetching markets:", e);
        return [
          { id: 'market_atlantic', name: 'Atlantic Beach Farmers Market · Sunday', weekday: 0, time: '10 AM–2 PM' },
          { id: 'market_palm', name: 'Palm Valley Farmers Market · Tuesday', weekday: 2, time: '9 AM–1 PM' },
          { id: 'market_murray', name: 'Murray Hill Farmers Market · Wednesday', weekday: 3, time: '4 PM–7 PM' },
          { id: 'market_ponte_vedra', name: 'Ponte Vedra Farmers Market · Friday', weekday: 5, time: '10 AM–2 PM' }
        ];
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
export const createPaymentIntent = httpsCallable(functions, 'createPaymentIntent');
export const createPreorder = httpsCallable(functions, 'createPreorder');

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
