const crypto = require('crypto');
const { pool } = require('../db');

const SESSION_TTL = '12 hours';

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

/* plain Express middleware factory: requireRole('admin', 'staff')(req, res, next) */
function requireRole(...roles) {
  return async (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return res.status(401).json({ error: 'login required' });
    const r = await pool.query(
      `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.created_at > now() - interval '${SESSION_TTL}'`, [token]);
    if (!r.rows[0]) return res.status(401).json({ error: 'invalid session' });
    req.user = r.rows[0];
    req.token = token;
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

const rl = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (rl.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now); rl.set(key, arr); return true;
}

module.exports = { SESSION_TTL, hashPin, verifyPin, requireRole, rateLimit };
