import React from 'react';
import Hero from '../components/Hero';
import About from '../components/About';
import FeaturedProducts from '../components/FeaturedProducts';
import Testimonials from '../components/Testimonials';
import EmailSignup from '../components/EmailSignup';
import './HomePage.css';

const HomePage = () => {
  return (
    <div className="home-page">
      <Hero />
      <About />
      <FeaturedProducts />
      <Testimonials />
      <EmailSignup />
    </div>
  );
};

export default HomePage;