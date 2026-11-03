// Approved server-owned delivery zones shared by delivery policy regressions.
const deliveryPolicy = () => ({
  enabled: true, state: 'FL', minimumJars: 6, cutoffHours: 48,
  zones: [
    { id: 'jacksonville', feeCents: 1000, allowedZips: ['32204', '32205'] },
    { id: 'surrounding', feeCents: 1500, allowedZips: ['32233', '32082'] },
  ],
});

module.exports = { deliveryPolicy };
