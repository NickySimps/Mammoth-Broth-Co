export const FULFILLMENT_METHODS = Object.freeze({
  MARKET_PICKUP: 'market_pickup',
  LOCAL_DELIVERY: 'local_delivery',
  SPECIAL_ORDER: 'special_order'
});

export function validateFulfillment({
  method,
  totalJars,
  marketId = '',
  pickupDate = '',
  deliveryAddress = {},
  notes = ''
}) {
  const errors = [];
  const jars = Number(totalJars || 0);

  if (!Object.values(FULFILLMENT_METHODS).includes(method)) {
    errors.push('Choose how you would like to receive your broth.');
    return errors;
  }

  if (method === FULFILLMENT_METHODS.MARKET_PICKUP) {
    if (!marketId) errors.push('Choose a market pickup location.');
    if (!pickupDate) errors.push('Choose a pickup date.');
  }

  if (method === FULFILLMENT_METHODS.LOCAL_DELIVERY) {
    if (jars < 5) errors.push('Monday local delivery requires at least 5 jars.');
    const requiredAddress = ['street', 'city', 'state', 'zip'];
    if (requiredAddress.some(field => !String(deliveryAddress[field] || '').trim())) {
      errors.push('Enter the complete local delivery address.');
    }
  }

  if (method === FULFILLMENT_METHODS.SPECIAL_ORDER && String(notes).trim().length < 10) {
    errors.push('Add notes describing your special order (at least 10 characters).');
  }

  return errors;
}
