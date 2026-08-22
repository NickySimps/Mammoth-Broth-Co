import { createPreorder } from './store.js';

const modal = document.getElementById('confirmationModal');
const closeButton = document.querySelector('.close-button');
const orderNumberSpan = document.getElementById('orderNumber');

// --- Adjective-Animal Generator ---
const adjectives = [
  'Ancient', 'Primal', 'Mighty', 'Woolly', 'Savage', 'Wild', 'Fierce', 'Noble',
  'Stoic', 'Brave', 'Bold', 'Rough', 'Tough', 'Heavy', 'Strong', 'Loyal',
  'Swift', 'Grand', 'Epic', 'Raw', 'Pure', 'Deep', 'Rich', 'Stout',
  'Golden', 'Silver', 'Iron', 'Frost', 'Fire', 'Storm', 'Thunder', 'Arctic',
  'Tundra', 'Forest', 'Mountain', 'River', 'Steppe', 'Canyon', 'Desert', 'Glacier',
  'Obsidian', 'Flint', 'Bone', 'Amber', 'Eternal', 'Legendary', 'Elder', 'Hunter',
  'Gatherer', 'Shaman', 'Guardian', 'Sentinel', 'Warrior', 'Ranger', 'Pathfinder', 'Wayfarer',
  'Wanderer', 'Nomad', 'Seeker', 'Dreamer', 'Spirit', 'Ghost', 'Shadow', 'Light',
  'Bright', 'Dark', 'Hidden', 'Sacred', 'Lost', 'Forgotten', 'Found', 'Chosen',
  'Radiant', 'Luminous', 'Verdant', 'Azure', 'Crimson', 'Emerald', 'Sapphire', 'Vibrant',
  'Mellow', 'Crisp', 'Sharp', 'Keen', 'Smooth', 'Coarse', 'Velvet', 'Enduring',
  'Resilient', 'Unbroken', 'Steadfast', 'Vigilant', 'Gallant', 'Valiant', 'Heroic', 'Glorious',
  'Majestic', 'Regal', 'Imperial', 'Supreme', 'Absolute', 'Infinite', 'Apex', 'Prime'
];

const animals = [
  'Mammoth', 'Mastodon', 'Saber', 'Tiger', 'Wolf', 'Bear', 'Bison', 'Elk',
  'Stag', 'Hawk', 'Eagle', 'Boar', 'Rhino', 'Sloth', 'Lion', 'Ox',
  'Ram', 'Bull', 'Fox', 'Raven', 'Owl', 'Horse', 'Yak', 'Moose',
  'Lynx', 'Cougar', 'Panther', 'Falcon', 'Condor', 'Vulture', 'Coyote', 'Badger',
  'Beaver', 'Otter', 'Salmon', 'Trout', 'Whale', 'Seal', 'Walrus', 'Narwhal',
  'Caribou', 'Antelope', 'Gazelle', 'Zebra', 'Hyena', 'Jackal', 'Leopard', 'Cheetah',
  'Gorilla', 'Chimp', 'Orangutan', 'Monkey', 'Lemur', 'Panda', 'Koala', 'Kangaroo',
  'Wombat', 'Platypus', 'Emu', 'Cassowary', 'Dingo', 'Tasmanian', 'Quokka', 'Wallaby',
  'Jaguar', 'Ocelot', 'Serval', 'Caracal', 'Bobcat', 'Grizzly', 'Polar', 'Sun-Bear',
  'Moon-Bear', 'Sloth-Bear', 'Spectacled-Bear', 'Cobra', 'Viper', 'Mamba', 'Python', 'Anaconda',
  'Boa', 'Monitor', 'Iguana', 'Gecko', 'Chameleon', 'Turtle', 'Tortoise', 'Crocodile',
  'Alligator', 'Caiman', 'Gharial', 'Shark', 'Ray', 'Manta', 'Dolphin', 'Porpoise',
  'Orca', 'Beluga', 'Bowhead', 'Humpback', 'Sparrow', 'Robin', 'Bluejay', 'Cardinal'
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
    
    let serverOrder = null;
    try {
      const result = await createPreorder({
        cart: orderWithId.cart,
        customerName: orderWithId.customerName,
        customerEmail: orderWithId.customerEmail,
        marketId: orderWithId.marketId,
        pickupDate: orderWithId.pickupDate,
        paymentMethod: orderWithId.paymentMethod,
        idempotencyKey: orderWithId.orderName,
        orderName: orderWithId.orderName
      });
      serverOrder = result.data;
    } catch (error) {
      console.warn('Secure preorder function unavailable; keeping a local development fallback only.', error);
    }
    if (serverOrder?.orderId) orderWithId.firestoreId = serverOrder.orderId;
    const saved = JSON.parse(localStorage.getItem('mammothOrders') || '[]');
    saved.unshift(orderWithId);
    localStorage.setItem('mammothOrders', JSON.stringify(saved));

    try {
      await fetch('/api/preorder-confirmation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderWithId) });
    } catch (error) {
      console.info('Confirmation endpoint unavailable; the on-screen confirmation is still complete.', error);
    }
    
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