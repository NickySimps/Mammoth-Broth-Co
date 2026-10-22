import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPickupDate } from '../schedule-helper.mjs';

const now = new Date('2026-10-23T02:30:00Z');
test('weekday uses market local date, not browser date, including same-day exclusion', () => {
  assert.equal(nextPickupDate({ timezone: 'America/New_York', weekday: 5 }, now), '2026-10-23');
  assert.equal(nextPickupDate({ timezone: 'Asia/Tokyo', weekday: 5 }, now), '2026-10-30');
  assert.equal(nextPickupDate({ timezone: 'America/New_York', day: 5 }, now), '2026-10-23');
});
test('DST spring and fall transitions use calendar days, never local elapsed hours', () => {
  for (const instant of ['2026-03-08T06:59:00Z', '2026-03-08T07:01:00Z']) {
    assert.equal(nextPickupDate({ timezone: 'America/New_York', weekday: 1 }, new Date(instant)), '2026-03-09');
  }
  for (const instant of ['2026-11-01T05:59:00Z', '2026-11-01T06:01:00Z']) {
    assert.equal(nextPickupDate({ timezone: 'America/New_York', weekday: 1 }, new Date(instant)), '2026-11-02');
  }
});
test('holiday schedule takes precedence and selects earliest future approved local day', () => {
  assert.equal(nextPickupDate({ timezone: 'America/New_York', weekday: 0, pickupDates: ['2026-12-24', '2026-10-22', '2026-11-25'] }, now), '2026-11-25');
});
test('missing, inconsistent, exhausted or malformed schedule fails closed', () => {
  for (const market of [null, {}, { id: 'market_atlantic', name: 'Sunday' }, { timezone: '' }, { timezone: 'Invalid/Timezone', weekday: 5 }, { timezone: 'America/New_York' }, ...['5', null, -1, 7, 1.5].map(weekday => ({ timezone: 'America/New_York', weekday })), { timezone: 'America/New_York', weekday: 5, day: 4 }, ...[[], null, '2026-12-24', ['2026-02-30'], ['2026-10-22'], ['2026-12-24', 'bad']].map(pickupDates => ({ timezone: 'America/New_York', weekday: 5, pickupDates }))]) {
    assert.equal(nextPickupDate(market, now), '', JSON.stringify(market));
  }
});
