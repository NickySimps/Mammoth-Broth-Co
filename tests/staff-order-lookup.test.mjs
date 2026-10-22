import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Keep npm test compatible without changing package.json. Use genuine ES-module
// linking/mocks in an isolated child when this Node version requires the flag.
const test = vm.SourceTextModule ? nodeTest : () => {};
if (!vm.SourceTextModule) {
  nodeTest('staff order lookup ES-module VM suite', () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.match(output, /# fail 0/);
    assert.match(output, /# skipped 0/);
  });
}

const root = new URL('../', import.meta.url);
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function loadStore({ user = null, admin = false, ready = Promise.resolve(), read, claim, cachedOrder } = {}) {
  const context = vm.createContext({ Error, Promise });
  const auth = { currentUser: user };
  const observers = [];
  const reads = [];
  const dependencies = {
    './store.js': { auth, db: { fixture: true }, authReady: ready },
    './auth.js?v=3': { isAdmin: claim || (async () => admin) },
    'https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js': {
      onAuthStateChanged: (_auth, callback) => { observers.push(callback); return () => {}; }
    },
    'https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js': {
      doc: (db, collection, id) => ({ db, collection, id }),
      getDoc: async ref => { reads.push(ref); return cachedOrder || (read ? read(ref) : { exists: () => true, data: () => ({ customerName: 'Fixture', id: 'forged' }) }); },
      getDocFromServer: async ref => { reads.push(ref); return read ? read(ref) : { exists: () => true, data: () => ({ customerName: 'Fixture', id: 'forged' }) }; }
    }
  };
  const module = new vm.SourceTextModule(await readFile(new URL('staff-store.mjs', root), 'utf8'), { context });
  await module.link(specifier => {
    const values = dependencies[specifier];
    assert.ok(values, `Unexpected store dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  await module.evaluate();
  return { get: module.namespace.getStaffOrder, reads, auth, change(next) { auth.currentUser = next; observers.forEach(callback => callback(next)); } };
}

test('rejects malformed document IDs before reading', async () => {
  const user = { uid: 'staff' };
  const store = await loadStore({ user, admin: true });
  for (const id of [undefined, '', '../other', 'a/b', 'a b', 'a'.repeat(129), 123, 'order?token=x', 'order\n', 'order\r']) {
    await assert.rejects(store.get(id, user));
  }
  assert.equal(store.reads.length, 0);
});

test('non-admin and wrong-user lookups perform zero document reads', async () => {
  const user = { uid: 'staff' };
  const store = await loadStore({ user });
  await assert.rejects(store.get('exact-order', user));
  await assert.rejects(store.get('exact-order', { uid: 'other' }));
  assert.equal(store.reads.length, 0);
});

test('authorized staff reads exactly the requested document and preserves authoritative ID', async () => {
  const user = { uid: 'staff' };
  const store = await loadStore({ user, admin: true });
  const order = await store.get('Exact_order-42', user);
  assert.equal(order.id, 'Exact_order-42');
  assert.equal(store.reads.length, 1);
  assert.equal(store.reads[0].collection, 'orders');
  assert.equal(store.reads[0].id, 'Exact_order-42');
});

test('staff lookup requires a fresh server response even when a cached paid order exists', async () => {
  const user = { uid: 'staff' };
  const store = await loadStore({ user, admin: true,
    cachedOrder: { exists: () => true, data: () => ({ status: 'paid' }) },
    read: async () => { throw new Error('Server unavailable'); }
  });
  await assert.rejects(store.get('exact-order', user), /Server unavailable/);
  assert.equal(store.reads.length, 1);
});

test('waits for auth readiness and rejects changes before any read', async () => {
  const user = { uid: 'staff' };
  const ready = deferred();
  const store = await loadStore({ user, admin: true, ready: ready.promise });
  const pending = store.get('exact-order', user);
  assert.equal(store.reads.length, 0);
  store.change(null);
  ready.resolve();
  await assert.rejects(pending);
  assert.equal(store.reads.length, 0);
});

test('sign-out during claim check prevents reading', async () => {
  const user = { uid: 'staff' };
  const claim = deferred();
  const store = await loadStore({ user, claim: () => claim.promise });
  const pending = store.get('exact-order', user);
  await tick();
  store.change(null);
  claim.resolve(true);
  await assert.rejects(pending);
  assert.equal(store.reads.length, 0);
});

test('late document response is rejected even after signing back into same user', async () => {
  const user = { uid: 'staff' };
  const response = deferred();
  const store = await loadStore({ user, admin: true, read: () => response.promise });
  const pending = store.get('exact-order', user);
  await tick();
  store.change(null);
  store.change(user);
  response.resolve({ exists: () => true, data: () => ({ customerName: 'Private' }) });
  await assert.rejects(pending);
  assert.equal(store.reads.length, 1);
});

test('not-found returns no order, denied requests never fall back to a collection', async () => {
  const user = { uid: 'staff' };
  const missing = await loadStore({ user, admin: true, read: async () => ({ exists: () => false }) });
  assert.equal(await missing.get('exact-order', user), null);
  assert.equal(missing.reads.length, 1);
  const denied = await loadStore({ user, admin: true, read: async () => { throw new Error('permission-denied'); } });
  await assert.rejects(denied.get('exact-order', user));
  assert.equal(denied.reads.length, 1);
});

async function loadUI({ admin = true, read = async id => ({ id, customerName: 'Private Customer', customerEmail: 'private@example.test', items: [], status: 'paid', totalAmount: 2500 }) } = {}) {
  const nodes = new Map();
  function element() {
    return { hidden: false, textContent: '', value: '', disabled: false, children: [], listeners: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; this.textContent = ''; },
      addEventListener(type, callback) { this.listeners[type] = callback; }
    };
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const auth = { currentUser: null };
  let observer;
  const calls = [];
  const signins = [];
  const listeners = {};
  const location = { hash: '#order=exact-order' };
  const context = vm.createContext({ URL, URLSearchParams, Intl, location,
    window: { addEventListener(type, callback) { listeners[type] = callback; } },
    document: { getElementById: node, createElement: element }
  });
  const dependencies = {
    './store.js': { auth },
    './auth.js?v=3': {
      watchUser: callback => { observer = callback; return () => {}; },
      isAdmin: async () => admin,
      signInEmail: async (...args) => { signins.push(args); },
      signInProvider: async provider => { signins.push([provider]); },
      logout: async () => { auth.currentUser = null; observer(null); }
    },
    './staff-store.mjs': { getStaffOrder: async (...args) => { calls.push(args); return read(...args); } }
  };
  const module = new vm.SourceTextModule(await readFile(new URL('staff.mjs', root), 'utf8'), { context });
  await module.link(async specifier => {
    if (specifier === './order-lookup.mjs') return new vm.SourceTextModule(await readFile(new URL('order-lookup.mjs', root), 'utf8'), { context });
    const values = dependencies[specifier];
    assert.ok(values, `Unexpected UI dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  await module.evaluate();
  return { node, calls, signins, async change(user) { auth.currentUser = user; observer(user); await tick(); },
    changeNow(user) { auth.currentUser = user; observer(user); },
    async hash(hash) { location.hash = hash; listeners.hashchange(); await tick(); },
    text() { const collect = item => [item.textContent, ...item.children.map(collect)].join('\n'); return collect(node('order-details')); }
  };
}

test('UI signed-out and non-admin sessions never load or render customer details', async () => {
  const ui = await loadUI({ admin: false });
  await ui.change(null);
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.text().trim(), '');
  await ui.change({ uid: 'not-staff' });
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.node('order-card').hidden, true);
  assert.match(ui.node('lookup-status').textContent, /staff|access|authorized/i);
});

test('UI renders exact order safely, excludes receipt and provider secrets', async () => {
  const ui = await loadUI({ read: async id => ({ id, customerName: '<img onerror=alert(1)>', customerEmail: 'customer@example.test', items: [{ name: '<script>bad</script>', quantity: 2 }], totalAmount: 2500, paymentMethod: 'pickup', status: 'pending', fulfillmentMethod: 'market_pickup', marketName: 'Market', pickupDate: '2026-11-01', receiptToken: 'TOP_SECRET', receiptTokenHash: 'HASH_SECRET', checkoutUrl: 'https://checkout.stripe.com/SECRET' }) });
  await ui.change({ uid: 'staff' });
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0][0], 'exact-order');
  assert.equal(ui.node('order-card').hidden, false);
  const text = ui.text();
  for (const value of ['exact-order', '<img onerror=alert(1)>', 'customer@example.test', '2 × <script>bad</script>', '$25.00', 'Market', '2026-11-01']) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /TOP_SECRET|HASH_SECRET|checkout.stripe.com/);
});

test('UI clears details synchronously on identity change and rejects late responses', async () => {
  const response = deferred();
  const ui = await loadUI({ read: () => response.promise });
  const user = { uid: 'staff' };
  await ui.change(user);
  assert.equal(ui.calls.length, 1);
  ui.changeNow(null);
  assert.equal(ui.node('order-card').hidden, true);
  assert.equal(ui.text().trim(), '');
  response.resolve({ id: 'exact-order', customerName: 'Late private data', items: [] });
  await tick();
  assert.equal(ui.text().trim(), '');
  assert.equal(ui.node('order-card').hidden, true);
});

test('UI removes already displayed details immediately on identity change', async () => {
  const ui = await loadUI();
  await ui.change({ uid: 'staff' });
  assert.match(ui.text(), /Private Customer/);
  ui.changeNow({ uid: 'replacement' });
  assert.equal(ui.text().trim(), '');
  assert.equal(ui.node('order-card').hidden, true);
});

test('UI malformed or missing locators never read; not-found and denied show no order', async () => {
  for (const hash of ['', '#order=', '#order=one&order=two', '#order=one&token=secret', '#order=../bad']) {
    const ui = await loadUI();
    await ui.hash(hash);
    await ui.change({ uid: 'staff' });
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.text().trim(), '');
    assert.match(ui.node('lookup-status').textContent, /missing|invalid|scan/i);
  }
  for (const read of [async () => null, async () => { throw new Error('secret backend diagnostic'); }]) {
    const ui = await loadUI({ read });
    await ui.change({ uid: 'staff' });
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.text().trim(), '');
    assert.equal(ui.node('order-card').hidden, true);
    assert.doesNotMatch(ui.node('lookup-status').textContent, /secret backend diagnostic/);
  }
});

test('UI warns on cancelled, refunded, review-required orders without promising fulfillment', async () => {
  for (const status of ['cancelled', 'refunded', 'paid_requires_review']) {
    const ui = await loadUI({ read: async id => ({ id, status, items: [], paymentMethod: 'stripe', marketName: 'Market' }) });
    await ui.change({ uid: 'staff' });
    assert.match(ui.node('order-warning').textContent, /do not fulfill|not confirmed/i);
    assert.equal(ui.node('order-warning').hidden, false);
    if (status === 'paid_requires_review') assert.match(ui.text(), /payment received/i);
  }
});

test('email and Google sign-in use existing helpers and immediately clear password', async () => {
  const ui = await loadUI();
  ui.node('staff-email').value = ' staff@example.test ';
  ui.node('staff-password').value = 'fixture-password';
  const pending = ui.node('staff-signin').listeners.submit({ preventDefault() {} });
  assert.equal(ui.node('staff-password').value, '');
  await pending;
  assert.deepEqual(ui.signins[0], ['staff@example.test', 'fixture-password']);
  await ui.node('google-signin').listeners.click();
  assert.deepEqual(ui.signins[1], ['google']);
});

test('staff page is private, accessible, standalone and has no write controls', async () => {
  const html = await readFile(new URL('staff.html', root), 'utf8');
  assert.match(html, /name="robots" content="noindex, nofollow, noarchive"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  for (const id of ['staff-email', 'staff-password']) {
    assert.ok(html.includes(`for="${id}"`));
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.match(html, /<form id="staff-signin" method="post">/);
  assert.match(html, /<fieldset id="staff-credentials" disabled>/);
  assert.match(html, /id="google-signin"[^>]*disabled/);
  assert.match(html, /id="order-card"[^>]*hidden/);
  assert.match(html, /id="lookup-status"[^>]*role="status"/);
  assert.match(html, /type="module" src="\.\/staff\.mjs"/);
  assert.doesNotMatch(html, /https?:\/\/|mark.?paid|mark.?fulfilled|qrcode/i);
  const source = await readFile(new URL('staff.mjs', root), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|console\./);
  assert.match(source, /readStaffOrder\(location\.hash\)/);
  const css = await readFile(new URL('staff.css', root), 'utf8');
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\[hidden\]/);
});

test('signed-out lookup refuses access with zero document reads', async () => {
  const store = await loadStore();
  await assert.rejects(store.get('exact-order', null));
  assert.equal(store.reads.length, 0);
});
