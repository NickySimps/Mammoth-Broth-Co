import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function bannerAt(instant, timezone) {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try {
    let initialize;
    let banner;
    class FixedDate extends Date {
      constructor(...args) { super(...(args.length ? args : [instant])); }
    }
    const context = vm.createContext({ Date: FixedDate, document: {
      documentElement: { classList: { toggle() {} } },
      addEventListener: (event, callback) => { initialize = callback; },
      createElement: () => ({ className: '', innerHTML: '' }),
      body: { firstChild: null, insertBefore: node => { banner = node; } }
    } });
    vm.runInContext(await readFile(new URL('../market-banner.js', import.meta.url), 'utf8'), context);
    initialize();
    return banner.innerHTML;
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('market banner uses the market local date rather than a visitor timezone', async () => {
  for (const timezone of ['America/New_York', 'Pacific/Honolulu', 'Asia/Tokyo']) {
    const html = await bannerAt('2026-10-25T00:30:00Z', timezone);
    assert.match(html, /TOMORROW[\s\S]*Atlantic Beach Farmers Market/, timezone);
  }
});

test('banner day labels count calendar days across the spring DST boundary', async () => {
  const html = await bannerAt('2026-03-08T18:30:00Z', 'America/New_York');
  assert.match(html, /Tuesday[\s\S]*Palm Valley Farmers Market/);
  assert.doesNotMatch(html, /TOMORROW/);
});
