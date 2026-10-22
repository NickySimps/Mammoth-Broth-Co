import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const moduleURL = new URL('../jar.mjs', import.meta.url);

function fixture() {
  const nodes = new Map();
  const element = () => ({ textContent: '', value: '', disabled: true, hidden: false, children: [],
    append(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    addEventListener(name, callback) { this[name] = callback; }, href: '' });
  return { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
}

test('landing renders catalog choices, safe context, and action-only reorder', async () => {
  const { mountJar } = await import(moduleURL);
  assert.equal(typeof mountJar, 'function', 'landing controller must exist');
  const document = fixture();
  const products = [{ id: 'prod_beef', name: '<b>Beef Broth</b>' }, { id: 'inactive', active: false }, { id: 'sold', name: 'Sold batch', available: false }];
  let writes = 0; let destination = '';
  mountJar({ document, search: '?product=prod_beef&market=market_atlantic', products,
    markets: [{ id: 'market_atlantic', name: 'Atlantic Beach' }], live: true,
    storage: { getItem: () => null, setItem() { writes++; } }, navigate: url => { destination = url; } });
  assert.equal(writes, 0);
  assert.equal(document.getElementById('product-select').children.length, 3);
  assert.equal(document.getElementById('product-name').textContent, '<b>Beef Broth</b>');
  assert.equal(document.getElementById('market-context').textContent, 'Your market: Atlantic Beach. Confirm the next pickup in the shop.');
  assert.equal(document.getElementById('reorder-button').disabled, false);
  document.getElementById('reorder-button').click();
  assert.equal(writes, 1);
  assert.equal(destination, './shop.html#order-section');
  const selector = document.getElementById('product-select'); selector.value = 'sold'; selector.change();
  assert.equal(document.getElementById('reorder-button').disabled, true);
  selector.value = 'not-in-catalog'; selector.change();
  assert.equal(document.getElementById('product-name').textContent, 'Choose your broth');
});

test('landing works without catalog and never guesses care or pickup dates', () => {
  const htmlURL = new URL('../jar.html', import.meta.url);
  assert.ok(existsSync(htmlURL), 'jar HTML must exist');
  const html = readFileSync(htmlURL, 'utf8');
  for (const target of ['./shop.html#products-section', './shop.html#order-section', './markets.html#market-calendar', './contact.html#main-content']) assert.ok(html.includes(target), target);
  assert.match(html, /<label for="product-select">/);
  assert.match(html, /role="status"/);
  assert.match(html, /jar.css/);
  assert.match(html, /jar.mjs/);
  assert.match(html, /jar label/);
  assert.doesNotMatch(html, /shelf.life|allergen.free|delivery available|days in the fridge/i);
  assert.ok(existsSync(new URL('../jar.css', import.meta.url)), 'mobile CSS must exist');
});
test('jar query uses exact active catalog IDs, never arbitrary destinations', async () => {
  assert.ok(existsSync(moduleURL), 'jar module must exist');
  const { resolveJar } = await import(moduleURL);
  const products = [{ id: 'prod_beef', name: 'Beef Broth' }, { id: 'prod_hidden', active: false }];
  const markets = [{ id: 'market_atlantic', name: 'Atlantic Beach' }];
  assert.equal(resolveJar('?product=prod_beef&market=market_atlantic', products, markets).product.id, 'prod_beef');
  assert.equal(resolveJar('?product=prod_beef&market=market_atlantic', products, markets).market.id, 'market_atlantic');
  for (const id of ['prod_hidden', 'unknown', '__proto__', 'https://evil.example', 'prod_beef/../x', 'prod_beef%20']) {
    assert.equal(resolveJar(`?product=${id}&market=${id}`, products, markets).product, null);
    assert.equal(resolveJar(`?product=${id}&market=${id}`, products, markets).market, null);
  }
  assert.equal(resolveJar('?product=__proto__', [{ id: '__proto__' }]).product, null, 'reserved object keys are never usable catalog IDs');
  assert.equal(resolveJar('?product=constructor', [{ id: 'constructor' }]).product, null);
  assert.equal(resolveJar('?product=prod_beef&product=prod_beef', products, markets).product, null);
  assert.equal(resolveJar('?market=market_atlantic&market=market_atlantic', products, markets).market, null);
});

test('reorder requires explicit action, live availability, and preserves the existing cart', async () => {
  const { reorderJar } = await import(moduleURL);
  assert.equal(typeof reorderJar, 'function', 'explicit reorder action must exist');
  const products = [{ id: 'prod_beef' }, { id: 'prod_chicken' }, { id: 'sold', available: false }];
  const saved = new Map([['mammothCart', '{"prod_chicken":2}']]);
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  assert.equal(reorderJar('prod_beef', products, storage, false), false);
  assert.equal(saved.get('mammothCart'), '{"prod_chicken":2}');
  assert.equal(reorderJar('sold', products, storage, true), false);
  assert.equal(reorderJar('unknown', products, storage, true), false);
  assert.equal(reorderJar('prod_beef', products, storage, true), true);
  assert.deepEqual(JSON.parse(saved.get('mammothCart')), { prod_chicken: 2, prod_beef: 1 });
  saved.set('mammothCart', 'broken');
  assert.equal(reorderJar('prod_beef', products, storage, true), false, 'never overwrite a damaged cart');
  saved.set('mammothCart', '{"prod_beef":12}');
  assert.equal(reorderJar('prod_beef', products, storage, true), false, 'do not exceed 12 jar limit');
  assert.equal(reorderJar('prod_beef', products, { getItem() { throw Error('blocked'); } }, true), false);
});
