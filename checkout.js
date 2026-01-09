import { saveOrder } from './store.js';

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