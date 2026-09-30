const express = require('express');
const path = require('path');
const { pool } = require('./db');
const { seed } = require('./seed');
const { SESSION_TTL, verifyPin } = require('./lib/auth');
const { localBaseUrlWarning } = require('./lib/baseurl');
const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const orderRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const reportRoutes = require('./routes/reports');
const streamRoutes = require('./routes/stream');
const kitchenRoutes = require('./routes/kitchen');
const voiceRoutes = require('./routes/voice');
const cardRoutes = require('./routes/cards');
const featureRoutes = require('./routes/features');
const expenseRoutes = require('./routes/expenses');

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
  // The microphone is allowed for this origin only, and only because "Speak to
  // Order" needs it; geolocation and camera stay switched off entirely.
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=()');
  next();
});

// Voice posts one short recording as base64, which does not fit in the limit
// the rest of the API wants. Mounted first and path-scoped: body-parser marks
// the request parsed, so the 256kb limit below still governs every other route.
app.use('/api/public/voice', express.json({ limit: '1500kb' }));
// A receipt photo or a voice note (base64, downscaled on the phone first).
app.use('/api/expenses/extract', express.json({ limit: '5mb' }));
app.use(express.json({ limit: '256kb' }));
/* Which build of the screens this server hands out: a hash of everything in
   public/, worked out once at boot. A till compares it with the one it loaded
   and reloads itself (when nobody is mid-bill) after an update, so a page left
   open through a deploy can't keep running the old code (review N2). */
const APP_VERSION = (() => {
  const crypto = require('crypto');
  const fs = require('fs');
  const hash = crypto.createHash('sha1');
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else hash.update(e.name).update(fs.readFileSync(full));
    });
  walk(path.join(__dirname, '..', 'public'));
  return hash.digest('hex').slice(0, 12);
})();
app.get('/api/version', (req, res) => res.set('Cache-Control', 'no-store').json({ version: APP_VERSION }));

/* The service worker's cache is named after that version, so every update
   that changes a screen installs a fresh cache and drops the old one — a
   reload can't be served yesterday's files from it. */
const SW_SOURCE = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')
  .replace(/const CACHE_VERSION = '([^']+)';/, (m, v) => `const CACHE_VERSION = '${v}-${APP_VERSION}';`);
app.get('/sw.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(SW_SOURCE));
// The staff page carries its own build in a meta tag — even the copy the
// service worker serves from its cache — so a till knows exactly what it runs.
const INDEX_SOURCE = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace('<meta name="app-version" content="">', `<meta name="app-version" content="${APP_VERSION}">`);
app.get('/index.html', (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(INDEX_SOURCE));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(authRoutes);
app.use(publicRoutes);
app.use(orderRoutes);
app.use(adminRoutes);
app.use(reportRoutes);
app.use(streamRoutes);
app.use(kitchenRoutes);
app.use(voiceRoutes);
app.use(cardRoutes);
app.use(featureRoutes);
app.use(expenseRoutes);

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
    app.listen(port, () => {
      console.log(`POS API + static on :${port}`);
      const warning = process.env.NODE_ENV === 'production' && localBaseUrlWarning();
      if (warning) console.warn(warning);
    });
  } catch (e) {
    if (retries <= 0) { console.error('Failed to boot:', e); process.exit(1); }
    console.log('DB not ready, retrying in 2s…');
    setTimeout(() => boot(retries - 1), 2000);
  }
}
boot();
