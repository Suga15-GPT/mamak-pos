const crypto = require('crypto');
const { pool } = require('../db');

const SESSION_TTL = '12 hours';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function hashPin(pin) {
  const salt = crypto.randomBytes(8).toString('hex');
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `s:${salt}:${h}`;
}
function verifyPin(pin, stored) {
  try {
    const [, salt, h] = stored.split(':');
    const t = crypto.scryptSync(String(pin), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(t, 'hex'));
  } catch { return false; }
}

// 4-8 digits; reject all-same (0000), sequential runs (1234, 4321), and reuse
// of the existing PIN (compared via its hash, so this works whether the
// caller is changing their own PIN or an admin is resetting someone else's).
// Deliberately not stricter than this — staff type a PIN a hundred times a
// shift; the real defence is the login rate limit plus the audit trail.
function pinPolicyError(pin, existingHash) {
  const s = String(pin == null ? '' : pin);
  if (!/^\d{4,8}$/.test(s)) return 'PIN must be 4-8 digits';
  if (/^(\d)\1+$/.test(s)) return 'PIN cannot be all the same digit';
  const digits = [...s].map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return 'PIN cannot be a sequential run';
  if (existingHash && verifyPin(s, existingHash)) return 'new PIN must be different from the current PIN';
  return null;
}

// No cookie-parser dependency (house style: no new deps without the prompt
// naming one) — cookies are simple enough to parse/set by hand.
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

// `req.secure` reflects X-Forwarded-Proto once `trust proxy` is enabled
// (server.js, TRUST_PROXY=1) — Secure is added automatically over HTTPS and
// left off for plain-HTTP local dev, never hardcoded either way.
function setSessionCookie(res, req, token) {
  const parts = [`sid=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_TTL_SECONDS}`];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res, req) {
  const parts = ['sid=', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function csrfOk(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
// The only two routes reachable while a user's must_change_pin flag is set —
// everything else is 403 until they pick a new PIN (POST /api/login itself
// doesn't go through requireRole, so it isn't in this list).
const PIN_CHANGE_EXEMPT_PATHS = new Set(['/api/me/pin', '/api/logout']);

/* plain Express middleware factory: requireRole('admin', 'staff')(req, res, next) */
function requireRole(...roles) {
  return async (req, res, next) => {
    const token = parseCookies(req).sid;
    if (!token) return res.status(401).json({ error: 'login required' });
    const r = await pool.query(
      `SELECT u.id, u.name, u.role, u.must_change_pin, s.csrf_token
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.created_at > now() - interval '${SESSION_TTL}' AND u.active`, [token]);
    if (!r.rows[0]) return res.status(401).json({ error: 'invalid session' });
    req.user = r.rows[0];
    req.token = token;
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    if (MUTATING_METHODS.has(req.method) && !csrfOk(req.headers['x-csrf-token'], req.user.csrf_token)) {
      return res.status(403).json({ error: 'bad csrf token' });
    }
    if (req.user.must_change_pin && !PIN_CHANGE_EXEMPT_PATHS.has(req.path)) {
      return res.status(403).json({ error: 'pin_change_required' });
    }
    pool.query('UPDATE sessions SET last_seen_at = now() WHERE token = $1', [token]).catch(() => {});
    next();
  };
}

// One entry per rate-limited key (e.g. "login:1.2.3.4"), forever, unless
// swept — #30. rateLimit() itself already drops timed-out attempts from a key
// it touches; this reclaims keys nobody's touched in a while so the Map
// doesn't grow without bound from one-off/rotating IPs.
const rl = new Map();
const RL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RL_MAX_IDLE_MS = 30 * 60 * 1000; // longer than any window this app uses
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (rl.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { rl.set(key, arr); return false; }
  arr.push(now); rl.set(key, arr); return true;
}

// Split check/record, for the login limiter: a *successful* login is proof the
// PIN is known, so it must not spend the brute-force budget. Counting it did —
// which locked out a whole restaurant behind one router IP during a shift
// change, exactly the failure `trust proxy` was added to avoid (server.js).
function rateLimitExceeded(key, max, windowMs) {
  const now = Date.now();
  const arr = (rl.get(key) || []).filter(t => now - t < windowMs);
  rl.set(key, arr);
  return arr.length >= max;
}
function rateLimitRecord(key, windowMs) {
  const now = Date.now();
  const arr = (rl.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  rl.set(key, arr);
}
const rlSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of rl) {
    if (!arr.length || now - arr[arr.length - 1] > RL_MAX_IDLE_MS) rl.delete(key);
  }
}, RL_SWEEP_INTERVAL_MS);
rlSweepTimer.unref();

module.exports = {
  SESSION_TTL, hashPin, verifyPin, pinPolicyError, requireRole,
  rateLimit, rateLimitExceeded, rateLimitRecord,
  parseCookies, setSessionCookie, clearSessionCookie, csrfOk,
};
