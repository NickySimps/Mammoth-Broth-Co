import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../store.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export (?=(?:const|async function|function)\b)/g, '');

function loadStore({ records = [], promotion, promotionExists = true, denied = false } = {}) {
    const context = vm.createContext({
        COMMERCE_APP_CHECK_SITE_KEY: '',
        console: { warn() {}, error() {} },
        initializeApp: () => ({}), getFirestore: () => ({}), getAuth: () => ({}),
        getFunctions: () => ({}), onAuthStateChanged: () => () => {},
        httpsCallable: () => async () => { throw new Error('No network in pricing tests'); },
        collection: (_db, name) => name, doc: (_db, name, id) => `${name}/${id}`,
        getDocs: async () => {
            if (denied) throw new Error('permission-denied');
            return { docs: records.map(({ id, data }) => ({ id, data: () => data })) };
        },
        getDoc: async () => {
            if (denied) throw new Error('permission-denied');
            return { exists: () => promotionExists, data: () => promotion };
        },
    });
    vm.runInContext(source, context);
    return context;
}

const products = [
    { id: 'prod_beef', name: 'Beef Broth', price: 2500 },
    { id: 'prod_chicken', name: 'Chicken Broth', price: 2500 },
    { id: 'mushroom', name: 'Mushroom Broth', price: 4000 },
];

test('six mixed pickup jars discount beef/chicken only; mushroom counts but stays full price', () => {
    const result = loadStore().calculateCartTotal({ prod_beef: 2, prod_chicken: 2, mushroom: 2 }, products);
    assert.equal(result.subtotal, 18000);
    assert.equal(result.total, 16000);
    assert.equal(result.discount, 2000);
    assert.equal(result.brothCount, 6);
});

test('malformed promotion amounts cannot override the fixed six-jar offer', () => {
    const result = loadStore().calculateCartTotal({ prod_beef: 6 }, products,
        { brothBundleEnabled: true, bundlePriceCents: 100001 });
    assert.equal(result.discount, 3000);
    assert.equal(result.total, 12000);
});

test('catalog document IDs remain authoritative over embedded id fields and prices stay catalog supplied', async () => {
    const store = loadStore({ records: [
        { id: 'mushroom', data: { id: 'prod_beef', name: 'Beef Broth', priceCents: 4100, price: 1 } },
    ] });
    const catalog = await store.getProducts();
    assert.equal(catalog[0].id, 'mushroom');
    assert.equal(catalog[0].price, 4100);
    assert.equal(store.calculateCartTotal({ mushroom: 6 }, catalog).total, 24600);
});

test('every one-to-twelve jar mix uses the same fixed six-jar terms despite stale settings', () => {
    const store = loadStore();
    const policies = [undefined, {}, { brothBundleEnabled: true },
        { brothBundleEnabled: true, bundleMinimum: 4, bundlePriceCents: 1800 },
        { bundleMinimum: 1, bundlePriceCents: 1 },
        { bundleMinimum: 12, bundlePriceCents: 100000 }];
    let mixes = 0;
    for (let beef = 0; beef <= 12; beef++) {
        for (let chicken = 0; chicken <= 12 - beef; chicken++) {
            for (let mushroom = 0; mushroom <= 12 - beef - chicken; mushroom++) {
                const count = beef + chicken + mushroom;
                if (!count) continue;
                mixes++;
                const cart = Object.fromEntries(Object.entries({ prod_beef: beef, prod_chicken: chicken, mushroom })
                    .filter(([, quantity]) => quantity > 0));
                const before = JSON.stringify({ cart, products });
                for (const policy of policies) {
                    const result = store.calculateCartTotal(cart, products, policy);
                    const subtotal = (beef + chicken) * 2500 + mushroom * 4000;
                    const discount = count >= 6 ? (beef + chicken) * 500 : 0;
                    const label = JSON.stringify({ cart, policy });
                    assert.equal(result.subtotal, subtotal, label);
                    assert.equal(result.discount, discount, label);
                    assert.equal(result.total, subtotal - discount, label);
                    assert.equal(result.brothCount, count, label);
                    assert.equal(result.items.reduce((sum, item) => sum + item.itemTotal, 0), subtotal, label);
                }
                assert.equal(JSON.stringify({ cart, products }), before, 'Pricing must not mutate the cart/catalog');
            }
        }
    }
    assert.equal(mixes, 454);
});

test('canonical IDs qualify regardless of names; other broth-like products never count or receive discounts', () => {
    const store = loadStore();
    const renamed = products.map(product => ({ ...product, name: 'Seasonal jar' }));
    const extra = [...renamed, { id: 'lookalike', name: 'Beef Chicken Mushroom Broth', price: 3000 }];
    assert.equal(store.calculateCartTotal({ prod_beef: 1, mushroom: 5 }, renamed).discount, 500);
    assert.equal(store.calculateCartTotal({ prod_beef: 5, lookalike: 1 }, extra).discount, 0);
    const qualifying = store.calculateCartTotal({ prod_chicken: 6, lookalike: 1 }, extra);
    assert.equal(qualifying.total, 15000);
    assert.equal(qualifying.brothCount, 6);
    assert.equal(store.calculateCartTotal({ unknown: 6 }, []).total, 0, 'Missing catalog must not fabricate jars');
});

test('discount never increases any below-$20 catalog price or overrides mushroom price', () => {
    const catalog = products.map(product => ({ ...product,
        price: product.id === 'prod_beef' ? 1500 : product.id === 'prod_chicken' ? 3100 : 4200 }));
    const result = loadStore().calculateCartTotal({ prod_beef: 2, prod_chicken: 2, mushroom: 2 }, catalog);
    assert.equal(result.subtotal, 17600);
    assert.equal(result.discount, 2200);
    assert.equal(result.total, 15400);
    assert.equal(result.items.find(item => item.productId === 'prod_beef').price, 1500);
    assert.equal(result.items.find(item => item.productId === 'mushroom').price, 4200);
});

test('malformed or disabled promotions cannot suppress the unconditional pickup offer', () => {
    const malformed = [null, [], false, 'true', 0,
        ...[null, 'false', 'true', 0, 1, [], {}].map(brothBundleEnabled => ({ brothBundleEnabled })),
        ...[null, '6', 0, -1, 1.5, 13, Infinity, NaN, true].map(bundleMinimum => ({ bundleMinimum })),
        ...[null, '2000', 0, -1, 1.5, 100001, Infinity, NaN, true].map(bundlePriceCents => ({ bundlePriceCents })),
        { brothBundleEnabled: false },
        { brothBundleEnabled: false, bundleMinimum: -1, bundlePriceCents: -1 }];
    const store = loadStore();
    for (const policy of malformed) {
        const result = store.calculateCartTotal({ prod_beef: 3, prod_chicken: 2, mushroom: 1 }, products, policy);
        assert.equal(result.discount, 2500, JSON.stringify(policy));
        assert.equal(result.total, 14000, JSON.stringify(policy));
    }
});

test('missing or unreadable promotion settings preserve fixed pricing; catalog read failures never fabricate products', async () => {
    const absent = loadStore({ promotionExists: false });
    const fallback = await absent.getPromotionConfig();
    assert.equal(fallback.bundleMinimum, 6);
    assert.equal(fallback.bundlePriceCents, 2000);
    assert.equal(absent.calculateCartTotal({ prod_beef: 4 }, products, fallback).discount, 0);
    assert.equal(absent.calculateCartTotal({ prod_beef: 6 }, products, fallback).discount, 3000);
    const denied = loadStore({ denied: true });
    const unavailable = await denied.getPromotionConfig();
    assert.equal(unavailable.brothBundleEnabled, false, 'Legacy read-failure metadata remains conservative');
    assert.equal(denied.calculateCartTotal({ prod_beef: 6 }, products, unavailable).discount, 3000);
    await assert.rejects(denied.getProducts(), /permission-denied/);
    assert.equal((await loadStore().getProducts()).length, 0);
});
