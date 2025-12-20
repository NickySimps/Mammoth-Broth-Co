import { saveOrder } from './store.js';

const modal = document.getElementById('confirmationModal');
const closeButton = document.querySelector('.close-button');
const orderNumberSpan = document.getElementById('orderNumber');

// --- Adjective-Animal Generator ---
const adjectives = [
  'Ancient', 'Primal', 'Mighty', 'Woolly', 'Savage', 'Wild', 'Fierce', 'Noble',
  'Stoic', 'Brave', 'Bold', 'Rough', 'Tough', 'Heavy', 'Strong', 'Loyal',
  'Swift', 'Grand', 'Epic', 'Raw', 'Pure', 'Deep', 'Rich', 'Stout'
];

const animals = [
  'Mammoth', 'Mastodon', 'Saber', 'Tiger', 'Wolf', 'Bear', 'Bison', 'Elk',
  'Stag', 'Hawk', 'Eagle', 'Boar', 'Rhino', 'Sloth', 'Lion', 'Ox',
  'Ram', 'Bull', 'Fox', 'Raven', 'Owl', 'Horse', 'Yak', 'Moose'
];

function generateOrderName() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  const number = Math.floor(Math.random() * 100) + 1; // Add a small number for extra uniqueness
  return `${adj}-${animal}-${number}`;
}

if (closeButton) {
    closeButton.addEventListener('click', () => {
      modal.style.display = 'none';
    });
}

window.addEventListener('click', (event) => {
  if (event.target === modal) {
    modal.style.display = 'none';
  }
});

export async function checkout(order) {
  try {
    // Generate a human-readable order ID
    const orderName = generateOrderName();
    
    // Attach it to the order object before saving
    const orderWithId = { ...order, orderName };
    
    await saveOrder(orderWithId);
    
    // Display the fun name to the user
    if (orderNumberSpan) {
        orderNumberSpan.textContent = orderName;
    }
    
    if (modal) {
        modal.style.display = 'block';
    }
    
  } catch (error) {
    console.error("Error during checkout: ", error);
    alert(`Error placing order: ${error.message}`);
  }
}