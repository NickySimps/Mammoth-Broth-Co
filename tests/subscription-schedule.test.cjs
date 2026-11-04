'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleShipment } = require('../firebase/functions/subscription-schedule.cjs');

test('missing scheduling inputs fail closed without throwing', () => {
  assert.equal(typeof scheduleShipment, 'function');
  assert.equal(scheduleShipment(), null);
  assert.equal(scheduleShipment({}), null);
});

test('payment and evaluation evidence must be explicit valid ordered epoch milliseconds', () => {
  for (const field of ['paidAt', 'evaluatedAt', 'periodStart', 'periodEnd']) {
    for (const value of [undefined, null, NaN, Infinity, 0, -1, '1793631600000', 1793631600000.5, 9e15]) {
      const input = fixture(); input[field] = value;
      assert.equal(scheduleShipment(input), null, `${field}=${value}`);
    }
  }
  const future = fixture(); future.paidAt = future.evaluatedAt + 1;
  assert.equal(scheduleShipment(future), null, 'future payment');
  const reversed = fixture(); reversed.periodStart = reversed.periodEnd;
  assert.equal(scheduleShipment(reversed), null, 'empty paid period');
  for (const field of ['paidAt', 'evaluatedAt']) {
    for (const delta of [0, 1]) {
      const input = fixture(); input[field] = ms('2026-11-02T14:00:00Z') + delta;
      assert.equal(scheduleShipment(input), null, `${field} at/after cutoff`);
    }
  }
});

test('configured cutoff must allow at least 24 actual hours, never an adjusted cutoff', () => {
  for (const [daysBefore, time, allowed] of [
    [0, '09:00', false], [1, '10:01', false], [1, '10:00', true],
    [1, '09:59', true], [2, '18:00', true]
  ]) {
    const input = fixture(), route = input.policy.scheduling.routes[0];
    input.paidAt = ms('2026-11-01T12:00:00Z'); input.evaluatedAt = input.paidAt;
    route.cutoff = { daysBefore, time };
    const before = structuredClone(input), result = scheduleShipment(input);
    assert.equal(result !== null, allowed, `${daysBefore} local days at ${time}`);
    if (allowed) {
      assert.ok(result.deliveryAt - result.cutoffAt >= 86400000);
      assert.equal(result.deliveryAt, ms('2026-11-03T15:00:00Z'));
    }
    assert.deepEqual(input, before, 'unsafe policy is refused, never rewritten');
  }
});

test('at exactly 24 hours advance both payment and evaluation remain strictly before cutoff to the millisecond', () => {
  const cutoff = ms('2026-11-02T15:00:00Z');
  for (const field of ['paidAt', 'evaluatedAt']) {
    for (const delta of [-1, 0, 1]) {
      const input = fixture();
      input.policy.scheduling.routes[0].cutoff = { daysBefore: 1, time: '10:00' };
      input.paidAt = cutoff - 2; input.evaluatedAt = cutoff - 2;
      input[field] = cutoff + delta;
      if (field === 'paidAt') input.evaluatedAt = input.paidAt;
      const result = scheduleShipment(input);
      assert.equal(result !== null, delta < 0, `${field}: cutoff ${delta}ms`);
      if (result) assert.equal(result.deliveryAt - result.cutoffAt, 86400000);
    }
  }
});

test('route selection requires unambiguous owner zone authorization, never ZIP inference', () => {
  const input = fixture(), s = input.policy.scheduling;
  s.routes.push({ ...structuredClone(s.routes[0]), id: 'market_ponte_vedra', weekday: 5,
    calendar: { from: '2026-11-02', through: '2026-11-09', dates: [{ date: '2026-11-06', open: true }] } });
  s.zones[0].allowedRouteIds.push('market_ponte_vedra');
  assert.equal(scheduleShipment(input), null, 'overlap is not a route preference');
  input.routeId = 'market_ponte_vedra';
  assert.equal(scheduleShipment(input)?.marketDate, '2026-11-06', 'explicit allowed choice');
  input.routeId = 'market_murray';
  assert.equal(scheduleShipment(input), null, 'unapproved choice');
  input.zoneId = '32204'; delete input.routeId;
  assert.equal(scheduleShipment(input), null, 'ZIP does not imply a route');
  for (const mutate of [
    p => p.zones.push(structuredClone(p.zones[0])),
    p => p.routes.push(structuredClone(p.routes[0])),
    p => p.zones[0].allowedRouteIds.push('missing'),
    p => p.zones[0].allowedRouteIds.push('market_palm'),
    p => { p.zones[0].allowedRouteIds = 'market_palm'; },
    p => { delete p.approvalReference; },
    p => { p.ready = false; },
    p => { delete p.timezone; },
    p => { p.timezone = 'Invalid/Zone'; }
  ]) {
    const f = fixture(); mutate(f.policy.scheduling);
    assert.equal(scheduleShipment(f), null, mutate.toString());
  }
});

test('market calendar is complete, closure-aware, date-valid and weekday overrides require approval', () => {
  const closed = fixture(); closed.policy.scheduling.routes[0].calendar.dates[0].open = false;
  assert.equal(scheduleShipment(closed), null, 'closed market cannot deliver');
  for (const mutate of [
    r => { r.weekday = 4; },
    r => { r.weekday = '2'; },
    r => { r.calendar.dates[0].open = 'true'; },
    r => { r.calendar.dates[0].date = '2026-11-04'; },
    r => { r.calendar.dates[0].date = '2026-02-30'; },
    r => { r.calendar.dates.push(structuredClone(r.calendar.dates[0])); },
    r => { r.calendar.from = '2026-11-04'; },
    r => { r.calendar.through = '2026-11-07'; },
    r => { delete r.calendar.from; },
    r => { delete r.cutoff.daysBefore; },
    r => { r.cutoff.daysBefore = -1; },
    r => { r.cutoff.daysBefore = 0.5; },
    r => { r.cutoff.time = '24:00'; },
    r => { r.deliveryTime = '25:00'; },
    r => { r.deliveryTime = '10:00:00'; },
    r => { r.calendar.dates[0].deliveryTime = '12:00'; }
  ]) {
    const f = fixture(); mutate(f.policy.scheduling.routes[0]);
    assert.equal(scheduleShipment(f), null, mutate.toString());
  }
  const moved = fixture(), r = moved.policy.scheduling.routes[0];
  r.calendar.dates = [{ date: '2026-11-03', open: false },
    { date: '2026-11-04', open: true, weekdayOverride: true, approvalReference: 'synthetic-exception' }];
  assert.equal(scheduleShipment(moved)?.marketDate, '2026-11-04');
  delete r.calendar.dates[1].approvalReference;
  assert.equal(scheduleShipment(moved), null, 'unapproved extra day');
  const missing = fixture(); missing.policy.scheduling.routes[0].calendar.through = '2026-11-16';
  assert.equal(scheduleShipment(missing), null, 'unrecorded weekly dates are unknown, not open');
});

test('weekly and fortnightly require approved paid-period mapping and calendar cadence', () => {
  for (const cadence of ['weekly', 'every_two_weeks']) {
    const input = fixture(); input.cadence = cadence;
    if (cadence === 'every_two_weeks') {
      input.periodEnd = ms('2026-11-16T05:00:00Z');
      const c = input.policy.scheduling.routes[0].calendar;
      c.through = '2026-11-16'; c.dates.push({ date: '2026-11-10', open: true });
      c.dates[0].open = false;
    }
    const expected = cadence === 'weekly' ? '2026-11-03' : '2026-11-10';
    assert.equal(scheduleShipment(input)?.marketDate, expected);
    delete input.policy.scheduling.periodMapping;
    assert.equal(scheduleShipment(input), null, 'mapping is not an invented default');
  }
  for (const mutate of [
    f => { f.cadence = 'every_four_weeks'; },
    f => { f.periodEnd += 86400000; },
    f => { f.policy.scheduling.periodMapping.approvalReference = ''; },
    f => { f.policy.scheduling.periodMapping.mode = 'next_market_anytime'; }
  ]) {
    const f = fixture(); mutate(f); assert.equal(scheduleShipment(f), null, mutate.toString());
  }
});

test('monthly requires an approved exact paid-period/date mapping, not four-week arithmetic', () => {
  for (const [start, end, chosen] of [
    ['2027-01-31', '2027-02-28', '2027-02-09'],
    ['2028-01-31', '2028-02-29', '2028-02-15'],
    ['2026-12-01', '2027-01-01', '2026-12-15']
  ]) {
    const input = monthlyFixture(start, end, chosen);
    assert.equal(scheduleShipment(input)?.marketDate, chosen, `${start} calendar month`);
    delete input.policy.scheduling.monthly;
    assert.equal(scheduleShipment(input), null, 'monthly policy unresolved');
  }
  for (const mutate of [
    f => { f.policy.scheduling.monthly.approvalReference = ''; },
    f => { delete f.policy.scheduling.monthly.billingTimezone; },
    f => { f.policy.scheduling.monthly.rollover = 'four_weeks'; },
    f => { f.policy.scheduling.monthly.mappings = []; },
    f => { f.policy.scheduling.monthly.mappings.push(structuredClone(f.policy.scheduling.monthly.mappings[0])); },
    f => { f.policy.scheduling.monthly.mappings[0].periodEnd++; },
    f => { f.policy.scheduling.monthly.mappings[0].date = '2027-02-10'; },
    f => { f.policy.scheduling.monthly.mappings[0].routeId = 'market_murray'; },
    f => { f.policy.scheduling.routes[0].calendar.dates.find(d => d.date === '2027-02-09').open = false; }
  ]) {
    const input = monthlyFixture('2027-01-31', '2027-02-28', '2027-02-09');
    mutate(input); assert.equal(scheduleShipment(input), null, mutate.toString());
  }
  assert.equal(scheduleShipment(monthlyFixture('2027-03-01', '2027-03-29', '2027-03-09')), null, '28 days is not generally a month');
});
function monthlyFixture(start, end, chosen) {
  const input = fixture(); input.cadence = 'monthly';
  input.periodStart = ms(`${start}T05:00:00Z`); input.periodEnd = ms(`${end}T05:00:00Z`);
  input.paidAt = input.periodStart + 3600000; input.evaluatedAt = input.paidAt;
  const s = input.policy.scheduling, c = s.routes[0].calendar;
  c.from = start; c.through = end; c.dates = [];
  for (let epoch = ms(`${start}T00:00:00Z`); epoch <= ms(`${end}T00:00:00Z`); epoch += 86400000) {
    if (new Date(epoch).getUTCDay() === 2) c.dates.push({ date: new Date(epoch).toISOString().slice(0, 10), open: true });
  }
  s.monthly = { mode: 'explicit_period_dates', billingTimezone: 'America/New_York', rollover: 'clamp_day',
    approvalReference: 'synthetic-monthly-approval',
    mappings: [{ periodStart: input.periodStart, periodEnd: input.periodEnd, routeId: 'market_palm', date: chosen }] };
  return input;
}

test('Nov 2–9 2026 scheduling ignores unrelated 2027 folds in a complete calendar', () => {
  for (const uncertain of ['delivery', 'cutoff']) {
    const input = fixture(), r = input.policy.scheduling.routes[0];
    r.weekday = 0;
    r.deliveryTime = uncertain === 'delivery' ? '01:30' : '10:00';
    r.cutoff = uncertain === 'cutoff' ? { daysBefore: 1, time: '01:30' } : { daysBefore: 2, time: '18:00' };
    r.calendar = { from: '2026-11-02', through: '2027-11-09', dates: [] };
    for (let day = ms('2026-11-02T00:00:00Z'); day <= ms('2027-11-09T00:00:00Z'); day += 86400000) {
      if (new Date(day).getUTCDay() === 0) r.calendar.dates.push({ date: new Date(day).toISOString().slice(0, 10), open: true });
    }
    if (uncertain === 'cutoff') r.calendar.dates.push({ date: '2027-11-08', open: true,
      weekdayOverride: true, approvalReference: 'synthetic-outside-period-override' });
    assert.deepEqual(scheduleShipment(input), {
      routeId: 'market_palm', marketDate: '2026-11-08', timezone: 'America/New_York',
      cutoffAt: ms(uncertain === 'cutoff' ? '2026-11-07T06:30:00Z' : '2026-11-06T23:00:00Z'),
      deliveryAt: ms(uncertain === 'delivery' ? '2026-11-08T06:30:00Z' : '2026-11-08T15:00:00Z'),
      schedulingVersion: 'fixture-v1'
    }, `${uncertain}: the 2027-11-07 fold is outside this paid period`);
  }
});

test('DST gaps and folds fail closed rather than shifting or skipping an uncertain market', () => {
  for (const [from, through, marketDate, time, paid, start, end] of [
    ['2027-03-08', '2027-03-22', '2027-03-14', '02:30', '2027-03-08T15:00:00Z', '2027-03-08T05:00:00Z', '2027-03-22T04:00:00Z'],
    ['2027-11-01', '2027-11-15', '2027-11-07', '01:30', '2027-11-01T15:00:00Z', '2027-11-01T04:00:00Z', '2027-11-15T05:00:00Z']
  ]) {
    const input = fixture(), r = input.policy.scheduling.routes[0];
    input.cadence = 'every_two_weeks'; input.paidAt = ms(paid); input.evaluatedAt = input.paidAt;
    input.periodStart = ms(start); input.periodEnd = ms(end);
    r.weekday = 0; r.deliveryTime = time;
    const nextDate = new Date(ms(`${marketDate}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    r.calendar = { from, through, dates: [{ date: marketDate, open: true }, { date: nextDate, open: true }] };
    assert.equal(scheduleShipment(input), null, `${marketDate} ${time} uncertain delivery`);
    r.deliveryTime = '10:00'; r.cutoff = { daysBefore: 0, time };
    assert.equal(scheduleShipment(input), null, `${marketDate} ${time} uncertain cutoff`);
  }
});

test('one local calendar day requires 24 actual hours across spring and fall DST', () => {
  for (const [start, end, date, cutoffTime, delivery, cutoff, allowed] of [
    ['2027-03-08T05:00:00Z', '2027-03-15T04:00:00Z', '2027-03-14', '10:00', '2027-03-14T14:00:00Z', '2027-03-13T15:00:00Z', false],
    ['2027-03-08T05:00:00Z', '2027-03-15T04:00:00Z', '2027-03-14', '09:00', '2027-03-14T14:00:00Z', '2027-03-13T14:00:00Z', true],
    ['2027-11-01T04:00:00Z', '2027-11-08T05:00:00Z', '2027-11-07', '10:00', '2027-11-07T15:00:00Z', '2027-11-06T14:00:00Z', true]
  ]) {
    for (const selected of [false, true]) {
      const input = fixture(), route = input.policy.scheduling.routes[0];
      input.periodStart = ms(start); input.periodEnd = ms(end);
      input.paidAt = input.periodStart; input.evaluatedAt = input.paidAt;
      if (selected) input.selectedMarketDate = date;
      route.weekday = 0; route.cutoff = { daysBefore: 1, time: cutoffTime };
      route.calendar = { from: start.slice(0, 10), through: end.slice(0, 10), dates: [{ date, open: true }] };
      const before = structuredClone(input), result = scheduleShipment(input);
      assert.equal(result !== null, allowed, `${date} cutoff ${cutoffTime}, selected=${selected}: ${(ms(delivery) - ms(cutoff)) / 3600000}h`);
      if (result) {
        assert.equal(result.deliveryAt, ms(delivery));
        assert.equal(result.cutoffAt, ms(cutoff), 'configured local cutoff is not normalized to a fixed UTC offset');
      }
      assert.deepEqual(input, before);
    }
  }
});

test('insufficient advance cutoff refuses the paid period rather than skipping to a later safe market', () => {
  const input = fixture(), route = input.policy.scheduling.routes[0];
  input.cadence = 'every_two_weeks';
  input.periodStart = ms('2027-03-08T05:00:00Z'); input.periodEnd = ms('2027-03-22T04:00:00Z');
  input.paidAt = input.periodStart; input.evaluatedAt = input.paidAt;
  route.weekday = 0; route.cutoff = { daysBefore: 1, time: '10:00' };
  route.calendar = { from: '2027-03-08', through: '2027-03-22', dates: [
    { date: '2027-03-14', open: true }, { date: '2027-03-21', open: true }
  ] };
  assert.equal(scheduleShipment(input), null, 'first market has only 23 hours advance');
  input.selectedMarketDate = '2027-03-14';
  assert.equal(scheduleShipment(input), null, 'unsafe customer choice never falls back');
  input.selectedMarketDate = '2027-03-21';
  assert.equal(scheduleShipment(input)?.marketDate, '2027-03-21', 'explicit safe later selection retains existing eligibility rules');
});

test('calendar days across DST do not mean fixed 24-hour offsets', () => {
  const input = fixture(), r = input.policy.scheduling.routes[0];
  input.periodStart = ms('2027-03-08T05:00:00Z'); input.periodEnd = ms('2027-03-15T04:00:00Z');
  input.paidAt = ms('2027-03-08T15:00:00Z'); input.evaluatedAt = input.paidAt;
  r.weekday = 0; r.calendar = { from: '2027-03-08', through: '2027-03-15', dates: [{ date: '2027-03-14', open: true }] };
  const result = scheduleShipment(input);
  assert.equal(result?.deliveryAt, ms('2027-03-14T14:00:00Z'));
  assert.equal(result?.cutoffAt, ms('2027-03-13T14:00:00Z'));
  assert.equal(result.deliveryAt - result.cutoffAt, 86400000, 'earlier wall cutoff retains exactly 24 actual hours');
});

test('contradictory or unsupported timing override fields fail closed', () => {
  for (const mutate of [
    r => { r.cutoff.hoursBefore = 12; },
    r => { r.calendar.dates[0].weekdayOverride = false; },
    r => { r.calendar.dates[0].weekdayOverride = true; },
    r => { r.calendar.dates[0].cutoff = { daysBefore: 0, time: '09:00' }; },
    r => { r.cutoff.daysBefore = 0; r.cutoff.time = '11:00'; }
  ]) {
    const input = fixture(); mutate(input.policy.scheduling.routes[0]);
    assert.equal(scheduleShipment(input), null, mutate.toString());
  }
});

test('all four explicitly configured market weekdays remain local market days', () => {
  for (const [id, weekday, date, expected] of [
    ['market_atlantic', 0, '2026-11-08', '2026-11-08T15:00:00Z'],
    ['market_palm', 2, '2026-11-03', '2026-11-03T15:00:00Z'],
    ['market_murray', 3, '2026-11-04', '2026-11-04T15:00:00Z'],
    ['market_ponte_vedra', 5, '2026-11-06', '2026-11-06T15:00:00Z']
  ]) {
    const input = fixture(), s = input.policy.scheduling, r = s.routes[0];
    r.id = id; r.weekday = weekday; r.calendar.dates = [{ date, open: true }];
    s.zones[0].allowedRouteIds = [id];
    assert.equal(scheduleShipment(input)?.deliveryAt, ms(expected), id);
  }
});

test('paid periods are half-open; missed cutoffs never spill into an unpaid period', () => {
  const input = fixture(), r = input.policy.scheduling.routes[0];
  input.periodStart = ms('2026-11-03T15:00:00Z'); input.periodEnd = ms('2026-11-10T15:00:00Z');
  r.calendar.through = '2026-11-10'; r.calendar.dates.push({ date: '2026-11-10', open: true });
  assert.equal(scheduleShipment(input)?.marketDate, '2026-11-03', 'inclusive period start');
  input.paidAt = ms('2026-11-03T16:00:00Z'); input.evaluatedAt = input.paidAt;
  assert.equal(scheduleShipment(input), null, 'exclusive end, not next unpaid market');
});

test('boundary-date pruning preserves exact millisecond half-open period membership', () => {
  for (const delta of [-1, 0, 1]) {
    for (const boundary of ['start', 'end']) {
      const input = fixture(), r = input.policy.scheduling.routes[0];
      input.periodStart = ms('2026-11-03T15:00:00Z') + delta;
      input.periodEnd = ms('2026-11-10T15:00:00Z') + delta;
      r.calendar.through = '2026-11-11';
      r.calendar.dates = [
        { date: '2026-11-03', open: boundary === 'start' },
        { date: '2026-11-10', open: boundary === 'end' }
      ];
      const included = boundary === 'start' ? delta <= 0 : delta > 0;
      assert.equal(scheduleShipment(input)?.marketDate ?? null,
        included ? (boundary === 'start' ? '2026-11-03' : '2026-11-10') : null,
        `${boundary} shifted by ${delta}ms`);
    }
  }
});

test('midnight-exclusive period ends prune the following DST transition date', () => {
  for (const [start, end, time, expected] of [
    ['2027-03-07T05:00:00Z', '2027-03-14T05:00:00Z', '02:30', '2027-03-07T07:30:00Z'],
    ['2027-10-31T04:00:00Z', '2027-11-07T04:00:00Z', '01:30', '2027-10-31T05:30:00Z']
  ]) {
    const input = fixture(), r = input.policy.scheduling.routes[0];
    input.periodStart = ms(start); input.periodEnd = ms(end);
    input.paidAt = input.periodStart - 3 * 86400000; input.evaluatedAt = input.paidAt;
    r.weekday = 0; r.deliveryTime = time;
    r.cutoff = { daysBefore: 2, time: '18:00' };
    r.calendar = { from: start.slice(0, 10), through: end.slice(0, 10), dates: [
      { date: start.slice(0, 10), open: true }, { date: end.slice(0, 10), open: true }
    ] };
    assert.equal(scheduleShipment(input)?.deliveryAt, ms(expected), `${end}: wholly excluded date`);
    input.periodStart++; input.periodEnd++;
    assert.equal(scheduleShipment(input), null, `${end} + 1ms: boundary date remains fail-closed`);
  }
});

test('relevant deliveries retain fail-closed cutoff gaps and folds before the paid window', () => {
  for (const [start, end, time] of [
    ['2027-03-15T04:00:00Z', '2027-03-22T04:00:00Z', '02:30'],
    ['2027-11-08T05:00:00Z', '2027-11-15T05:00:00Z', '01:30']
  ]) {
    const input = fixture(), r = input.policy.scheduling.routes[0];
    input.periodStart = ms(start); input.periodEnd = ms(end);
    input.paidAt = input.periodStart - 3 * 86400000; input.evaluatedAt = input.paidAt;
    r.weekday = 1; r.cutoff = { daysBefore: 1, time };
    r.calendar = { from: start.slice(0, 10), through: end.slice(0, 10), dates: [
      { date: start.slice(0, 10), open: true }, { date: end.slice(0, 10), open: true }
    ] };
    assert.equal(scheduleShipment(input), null, `${start}: uncertain cutoff is not pruned separately`);
  }
});

test('repeated evaluation is pure, deterministic and accepts deeply frozen inputs', () => {
  const input = fixture(), original = structuredClone(input);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(input);
  const first = scheduleShipment(input), second = scheduleShipment(input);
  assert.ok(first);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.deepEqual(input, original);
  first.marketDate = 'tampered';
  assert.equal(scheduleShipment(input).marketDate, '2026-11-03');
});

test('customer may select a later approved market date within the paid fortnight', () => {
  const input = fixture();
  input.cadence = 'every_two_weeks';
  input.periodEnd = ms('2026-11-16T05:00:00Z');
  const calendar = input.policy.scheduling.routes[0].calendar;
  calendar.through = '2026-11-16';
  calendar.dates.push({ date: '2026-11-10', open: true });
  input.selectedMarketDate = '2026-11-10';
  assert.equal(scheduleShipment(input)?.marketDate, '2026-11-10');
  delete input.selectedMarketDate;
  assert.equal(scheduleShipment(input)?.marketDate, '2026-11-03', 'legacy first eligible mapping remains unchanged');
});

test('customer selects Tuesday or Friday in a synthetic approved overlapping 32082 zone', () => {
  const input = overlapFixture();
  assert.equal(scheduleShipment(input), null, 'date/ZIP must not infer an ambiguous route');
  for (const [routeId, date, expected] of [
    ['market_palm', '2026-11-03', '2026-11-03T15:00:00Z'],
    ['market_ponte_vedra', '2026-11-06', '2026-11-06T15:00:00Z']
  ]) {
    input.routeId = routeId; input.selectedMarketDate = date;
    const before = structuredClone(input);
    assert.deepEqual(scheduleShipment(input), {
      routeId, marketDate: date, timezone: 'America/New_York',
      deliveryAt: ms(expected), cutoffAt: ms(date === '2026-11-03' ? '2026-11-02T14:00:00Z' : '2026-11-05T14:00:00Z'),
      schedulingVersion: 'fixture-v1'
    });
    assert.deepEqual(input, before, 'customer preference does not mutate trusted policy');
  }
});

function overlapFixture() {
  const input = fixture(), s = input.policy.scheduling;
  // Synthetic authorization, not a claim that ZIP membership grants a route.
  input.zoneId = 'synthetic_32082'; s.zones[0].zoneId = input.zoneId;
  s.routes.push({ ...structuredClone(s.routes[0]), id: 'market_ponte_vedra', weekday: 5,
    calendar: { from: '2026-11-02', through: '2026-11-09', dates: [{ date: '2026-11-06', open: true }] } });
  s.zones[0].allowedRouteIds.push('market_ponte_vedra');
  return input;
}

test('invalid or unauthorized customer date/route choices return null without fallback', () => {
  for (const selectedMarketDate of [null, '', '2026-11-3', '2026-02-30', '2026-11-04',
    '2026-11-10', '2026-11-03T15:00:00Z', ms('2026-11-03T15:00:00Z'),
    { date: '2026-11-03' }, ['2026-11-03']]) {
    const input = fixture(); input.selectedMarketDate = selectedMarketDate;
    assert.equal(scheduleShipment(input), null, JSON.stringify(selectedMarketDate));
  }
  for (const routeId of [undefined, null, 'market_murray', '__proto__', { id: 'market_palm' }, 'market_palm ']) {
    const input = overlapFixture(); input.routeId = routeId; input.selectedMarketDate = '2026-11-03';
    assert.equal(scheduleShipment(input), null, `route ${JSON.stringify(routeId)}`);
  }
  const wrongDay = overlapFixture();
  wrongDay.routeId = 'market_palm'; wrongDay.selectedMarketDate = '2026-11-06';
  assert.equal(scheduleShipment(wrongDay), null, 'Friday cannot silently switch a Tuesday route');
  wrongDay.routeId = 'market_ponte_vedra';
  wrongDay.policy.scheduling.zones[0].allowedRouteIds = ['market_palm'];
  assert.equal(scheduleShipment(wrongDay), null, 'revoked route cannot be selected');
});

test('chosen closed or expired market never falls back to another approved market', () => {
  for (const mutate of [
    f => { f.policy.scheduling.routes[0].calendar.dates[0].open = false; },
    f => { f.paidAt = ms('2026-11-02T14:00:00Z'); f.evaluatedAt = f.paidAt; },
    f => { f.evaluatedAt = ms('2026-11-02T14:00:00Z'); },
    f => { f.evaluatedAt = ms('2026-11-04T16:00:00Z'); },
    f => { delete f.policy.scheduling.periodMapping; },
    f => { delete f.policy.scheduling.timezone; }
  ]) {
    const input = fixture(); input.cadence = 'every_two_weeks';
    input.periodEnd = ms('2026-11-16T05:00:00Z');
    const c = input.policy.scheduling.routes[0].calendar;
    c.through = '2026-11-16'; c.dates.push({ date: '2026-11-10', open: true });
    input.selectedMarketDate = '2026-11-03'; mutate(input);
    assert.equal(scheduleShipment(input), null, mutate.toString());
  }
});

test('customer date cannot override monthly mapping or invent a monthly rule', () => {
  const input = monthlyFixture('2027-01-31', '2027-02-28', '2027-02-09');
  input.selectedMarketDate = '2027-02-09';
  assert.equal(scheduleShipment(input)?.marketDate, '2027-02-09');
  input.selectedMarketDate = '2027-02-16';
  assert.equal(scheduleShipment(input), null, 'another open Tuesday is not the approved monthly date');
  input.selectedMarketDate = '2027-02-09'; delete input.policy.scheduling.monthly;
  assert.equal(scheduleShipment(input), null, 'customer date is not monthly approval');
});

test('customer-selected dates retain DST gap/fold rejection and local cutoff arithmetic', () => {
  for (const [start, end, date, time, expectedDelivery] of [
    ['2027-03-08T05:00:00Z', '2027-03-15T04:00:00Z', '2027-03-14', '02:30', '2027-03-14T14:00:00Z'],
    ['2027-11-01T04:00:00Z', '2027-11-08T05:00:00Z', '2027-11-07', '01:30', '2027-11-07T15:00:00Z']
  ]) {
    const input = fixture(), route = input.policy.scheduling.routes[0];
    input.periodStart = ms(start); input.periodEnd = ms(end);
    input.paidAt = input.periodStart; input.evaluatedAt = input.paidAt;
    input.selectedMarketDate = date;
    route.weekday = 0;
    route.calendar = { from: start.slice(0, 10), through: end.slice(0, 10), dates: [{ date, open: true }] };
    route.deliveryTime = time;
    assert.equal(scheduleShipment(input), null, `${date} uncertain delivery`);
    route.deliveryTime = '10:00'; route.cutoff = { daysBefore: 0, time };
    assert.equal(scheduleShipment(input), null, `${date} uncertain cutoff`);
    route.cutoff = { daysBefore: 1, time: '09:00' };
    assert.equal(scheduleShipment(input)?.deliveryAt, ms(expectedDelivery));
  }
});

test('customer preference never supplies authoritative route timing or payment evidence', () => {
  const input = fixture(); input.selectedMarketDate = '2026-11-03';
  const expected = scheduleShipment(input);
  Object.assign(input, { deliveryAt: 1, cutoffAt: 9e15, timezone: 'UTC',
    weekday: 5, deliveryTime: '23:00', cutoff: { daysBefore: 0, time: '23:59' } });
  assert.deepEqual(scheduleShipment(input), expected, 'only server policy supplies schedule instants');
  delete input.paidAt;
  assert.equal(scheduleShipment(input), null, 'client schedule instants cannot replace verified payment');
});

// Synthetic owner policy only; NOT approved business configuration.
const ms = value => Date.parse(value);
function fixture() {
  return {
    paidAt: ms('2026-11-02T12:00:00Z'), evaluatedAt: ms('2026-11-02T13:00:00Z'),
    periodStart: ms('2026-11-02T05:00:00Z'), periodEnd: ms('2026-11-09T05:00:00Z'),
    cadence: 'weekly', zoneId: 'owner_zone',
    policy: { scheduling: {
      ready: true, version: 'fixture-v1', approvalReference: 'synthetic-owner-approval',
      timezone: 'America/New_York',
      periodMapping: { mode: 'first_eligible_market_in_paid_period', approvalReference: 'synthetic-mapping-approval' },
      zones: [{ zoneId: 'owner_zone', allowedRouteIds: ['market_palm'] }],
      routes: [{ id: 'market_palm', weekday: 2, deliveryTime: '10:00',
        cutoff: { daysBefore: 1, time: '09:00' },
        calendar: { from: '2026-11-02', through: '2026-11-09',
          dates: [{ date: '2026-11-03', open: true }] } }]
    } }
  };
}
test('explicit approved zone selects its market day after verified payment', () => {
  assert.deepEqual(scheduleShipment(fixture()), {
    routeId: 'market_palm', marketDate: '2026-11-03', timezone: 'America/New_York',
    cutoffAt: ms('2026-11-02T14:00:00Z'), deliveryAt: ms('2026-11-03T15:00:00Z'),
    schedulingVersion: 'fixture-v1'
  });
});
