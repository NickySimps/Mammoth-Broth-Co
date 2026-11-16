const PHOTO_BY_PRODUCT_ID = Object.freeze({
  prod_beef: 'assets/mammoth-products/beef-bone-broth.webp',
  prod_chicken: 'assets/mammoth-products/chicken-bone-broth.webp',
  mushroom: 'assets/mammoth-products/mushroom-broth.webp',
});
const FALLBACK_IMAGE = 'assets/mammothbrothlogo.jpg';

export function resolveProductImage(product) {
  if (!product || typeof product !== 'object') return FALLBACK_IMAGE;
  const id = typeof product.id === 'string' ? product.id : '';
  if (Object.hasOwn(PHOTO_BY_PRODUCT_ID, id)) return PHOTO_BY_PRODUCT_ID[id];
  const configured = typeof product.imageUrl === 'string' ? product.imageUrl.trim() : '';
  return configured || FALLBACK_IMAGE;
}
