const express = require('express');
const bodyParser = require('body-parser');
const { confirmationEmail, confirmationText } = require('./email-template');

const app = express();
const port = process.env.PORT || 5000;
app.use(bodyParser.json({ limit: '100kb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.post('/api/signup', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  console.log(`New email signup: ${email}`);
  res.status(200).json({ message: 'Thank you for signing up!' });
});

app.post('/api/preorder-confirmation', async (req, res) => {
  const order = req.body || {};
  if (!order.customerEmail || !order.orderName) return res.status(400).json({ error: 'A customer email and order name are required.' });
  const html = confirmationEmail(order);
  if (!process.env.RESEND_API_KEY) {
    return res.status(202).json({ delivered: false, preview: true, message: 'Email preview generated. Set RESEND_API_KEY and FROM_EMAIL to deliver email.' });
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.FROM_EMAIL || 'Mammoth Broth Co. <orders@mammothbroth.com>', to: [order.customerEmail], subject: `Your Mammoth preorder ${order.orderName} is reserved`, html, text: confirmationText(order) })
    });
    const result = await response.json();
    if (!response.ok) return res.status(502).json({ error: 'Email provider rejected the message.', detail: result });
    return res.status(200).json({ delivered: true, id: result.id });
  } catch (error) {
    return res.status(502).json({ error: 'Confirmation email could not be delivered.' });
  }
});

app.listen(port, () => console.log(`Server listening on port ${port}`));
