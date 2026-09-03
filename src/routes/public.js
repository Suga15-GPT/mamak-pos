const express = require('express');
const { pool } = require('../db');
const { publicH } = require('../lib/errors');
const { cents2rm } = require('../lib/money');
const { rateLimit } = require('../lib/auth');
const { buildOrderItems, insertOrder } = require('../services/orders');

const router = express.Router();

router.get('/api/menu', publicH(async (req, res) => {
  const cats = await pool.query('SELECT id, name FROM categories ORDER BY sort, id');
  const items = await pool.query(
    'SELECT id, category_id, name, price_cents, kandar FROM items WHERE available ORDER BY sort, id');
  const groups = await pool.query('SELECT id, name, mode FROM modifier_groups ORDER BY id');
  const opts = await pool.query('SELECT id, group_id, name, price_cents FROM modifier_options WHERE available = true ORDER BY sort, id');
  res.json({
    categories: cats.rows,
    items: items.rows.map(i => ({ ...i, price: cents2rm(i.price_cents) })),
    modifier_groups: groups.rows,
    modifier_options: opts.rows.map(o => ({ ...o, price: cents2rm(o.price_cents) })),
  });
}));

router.get('/api/t/:token', publicH(async (req, res) => {
  const r = await pool.query('SELECT id, name FROM tables WHERE qr_token = $1', [req.params.token]);
  if (!r.rows[0]) return res.status(404).json({ error: 'unknown table QR' });
  res.json({ table: r.rows[0] });
}));

/* customer QR order (public, rate-limited) */
router.post('/api/public/orders', publicH(async (req, res) => {
  if (!rateLimit(req.ip, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many orders, please ask staff' });
  const { table_token, items, note } = req.body || {};
  const t = await pool.query('SELECT id FROM tables WHERE qr_token = $1', [table_token]);
  if (!t.rows[0]) return res.status(400).json({ error: 'invalid table' });
  const parsed = await buildOrderItems(pool, items);
  const id = await insertOrder(t.rows[0].id, parsed, String(note || '').slice(0, 300), 'qr');
  res.json({ id });
}));

module.exports = router;
