// An order locator is not an authorization token. Staff must sign in independently.
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function staffOrderHref(orderId) {
  if (!validId(orderId)) throw new Error('Invalid order reference');
  return `https://mammothbroth.com/staff.html#order=${encodeURIComponent(orderId)}`;
}
export function readStaffOrder(hash) {
  if (typeof hash !== 'string' || !/^#order=[A-Za-z0-9_-]{1,128}$/.test(hash)) return null;
  const id = hash.slice(7);
  return validId(id) ? id : null;
}
