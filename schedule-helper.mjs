// Calendar arithmetic uses UTC only after deriving the market's local day.
export function nextPickupDate(market, now = new Date()) {
    if (!market || typeof market.timezone !== 'string' || !market.timezone) return '';
    let today;
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: market.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
        const part = type => parts.find(p => p.type === type).value;
        today = `${part('year')}-${part('month')}-${part('day')}`;
    } catch { return ''; }
    if (market.pickupDates !== undefined) {
        const dates = market.pickupDates;
        if (!Array.isArray(dates) || !dates.length || dates.some(d => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d + 'T00:00:00Z')) || new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d)) return '';
        return dates.filter(d => d > today).sort()[0] || '';
    }
    const weekday = market.weekday ?? market.day;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || (market.weekday !== undefined && market.day !== undefined && market.weekday !== market.day)) return '';
    const midnight = new Date(today + 'T00:00:00Z');
    const days = (weekday - midnight.getUTCDay() + 7) % 7 || 7;
    return new Date(midnight.getTime() + days * 86400000).toISOString().slice(0, 10);
}
