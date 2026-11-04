'use strict';
/**
 * ISOLATED POLICY PROTOTYPE — no deployed entrypoint imports this module.
 * scheduleShipment({paidAt, evaluatedAt, periodStart, periodEnd, cadence,
 *                   zoneId, routeId?, selectedMarketDate?, policy}) -> schedule | null.
 * policy, zoneId, paid evidence and clock MUST be supplied/validated by the server,
 * never merged from a customer request. This module cannot authenticate the caller.
 * routeId and selectedMarketDate may express customer preferences only: the route
 * must be server-authorized for the zone, and the exact YYYY-MM-DD date must be an
 * open entry in that route's approved calendar, within the paid period and cutoff.
 * No client delivery/cutoff timestamp or timezone is used to construct a schedule.
 * All instants are explicit positive integer epoch MILLISECONDS. evaluatedAt is
 * a trusted caller-supplied clock snapshot, never Date.now(). paidAt MUST come
 * from independently verified paid-invoice evidence, not checkout/client data.
 * This pure module cannot verify payment, authority, capacity or dispatch holds.
 *
 * Required owner-managed policy.scheduling:
 * {ready:true, version, approvalReference, timezone:<IANA>,
 *  zones:[{zoneId, allowedRouteIds:[routeId,...]}],
 *  routes:[{id, weekday:0..6 (Sunday=0), deliveryTime:'HH:mm',
 *    cutoff:{daysBefore:<nonnegative integer LOCAL calendar days>,time:'HH:mm'},
 *    calendar:{from:'YYYY-MM-DD',through:'YYYY-MM-DD',dates:[
 *      {date:'YYYY-MM-DD',open:<boolean>,weekdayOverride?:true,approvalReference?}
 *    ]}}],
 *  periodMapping?:{mode:'first_eligible_market_in_paid_period',approvalReference},
 *  monthly?:{mode:'explicit_period_dates',approvalReference,billingTimezone:<IANA>,
 *    rollover:'clamp_day',mappings:[{periodStart,periodEnd,routeId,date}]}}
 *
 * No business defaults exist. Zone IDs are NOT ZIP codes; overlapping allowed
 * routes require an explicit authorized routeId; a selected date never infers it.
 * All configured routes must have
 * complete calendars: each nominal weekly date within the inclusive horizon
 * must explicitly be open or closed. Extra weekdays require approved overrides;
 * close the original date explicitly when moving a market. Per-date cutoff or
 * time overrides are unsupported and fail closed, never silently ignored.
 * The chosen calendar must cover the entire half-open paid period.
 *
 * Weekly/fortnightly require explicit approval of the first-eligible-open-date
 * mapping; local calendar periods are 7/14 days, not fixed UTC durations over DST.
 * Optional selectedMarketDate narrows eligibility to that exact date (including a
 * later open date in a fortnight). Omission retains first-eligible behavior; an
 * invalid/closed/expired choice returns null, never a different date or route.
 * Monthly selection must ALSO match its approved exact period/date mapping.
 * Monthly NEVER falls back to that mapping or 28 days: exact period->market-date
 * mappings and an approved billing timezone/clamped calendar-month rule are
 * mandatory. Other monthly anchor rules remain unresolved/unsupported => null.
 * A clamped endpoint is validated per supplied pair; future anchors are NOT inferred.
 *
 * Payment and evaluation must both be strictly BEFORE cutoff; delivery must be
 * at least 24 actual hours after the configured cutoff and inside the paid period.
 * Local calendar cutoff arithmetic is retained, but a DST-shortened day that
 * provides less than 24 hours is refused, never shifted to invent a cutoff.
 * Invalid timestamps, duplicate
 * policy identifiers, missing calendars, DST gaps/folds or unsupported choices
 * return null for operator reconciliation. Never roll into an unpaid period.
 * deliveryAt is the owner's configured planning instant, NOT a customer arrival
 * window or dispatch authorization. Caller must recheck cutoff/current policy,
 * paid evidence and holds atomically before recording/dispatching a shipment.
 * Pure: no clock/network/database access, mutation, reservation or side effects.
 */
const DAY = 86400000;
const text = value => typeof value === 'string' && value.trim().length > 0;
const instant = value => Number.isSafeInteger(value) && value > 0 && !Number.isNaN(new Date(value).getTime());
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value ? epoch : null;
}
function timeValid(value) { return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function formatter(timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'iso8601',
    numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}
function localParts(format, epoch) {
  return Object.fromEntries(format.formatToParts(epoch).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function wallEpoch(p) { return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`); }
// Round-trip actual offsets around the date. Gaps/folds must not normalize.
function resolveLocal(format, date, time) {
  const wall = Date.parse(`${date}T${time}:00Z`), offsets = new Set(), matches = new Set();
  for (let h = -48; h <= 48; h += 6) {
    const probe = wall + h * 3600000;
    offsets.add(wallEpoch(localParts(format, probe)) - probe);
  }
  for (const offset of offsets) {
    const candidate = wall - offset;
    if (wallEpoch(localParts(format, candidate)) === wall) matches.add(candidate);
  }
  return matches.size === 1 ? [...matches][0] : null;
}
function validRoute(route) {
  if (!Number.isInteger(route.weekday) || route.weekday < 0 || route.weekday > 6 ||
    !timeValid(route.deliveryTime) || !Number.isSafeInteger(route.cutoff?.daysBefore) ||
    route.cutoff.daysBefore < 0 || !timeValid(route.cutoff.time) ||
    Object.keys(route.cutoff).some(k => !['daysBefore', 'time'].includes(k))) return false;
  const c = route.calendar, from = dateValue(c?.from), through = dateValue(c?.through);
  if (from === null || through === null || through < from || !Array.isArray(c.dates)) return false;
  const seen = new Set(); let regularDates = 0;
  for (const d of c.dates) {
    const epoch = dateValue(d?.date);
    if (epoch === null || epoch < from || epoch > through || seen.has(d.date) ||
      typeof d.open !== 'boolean' ||
      (Object.hasOwn(d, 'weekdayOverride') && (d.weekdayOverride !== true || !text(d.approvalReference))) ||
      Object.keys(d).some(k => !['date', 'open', 'weekdayOverride', 'approvalReference'].includes(k))) return false;
    seen.add(d.date);
    if (new Date(epoch).getUTCDay() === route.weekday) regularDates++;
    else if (d.weekdayOverride !== true || !text(d.approvalReference)) return false;
  }
  const first = from + ((route.weekday - new Date(from).getUTCDay() + 7) % 7) * DAY;
  const expected = first > through ? 0 : Math.floor((through - first) / (7 * DAY)) + 1;
  return regularDates === expected;
}
function localDate(format, epoch) {
  const p = localParts(format, epoch);
  return `${p.year}-${p.month}-${p.day}`;
}
function calendarMonthMatches(start, end, timezone) {
  const format = formatter(timezone), a = localParts(format, start), b = localParts(format, end);
  const year = Number(a.year) + (a.month === '12' ? 1 : 0);
  const month = Number(a.month) % 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Number(b.year) === year && Number(b.month) === month &&
    Number(b.day) === Math.min(Number(a.day), lastDay) &&
    ['hour', 'minute', 'second'].every(k => a[k] === b[k]) && start % 1000 === end % 1000;
}
function monthlyDate(s, input, routeId) {
  const m = s.monthly;
  if (m?.mode !== 'explicit_period_dates' || !text(m.approvalReference) ||
    !text(m.billingTimezone) || m.rollover !== 'clamp_day' || !Array.isArray(m.mappings) ||
    !calendarMonthMatches(input.periodStart, input.periodEnd, m.billingTimezone)) return null;
  const seen = new Set();
  for (const p of m.mappings) {
    if (!instant(p?.periodStart) || !instant(p?.periodEnd) || p.periodEnd <= p.periodStart ||
      dateValue(p.date) === null || !s.routes.some(r => r.id === p.routeId)) return null;
    const key = JSON.stringify([p.periodStart, p.periodEnd, p.routeId]);
    if (seen.has(key)) return null;
    seen.add(key);
  }
  const matches = m.mappings.filter(p => p.periodStart === input.periodStart && p.periodEnd === input.periodEnd && p.routeId === routeId);
  return matches.length === 1 ? matches[0].date : null;
}
function scheduleShipment(input) {
  try {
    if (!input || !['paidAt', 'evaluatedAt', 'periodStart', 'periodEnd'].every(k => instant(input[k])) ||
      input.paidAt > input.evaluatedAt || input.periodStart >= input.periodEnd) return null;
    const s = input.policy?.scheduling;
    if (!s || s.ready !== true || !text(s.version) || !text(s.approvalReference) || !text(s.timezone)) return null;
    const format = formatter(s.timezone);
    const cadenceDays = { weekly: 7, every_two_weeks: 14 }[input.cadence];
    if (input.cadence !== 'monthly' && (!cadenceDays || s.periodMapping?.mode !== 'first_eligible_market_in_paid_period' ||
      !text(s.periodMapping.approvalReference) ||
      wallEpoch(localParts(format, input.periodEnd)) - wallEpoch(localParts(format, input.periodStart)) !== cadenceDays * DAY ||
      input.periodStart % 1000 !== input.periodEnd % 1000)) return null;
    if (!Array.isArray(s.zones) || !Array.isArray(s.routes) ||
      new Set(s.zones.map(z => z.zoneId)).size !== s.zones.length ||
      new Set(s.routes.map(r => r.id)).size !== s.routes.length ||
      s.routes.some(r => !text(r.id)) || s.zones.some(z => !text(z.zoneId) ||
        !Array.isArray(z.allowedRouteIds) || !z.allowedRouteIds.length ||
        new Set(z.allowedRouteIds).size !== z.allowedRouteIds.length ||
        z.allowedRouteIds.some(id => !s.routes.some(r => r.id === id)))) return null;
    const zone = s.zones.find(z => z.zoneId === input.zoneId);
    if (!zone) return null;
    const routeId = input.routeId === undefined && zone.allowedRouteIds.length === 1
      ? zone.allowedRouteIds[0] : input.routeId;
    if (!zone.allowedRouteIds.includes(routeId)) return null;
    const route = s.routes.find(r => r.id === routeId);
    if (!route || !s.routes.every(validRoute) || route.calendar.from > localDate(format, input.periodStart) ||
      route.calendar.through < localDate(format, input.periodEnd - 1)) return null;
    const mappedDate = input.cadence === 'monthly' ? monthlyDate(s, input, routeId) : null;
    if (input.cadence === 'monthly' && mappedDate === null) return null;
    const firstDate = localDate(format, input.periodStart);
    const lastDate = localDate(format, input.periodEnd - 1);
    // Prune only whole dates outside the paid window before resolving wall times.
    // Keep boundary dates conservative: resolve gaps/folds fail-closed, then use
    // exact instants below to enforce the inclusive start and exclusive end.
    const candidates = route.calendar.dates.filter(d => d.open && d.date >= firstDate && d.date <= lastDate &&
      (!mappedDate || d.date === mappedDate) &&
      (input.selectedMarketDate === undefined || d.date === input.selectedMarketDate)).map(d => {
      const deliveryAt = resolveLocal(format, d.date, route.deliveryTime);
      const cutoffDate = new Date(dateValue(d.date) - route.cutoff.daysBefore * DAY).toISOString().slice(0, 10);
      const cutoffAt = resolveLocal(format, cutoffDate, route.cutoff.time);
      if (!instant(deliveryAt) || !instant(cutoffAt) || cutoffAt > deliveryAt - DAY) throw new Error('Unresolved or insufficient market cutoff');
      return { routeId: route.id, marketDate: d.date, timezone: s.timezone, cutoffAt, deliveryAt, schedulingVersion: s.version };
    }).filter(d => d.deliveryAt >= input.periodStart && d.deliveryAt < input.periodEnd &&
      d.cutoffAt > input.paidAt && d.cutoffAt > input.evaluatedAt && d.deliveryAt > d.cutoffAt);
    return candidates.sort((a, b) => a.deliveryAt - b.deliveryAt)[0] || null;
  } catch { return null; }
}
module.exports = { scheduleShipment };
