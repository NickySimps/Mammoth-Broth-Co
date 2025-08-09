import React from 'react';
import './StorePage.css';
import { useCart } from '../context/CartContext';

const products = [
  { id: 1, name: 'Beef Broth', price: 10 },
  { id: 2, name: 'Chicken Broth', price: 9 },
  { id: 3, name: 'Vegetable Broth', price: 8 },
];

const StorePage = () => {
  const { addToCart } = useCart();

  return (
    <div className="store-page">
      <h1>Our Products</h1>
      <div className="product-grid">
        {products.map(product => (
          <div key={product.id} className="product-card">
            <h2>{product.name}</h2>
            <p>${product.price}</p>
            <button onClick={() => addToCart(product)}>Add to Cart</button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default StorePage;