const validCatalogId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);

// Query values select catalog entries, never URLs, selectors, or HTML.
export function resolveJar(search, products = [], markets = []) {
  const params = new URLSearchParams(search);
  const find = (key, entries) => {
    const values = params.getAll(key);
    if (values.length !== 1 || !validCatalogId(values[0])) return null;
    return entries.find(entry => entry.id === values[0] && entry.active !== false) || null;
  };
  return { product: find('product', products), market: find('market', markets) };
}

export function mountJar({ document, search = '', products = [], markets = [], live = false, storage, navigate }) {
  const node = id => document.getElementById(id);
  const choices = products.filter(product => product.active !== false && validCatalogId(product.id));
  const selector = node('product-select');
  selector.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = 'Choose your broth'; selector.append(placeholder);
  for (const product of choices) {
    const option = document.createElement('option');
    option.value = product.id; option.textContent = product.name; selector.append(option);
  }
  selector.disabled = choices.length === 0;
  const context = resolveJar(search, choices, markets);
  selector.value = context.product?.id || '';
  node('market-context').textContent = context.market ? `Your market: ${context.market.name}. Confirm the next pickup in the shop.` : 'Choose a market and confirm the next pickup in the shop.';
  node('catalog-status').textContent = live ? 'Current catalog loaded. Choose a broth to reorder.' : 'Live availability could not be checked. Browse the shop or contact us before ordering.';
  const update = () => {
    const { product } = resolveJar(`?product=${encodeURIComponent(selector.value)}`, choices);
    node('product-name').textContent = product?.name || 'Choose your broth';
    node('product-status').textContent = !product ? 'Match the broth name on your jar.' : !live ? 'Product reference only. Check current availability in the shop.' : product.available === false ? 'This batch is currently unavailable. Browse the shop for alternatives.' : 'Add one jar, then review your cart and choose pickup in the shop.';
    node('reorder-button').disabled = !live || !product || product.available === false;
  };
  selector.addEventListener('change', update);
  node('reorder-button').addEventListener('click', () => {
    if (!live) return;
    if (reorderJar(selector.value, choices, storage, true)) navigate('./shop.html#order-section');
    else node('catalog-status').textContent = 'We could not add a jar. Your existing cart was not replaced. Please use the shop to review your cart.';
  });
  update();
}

// Reference names/IDs are from seed-db.html, not claims about live stock or price.
const referenceProducts = [{ id: 'prod_beef', name: 'Beef Broth' }, { id: 'prod_chicken', name: 'Chicken Broth' }];
if (typeof document !== 'undefined' && document.getElementById('jar-page')) {
  let timer;
  const catalog = import('./store.js').then(async store => {
    const [products, markets] = await Promise.allSettled([store.getProducts(), store.getMarkets()]);
    if (products.status !== 'fulfilled') throw new Error('Catalog unavailable');
    return { products: products.value, markets: markets.status === 'fulfilled' ? markets.value : [], live: true };
  });
  Promise.race([catalog, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Catalog timeout')), 5000); })])
    .catch(() => ({ products: referenceProducts, markets: [], live: false }))
    .then(data => {
      clearTimeout(timer);
      mountJar({ document, search: location.search, ...data,
        storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
        navigate: url => location.assign(url) });
    });
}

// The caller must be the customer's reorder button, never page initialization.
export function reorderJar(id, products, storage, explicitAction = false) {
  const { product } = resolveJar(`?product=${encodeURIComponent(id)}`, products);
  if (!explicitAction || !product || product.available === false) return false;
  try {
    const cart = JSON.parse(storage.getItem('mammothCart') || '{}');
    if (!cart || Array.isArray(cart) || typeof cart !== 'object') return false;
    const quantities = Object.values(cart);
    if (quantities.some(value => !Number.isInteger(value) || value < 1)) return false;
    if (quantities.reduce((sum, value) => sum + value, 0) >= 12) return false;
    cart[id] = (Object.hasOwn(cart, id) ? cart[id] : 0) + 1;
    storage.setItem('mammothCart', JSON.stringify(cart));
    return true;
  } catch {
    return false;
  }
}
