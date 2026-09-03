const express = require('express');
const path = require('path');
const { pool } = require('./db');
const { seed } = require('./seed');
const { SESSION_TTL } = require('./lib/auth');
const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const orderRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const reportRoutes = require('./routes/reports');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(authRoutes);
app.use(publicRoutes);
app.use(orderRoutes);
app.use(adminRoutes);
app.use(reportRoutes);

/* customer page route */
app.get('/t/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'customer', 'index.html'), err => {
    if (err) res.type('text/plain').send('Customer page not deployed yet.');
  });
});

app.get('/', (req, res) => res.redirect('/index.html'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

async function boot(retries = 15) {
  try {
    await seed();
    setInterval(() => {
      pool.query(`DELETE FROM sessions WHERE created_at < now() - interval '${SESSION_TTL}'`)
        .catch(e => console.error('session cleanup failed:', e.message));
    }, 60 * 60 * 1000);
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`POS API + static on :${port}`));
  } catch (e) {
    if (retries <= 0) { console.error('Failed to boot:', e); process.exit(1); }
    console.log('DB not ready, retrying in 2s…');
    setTimeout(() => boot(retries - 1), 2000);
  }
}
boot();
