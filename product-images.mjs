const PHOTO_BY_PRODUCT_ID = Object.freeze({
  prod_beef: 'assets/mammoth-products/beef-bone-broth.webp',
  prod_chicken: 'assets/mammoth-products/chicken-bone-broth.webp',
  mushroom: 'assets/mammoth-products/mushroom-broth.webp',
});
const FALLBACK_IMAGE = 'assets/mammothbrothlogo.jpg';
const GALLERY_PHOTOS = Object.freeze({
  prod_beef: ['beef-bone-broth.webp', 'beef-broth-display.webp'],
  prod_chicken: ['chicken-bone-broth.webp', 'chicken-broth-display.webp'],
  mushroom: ['mushroom-broth.webp', 'mushroom-broth-display.webp'],
});

export function resolveProductImages(product) {
  const title = typeof product?.name === 'string' && product.name.trim() ? product.name.trim() : 'Broth';
  const id = typeof product?.id === 'string' ? product.id : '';
  const lead = resolveProductImage(product);
  const additional = GALLERY_PHOTOS[id] || [];
  return [
    { src: lead, alt: `${title} jar, lid label` },
    ...additional.slice(1).map((file, index) => ({
      src: `assets/mammoth-products/${file}`,
      alt: `${title} jar displayed with Mammoth Broth sign and bones${index ? ` ${index + 1}` : ''}`,
    })),
  ];
}

export function resolveProductImage(product) {
  if (!product || typeof product !== 'object') return FALLBACK_IMAGE;
  const id = typeof product.id === 'string' ? product.id : '';
  if (Object.hasOwn(PHOTO_BY_PRODUCT_ID, id)) return PHOTO_BY_PRODUCT_ID[id];
  const configured = typeof product.imageUrl === 'string' ? product.imageUrl.trim() : '';
  return configured || FALLBACK_IMAGE;
}
