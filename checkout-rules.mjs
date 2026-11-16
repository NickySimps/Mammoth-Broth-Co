export const FULFILLMENT_METHODS = Object.freeze({ MARKET_PICKUP: 'market_pickup' });

export function validateFulfillment({ method, marketId = '', pickupDate = '', allowedPickupDates }) {
  if (method !== FULFILLMENT_METHODS.MARKET_PICKUP) return ['Only market pickup is available.'];
  const errors = [];
  if (!marketId) errors.push('Choose a market pickup location.');
  if (!pickupDate) errors.push('Choose a pickup date.');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate) || (allowedPickupDates !== undefined && !allowedPickupDates.includes(pickupDate))) errors.push('Choose an available listed pickup date for this market.');
  return errors;
}
