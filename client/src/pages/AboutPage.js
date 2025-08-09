import React from 'react';
import './AboutPage.css';

const AboutPage = () => {
  return (
    <div className="about-page">
      <h1>About Mammoth Broth Co.</h1>
      <section>
        <h2>Our Story</h2>
        <p>Insert company story here.</p>
      </section>
      <section>
        <h2>Sustainability</h2>
        <p>Insert sustainability practices here.</p>
      </section>
      <section>
        <h2>Sourcing</h2>
        <p>Insert sourcing philosophy here.</p>
      </section>
    </div>
  );
};

export default AboutPage;