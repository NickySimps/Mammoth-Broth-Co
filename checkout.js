import { createPreorder } from './store.js';
import { openDialog, closeDialog } from './dialog.mjs';

const modal = document.getElementById('confirmationModal');
const closeButton = document.querySelector('#confirmationModal .close-button');
const orderNumberSpan = document.getElementById('orderNumber');
let pendingSubmission = null;

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
      closeDialog(modal);
    });
}

window.addEventListener('click', (event) => {
  if (event.target === modal) {
    closeDialog(modal);
  }
});

export async function checkout(order) {
  try {
    const signature = JSON.stringify([order.cart, order.customerName, order.customerEmail, order.fulfillmentMethod, order.marketId, order.pickupDate, order.deliveryAddress, order.specialNotes, order.paymentMethod]);
    if (!pendingSubmission || pendingSubmission.signature !== signature) {
      const name = generateOrderName();
      pendingSubmission = {
        signature,
        orderName: name,
        key: globalThis.crypto?.randomUUID?.() || `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      };
    }
    const orderName = pendingSubmission.orderName;
    
    // Attach it to the order object before saving
    const orderWithId = { ...order, orderName };
    
    let serverOrder = null;
    try {
      const result = await createPreorder({
        cart: orderWithId.cart,
        customerName: orderWithId.customerName,
        customerEmail: orderWithId.customerEmail,
        fulfillmentMethod: orderWithId.fulfillmentMethod,
        marketId: orderWithId.marketId || null,
        pickupDate: orderWithId.pickupDate || null,
        deliveryAddress: orderWithId.deliveryAddress || null,
        specialNotes: orderWithId.specialNotes || '',
        paymentMethod: orderWithId.paymentMethod,
        idempotencyKey: pendingSubmission.key,
        orderName: orderWithId.orderName
      });
      serverOrder = result.data;
    } catch (error) {
      console.error('Secure preorder function unavailable; order was not submitted.', error);
      throw error;
    }
    if (!serverOrder?.orderId) throw new Error('The server did not confirm an order reference.');
    orderWithId.firestoreId = serverOrder.orderId;
    pendingSubmission = null;
    if (Number.isFinite(serverOrder.totalAmount)) orderWithId.totalAmount = serverOrder.totalAmount;
    // Browser history is a convenience, not the source of truth for a saved order.
    try {
      let saved = [];
      try {
        const history = JSON.parse(localStorage.getItem('mammothOrders') || '[]');
        if (Array.isArray(history)) saved = history;
      } catch (error) {
        console.warn('Local order history could not be read.', error);
      }
      saved.unshift(orderWithId);
      localStorage.setItem('mammothOrders', JSON.stringify(saved));
    } catch (error) {
      console.warn('Order saved securely, but local order history could not be updated.', error);
    }
    // The orders onCreate function owns confirmation emails. Do not send twice.
    
    // Display the fun name to the user
    if (orderNumberSpan) {
        orderNumberSpan.textContent = orderName;
    }
    
    if (modal) {
        const isSpecial = orderWithId.fulfillmentMethod === 'special_order';
        const title = document.getElementById('confirmation-title');
        const details = document.getElementById('confirmation-details');
        if (title) title.textContent = isSpecial ? 'Request received' : 'Order received';
        if (details) details.textContent = isSpecial ? 'Your special-order request is awaiting approval. We will contact you before fulfillment or payment.' : 'Your preorder has been saved. Bring your reference ID to pickup.';
        openDialog(modal);
    }
    return orderWithId;
  } catch (error) {
    console.error("Error during checkout: ", error);
    alert(`Order could not be submitted: ${error.message}`);
    return null;
  }
}