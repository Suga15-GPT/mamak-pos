const express = require('express');
const path = require('path');
const { pool } = require('./db');
const { seed } = require('./seed');
const { SESSION_TTL, verifyPin } = require('./lib/auth');
const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const orderRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const reportRoutes = require('./routes/reports');
const streamRoutes = require('./routes/stream');

const app = express();

// #26: without this, every request behind any reverse proxy appears to come
// from one IP (the proxy's), and the login limiter locks out the whole
// restaurant on the tenth wrong PIN of the day. Opt-in via TRUST_PROXY=1 —
// trusting X-Forwarded-For unconditionally would let an attacker forge their
// own IP and walk straight through the limiter.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Hand-written — no helmet dependency (house style: no new deps the prompt
// didn't name). Phase 01 already removed every inline event handler, which
// is what makes a script-src without 'unsafe-inline' possible here.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(authRoutes);
app.use(publicRoutes);
app.use(orderRoutes);
app.use(adminRoutes);
app.use(reportRoutes);
app.use(streamRoutes);

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
    // #36: the values in git history (commit 1be1d73) are still exposed —
    // rotating the password/PIN is documented in docs/RUNBOOK.md, but a
    // production boot with an admin still on the well-known default PIN is
    // refused outright rather than trusted to a reminder. Checks the actual
    // stored PIN, not the ADMIN_PIN env var (which only matters for the very
    // first seed and may be stale on every later boot).
    if (process.env.NODE_ENV === 'production') {
      const admins = await pool.query("SELECT pin_hash FROM users WHERE role = 'admin' AND active");
      if (admins.rows.some(u => verifyPin('1234', u.pin_hash))) {
        console.error('Refusing to boot: an active admin account still uses the default PIN 1234. '
          + 'Change it (Admin -> Staff & PINs, or POST /api/me/pin) and restart.');
        process.exit(1);
      }
    }
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
