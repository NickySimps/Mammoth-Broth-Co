import React from 'react';
import { Link } from 'react-router-dom';
import './Navigation.css';
import mammothLogo from '../assets/mammothlogo.png';
import { useCart } from '../context/CartContext';

const Navigation = () => {
  const { cartItems } = useCart();
  const numItems = cartItems.reduce((acc, item) => acc + item.quantity, 0);

  return (
    <nav className="navbar">
      <div className="nav-container">
        <Link to="/" className="nav-logo">
          <img src={mammothLogo} alt="Mammoth Broth Co. Logo" style={{width: "100px"}} />
        </Link>
        <ul className="nav-menu">
          <li className="nav-item">
            <Link to="/" className="nav-links">Home</Link>
          </li>
          <li className="nav-item">
            <Link to="/about" className="nav-links">About</Link>
          </li>
          <li className="nav-item">
            <Link to="/store" className="nav-links">Store</Link>
          </li>
          <li className="nav-item">
            <Link to="/blog" className="nav-links">Blog</Link>
          </li>
          <li className="nav-item">
            <Link to="/contact" className="nav-links">Contact</Link>
          </li>
          <li className="nav-item">
            <Link to="/cart" className="nav-links">
              Cart ({numItems})
            </Link>
          </li>
        </ul>
      </div>
    </nav>
  );
};

export default Navigation;