const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const {
  verifyPin, hashPin, pinPolicyError, rateLimit, requireRole,
  parseCookies, setSessionCookie, clearSessionCookie,
} = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { writeAudit } = require('../services/orders');

const router = express.Router();

router.post('/api/login', awaitH(async (req, res) => {
  if (!rateLimit('login:' + req.ip, 10, 10 * 60 * 1000))
    return res.status(429).json({ error: 'too many login attempts, try again later' });
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name and pin required' });
  const r = await pool.query('SELECT * FROM users WHERE lower(name) = lower($1) AND active', [name.trim()]);
  const u = r.rows[0];
  if (!u || !verifyPin(pin, u.pin_hash)) return res.status(401).json({ error: 'wrong name or PIN' });

  // Session fixation: never extend whatever session this browser already
  // carried into the newly-authenticated one — always issue a fresh id.
  const existingSid = parseCookies(req).sid;
  if (existingSid) await pool.query('DELETE FROM sessions WHERE token = $1', [existingSid]);

  const token = crypto.randomBytes(24).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO sessions (token, user_id, csrf_token) VALUES ($1,$2,$3)', [token, u.id, csrfToken]);
  setSessionCookie(res, req, token);
  res.json({ csrf_token: csrfToken, name: u.name, role: u.role, must_change_pin: u.must_change_pin });
}));

router.post('/api/logout', awaitH(async (req, res) => {
  const token = parseCookies(req).sid;
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  clearSessionCookie(res, req);
  res.json({ ok: true });
}));

// Any authenticated role may change their own PIN — this is the one route
// (besides /api/logout) still reachable while must_change_pin is set.
router.post('/api/me/pin', requireRole(), awaitH(async (req, res) => {
  const { current_pin, new_pin } = req.body || {};
  const u = (await pool.query('SELECT pin_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!current_pin || !verifyPin(current_pin, u.pin_hash)) return res.status(401).json({ error: 'wrong current PIN' });
  const policyError = pinPolicyError(new_pin, u.pin_hash);
  if (policyError) return res.status(400).json({ error: policyError });

  await pool.query(
    'UPDATE users SET pin_hash = $1, must_change_pin = false, pin_changed_at = now() WHERE id = $2',
    [hashPin(new_pin), req.user.id]);
  // A PIN change that leaves an already-stolen session alive has achieved
  // nothing — kill every other session of this user, but not the one that
  // just proved it knows the new PIN.
  await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [req.user.id, req.token]);
  await writeAudit(pool, { userId: req.user.id, action: 'user.pin_change', entityType: 'user', entityId: req.user.id, detail: {} });
  res.json({ ok: true });
}));

module.exports = router;
