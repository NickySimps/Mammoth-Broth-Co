import { auth, db, authReady } from './store.js';
import { isAdmin } from './auth.js?v=3';
import { doc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js';

// Fence even a sign-out/sign-in cycle that returns to the same user object.
let identity = auth.currentUser;
let generation = 0;
onAuthStateChanged(auth, user => {
  if (user !== identity) { identity = user; generation += 1; }
});

// Exact-document only. The existing Firestore rules remain the authority.
export async function getStaffOrder(orderId, user) {
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
    throw new Error('Invalid order reference.');
  }
  const session = generation;
  const requireCurrent = () => {
    if (!user?.uid || auth.currentUser !== user || session !== generation) {
      throw new Error('Staff session changed. Sign in again.');
    }
  };
  requireCurrent();
  await authReady;
  requireCurrent();
  if (!await isAdmin(user)) throw new Error('Staff access required.');
  requireCurrent();
  const snapshot = await getDocFromServer(doc(db, 'orders', orderId));
  requireCurrent();
  return snapshot.exists() ? { ...snapshot.data(), id: orderId } : null;
}
