const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 5000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.post('/api/signup', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  console.log(`New email signup: ${email}`);
  // Here you would typically save the email to a database
  res.status(200).json({ message: 'Thank you for signing up!' });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
