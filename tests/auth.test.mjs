import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadAuth({ claims = {}, email = 'operator@example.com', denied = false, cached = null } = {}) {
  const auth = { currentUser: { uid: 'user-1', email } };
  const callbacks = [];
  const context = vm.createContext({
    console: { warn() {} }, auth, db: {}, authReady: Promise.resolve(),
    getApps: () => [{}], getAuth: () => auth, getFirestore: () => ({}),
    getIdTokenResult: async () => ({ claims }),
    onAuthStateChanged: (instance, callback) => { callbacks.push(callback); return () => {}; },
    collection: () => ({}), query: () => ({}), where: () => ({}),
    getDocs: async () => { if (denied) throw new Error('permission-denied'); return { empty: true, docs: [] }; },
    localStorage: { getItem: key => key === 'mammothUser' ? JSON.stringify(cached) : '[]', setItem() {}, removeItem() {} },
    window: { dispatchEvent() {} }, CustomEvent: class {}
  });
  const source = (await readFile(new URL('../auth.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/export (?=(?:const|async function|function)\b)/g, '');
  vm.runInContext(source, context);
  return { context, auth, callbacks };
}
const listed = await loadAuth({ email: 'admin@mammothbroth.com' });
assert.equal(await listed.context.isAdmin(listed.auth.currentUser), false, 'Email alone cannot grant admin UI access');
const claimed = await loadAuth({ claims: { admin: true } });
assert.equal(await claimed.context.isAdmin(claimed.auth.currentUser), true, 'A real admin custom claim must work regardless of email');
assert.equal((await claimed.context.getAllOrders()).length, 0, 'Empty live queue must stay empty, not become demo orders');
const denied = await loadAuth({ claims: { admin: true }, denied: true });
await assert.rejects(denied.context.getAllOrders(), /permission-denied/, 'Denied operational reads must surface instead of displaying fake orders');
const stale = await loadAuth({ cached: { uid: 'forged', email: 'admin@mammothbroth.com' } });
stale.auth.currentUser = null;
assert.equal(stale.context.getCurrentUser(), null, 'Cached identity is not authenticated identity');
const observed = [];
stale.context.watchUser(user => observed.push(user));
assert.equal(observed.length, 0, 'Wait for authoritative auth state instead of rendering cached accounts');
stale.callbacks[0](null);
assert.equal(observed.length, 1);
assert.equal(observed[0], null);
console.log('auth identity, custom claim, and real queue regression tests passed');
