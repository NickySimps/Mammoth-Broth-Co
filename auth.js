import { auth, db, authReady } from './store.js';
import { onAuthStateChanged, getIdTokenResult, GoogleAuthProvider, FacebookAuthProvider, OAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js';
import { collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js';

function rememberUser(user) {
  try {
    if (user) localStorage.setItem('mammothUser', JSON.stringify({ uid: user.uid, displayName: user.displayName || user.email?.split('@')[0], email: user.email, provider: user.providerData?.[0]?.providerId || 'password' }));
    else localStorage.removeItem('mammothUser');
  } catch (error) { console.warn('Sign-in display could not be cached.', error); }
  window.dispatchEvent(new CustomEvent('mammoth-auth-changed', { detail: user ? getCurrentUser() : null }));
}

export function getCurrentUser() {
  return auth.currentUser;
}

export function watchUser(callback) {
  return onAuthStateChanged(auth, user => { rememberUser(user); callback(user || null); });
}

export async function signInEmail(email, password, create = false) {
  if (!auth) throw new Error('Firebase Authentication is unavailable. Please try again shortly.');
  const result = create ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password);
  rememberUser(result.user);
  return result.user;
}

export async function signInProvider(providerName) {
  if (!auth) throw new Error('Firebase Authentication is unavailable. Please try again shortly.');
  const provider = providerName === 'google' ? new GoogleAuthProvider() : providerName === 'facebook' ? new FacebookAuthProvider() : new OAuthProvider('apple.com');
  const result = await signInWithPopup(auth, provider);
  rememberUser(result.user);
  return result.user;
}

export async function logout() {
  if (auth) await signOut(auth);
  rememberUser(null);
}

export async function getUserOrders(user = getCurrentUser()) {
  await authReady;
  if (!auth.currentUser || user?.uid !== auth.currentUser.uid) return [];
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
  let local = [];
  try { const saved = JSON.parse(localStorage.getItem('mammothOrders') || '[]'); if (Array.isArray(saved)) local = saved; } catch { /* A damaged local receipt is not an order-history outage. */ }
  return local
    .filter(order => (!uid || (order.customerUid ? order.customerUid === uid : order.customerEmail?.toLowerCase() === email?.toLowerCase())) && (!email || order.customerEmail?.toLowerCase() === email.toLowerCase()))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export async function getAllOrders() {
  await authReady;
  if (!await isAdmin()) throw new Error('Admin access required.');
  const snapshot = await getDocs(collection(db, 'orders'));
  return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
}

export async function isAdmin(user = getCurrentUser()) {
  if (!user) return false;
  const token = await getIdTokenResult(user);
  return token.claims.admin === true;
}
