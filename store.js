import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js';
import { getFirestore, collection, getDocs, addDoc } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-functions.js';

// IMPORTANT: Replace with your actual Firebase project configuration
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const functions = getFunctions(app);

// --- Local Data for Development ---
const localProducts = [
    { id: 'prod_beef', name: 'Beef Broth', price: 2000, description: 'Rich and hearty, made from grass-fed beef bones.', imageUrl: 'pics/beefbroth.png' },
    { id: 'prod_chicken', name: 'Chicken Broth', price: 2000, description: 'Light and flavorful, perfect for a nourishing boost.', imageUrl: 'pics/chickenbroth.png' }
];

const localMarkets = [
    { id: 'market_murray', name: 'Murray Hill Farmers Market' },
    { id: 'market_palm', name: 'Palm Valley Farmers Market' },
    { id: 'market_riverside', name: 'Riverside Arts Market' }
];


// --- Firestore Functions ---

export async function getProducts() {
    // Using local data for now
    return Promise.resolve(localProducts);
}

export async function getMarkets() {
    // Using local data for now
    return Promise.resolve(localMarkets);
}

export async function saveOrder(order) {
    const ordersCol = collection(db, 'orders');
    return addDoc(ordersCol, order);
}

// --- Firebase Functions Callable ---

export const createPaymentIntent = (data) => {
    console.log("Creating payment intent with:", data);
    return Promise.resolve({ data: { clientSecret: 'pi_test_client_secret' } });
};