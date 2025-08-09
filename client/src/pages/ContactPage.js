import React from 'react';
import './ContactPage.css';

const ContactPage = () => {
  return (
    <div className="contact-page">
      <h1>Contact Us</h1>
      <div className="contact-info">
        <p>123 Broth Avenue, Flavor Town, USA</p>
        <p>Open Monday - Friday, 9am - 5pm</p>
      </div>
      <form>
        <input type="text" placeholder="Your Name" />
        <input type="email" placeholder="Your Email" />
        <textarea placeholder="Your Message"></textarea>
        <button>Send</button>
      </form>
    </div>
  );
};

export default ContactPage;