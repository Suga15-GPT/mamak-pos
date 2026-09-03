const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { verifyPin, rateLimit } = require('../lib/auth');
const { awaitH } = require('../lib/errors');

const router = express.Router();

router.post('/api/login', awaitH(async (req, res) => {
  if (!rateLimit('login:' + req.ip, 10, 10 * 60 * 1000))
    return res.status(429).json({ error: 'too many login attempts, try again later' });
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name and pin required' });
  const r = await pool.query('SELECT * FROM users WHERE lower(name) = lower($1)', [name.trim()]);
  const u = r.rows[0];
  if (!u || !verifyPin(pin, u.pin_hash)) return res.status(401).json({ error: 'wrong name or PIN' });
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, u.id]);
  res.json({ token, name: u.name, role: u.role });
}));

router.post('/api/logout', awaitH(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ ok: true });
}));

module.exports = router;
