import { qrcode } from './vendor/qrcode-generator.mjs';
import { staffOrderHref } from './order-lookup.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function clearOrderQr(document) {
  const section = document.getElementById('receipt-order-qr');
  if (!section) return;
  section.hidden = true;
  document.getElementById('receipt-order-code').replaceChildren();
  document.getElementById('receipt-order-reference').textContent = '';
  document.getElementById('receipt-order-link').removeAttribute('href');
}

// Only the staff locator goes into the matrix: never the receipt capability or PII.
export function showOrderQr(document, receipt) {
  clearOrderQr(document);
  const section = document.getElementById('receipt-order-qr');
  if (!section) return;
  const href = staffOrderHref(receipt.orderId);
  const qr = qrcode(0, 'M');
  qr.addData(href, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  const node = (tag, attributes) => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  };
  const svg = node('svg', {
    viewBox: `0 0 ${size} ${size}`, width: 280, height: 280,
    role: 'img', 'aria-label': 'Staff order lookup QR code. Staff sign-in required.',
    'shape-rendering': 'crispEdges'
  });
  svg.append(node('rect', { x: 0, y: 0, width: size, height: size, fill: '#fff' }));
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) svg.append(node('rect', {
        x: col + quiet, y: row + quiet, width: 1, height: 1, fill: '#000'
      }));
    }
  }
  document.getElementById('receipt-order-code').replaceChildren(svg);
  document.getElementById('receipt-order-link').href = href;
  document.getElementById('receipt-order-reference').textContent = `Reference: ${receipt.orderName || receipt.orderId}`;
  section.hidden = false;
}
