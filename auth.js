import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, FacebookAuthProvider, OAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';
import { getFirestore, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

const firebaseConfig = {
  // Replace this placeholder and enable providers in Firebase Console for production auth.
  apiKey: 'YOUR_FIREBASE_API_KEY',
  authDomain: 'mammoth-broth-co.firebaseapp.com',
  projectId: 'mammoth-broth-co',
  storageBucket: 'mammoth-broth-co.firebasestorage.app',
  messagingSenderId: '893914225780',
  appId: '1:893914225780:web:e5d6e13da2c32a47438521'
};

let auth;
let db;
try {
  if (firebaseConfig.apiKey !== 'YOUR_FIREBASE_API_KEY') {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  }
} catch (error) {
  console.warn('Firebase auth is not configured yet; demo account mode remains available.', error);
}

export const ADMIN_EMAIL = 'admin@mammothbroth.com';
export const demoOrders = [
  { orderName: 'Golden-Mammoth-24', customerName: 'Maya Rivera', customerEmail: 'maya@example.com', productSummary: '2 × Beef Bone Broth, 1 × Mushroom Broth', marketName: 'Atlantic Beach Farmers Market', pickupDate: 'Sunday, November 23', totalAmount: 5800, status: 'Ready for pickup' },
  { orderName: 'Fierce-Wolf-08', customerName: 'Jordan Lee', customerEmail: 'jordan@example.com', productSummary: '1 × Chicken Bone Broth', marketName: 'Murray Hill Farmers Market', pickupDate: 'Wednesday, November 26', totalAmount: 1800, status: 'Confirmed' },
  { orderName: 'Ancient-Bison-31', customerName: 'Sam Patel', customerEmail: 'sam@example.com', productSummary: '3 × Mushroom Broth', marketName: 'Ponte Vedra Farmers Market', pickupDate: 'Friday, November 28', totalAmount: 6600, status: 'New preorder' }
];

function rememberUser(user) {
  if (user) localStorage.setItem('mammothUser', JSON.stringify({ uid: user.uid, displayName: user.displayName || user.email?.split('@')[0], email: user.email, provider: user.providerData?.[0]?.providerId || 'password' }));
  else localStorage.removeItem('mammothUser');
  window.dispatchEvent(new CustomEvent('mammoth-auth-changed', { detail: user ? getCurrentUser() : null }));
}

export function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem('mammothUser') || 'null'); } catch { return null; }
}

export function watchUser(callback) {
  const cached = getCurrentUser();
  if (cached) callback(cached);
  return auth ? onAuthStateChanged(auth, user => { rememberUser(user); callback(user || null); }) : () => {};
}

export async function signInEmail(email, password, create = false) {
  if (!auth) return demoSignIn(email);
  const result = create ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password);
  rememberUser(result.user);
  return result.user;
}

export async function signInProvider(providerName) {
  if (!auth) return demoSignIn(`${providerName}@demo.mammothbroth.com`, providerName);
  const provider = providerName === 'google' ? new GoogleAuthProvider() : providerName === 'facebook' ? new FacebookAuthProvider() : new OAuthProvider('apple.com');
  const result = await signInWithPopup(auth, provider);
  rememberUser(result.user);
  return result.user;
}

function demoSignIn(email, provider = 'password') {
  const user = { uid: `demo-${email}`, displayName: email.split('@')[0], email, provider };
  rememberUser(user);
  return user;
}

export async function logout() {
  if (auth) await signOut(auth);
  rememberUser(null);
}

export async function getUserOrders(user = getCurrentUser()) {
  const uid = typeof user === 'string' ? null : user?.uid;
  const email = typeof user === 'string' ? user : user?.email;
  if (db && (uid || email)) {
    try {
      const field = uid ? 'customerUid' : 'customerEmail';
      const value = uid || email;
      const snapshot = await getDocs(query(collection(db, 'orders'), where(field, '==', value)));
      if (!snapshot.empty) return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) { console.warn('Could not load Firestore order history; showing local history.', error); }
  }
  return JSON.parse(localStorage.getItem('mammothOrders') || '[]')
    .filter(order => (!uid || (order.customerUid ? order.customerUid === uid : order.customerEmail?.toLowerCase() === email?.toLowerCase())) && (!email || order.customerEmail?.toLowerCase() === email.toLowerCase()))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export async function getAllOrders() {
  if (db) {
    try {
      const snapshot = await getDocs(collection(db, 'orders'));
      if (!snapshot.empty) return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) { console.warn('Could not load the live order queue; showing local orders.', error); }
  }
  const local = JSON.parse(localStorage.getItem('mammothOrders') || '[]');
  return local.length ? local : demoOrders;
}

export function isAdmin(user = getCurrentUser()) { return user?.email === ADMIN_EMAIL || user?.email === 'admin@demo.mammothbroth.com'; }
