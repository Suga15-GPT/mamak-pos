const express = require('express');
const { pool } = require('../db');
const { publicH } = require('../lib/errors');
const { cents2rm } = require('../lib/money');
const { rateLimit } = require('../lib/auth');
const { buildOrderItems, insertOrder, ORDERABLE_SQL } = require('../services/orders');

const router = express.Router();

router.get('/api/menu', publicH(async (req, res) => {
  const cats = await pool.query('SELECT id, name FROM categories ORDER BY sort, id');
  const items = await pool.query(
    `SELECT id, category_id, name, price_cents, kandar FROM items WHERE ${ORDERABLE_SQL} ORDER BY sort, id`);
  const groups = await pool.query('SELECT id, name, mode, min_select, max_select FROM modifier_groups ORDER BY id');
  const opts = await pool.query('SELECT id, group_id, name, price_cents FROM modifier_options WHERE available = true ORDER BY sort, id');
  const itemIds = items.rows.map(i => i.id);
  const attach = itemIds.length
    ? await pool.query('SELECT item_id, group_id FROM item_modifier_groups WHERE item_id = ANY($1::int[]) ORDER BY sort, group_id', [itemIds])
    : { rows: [] };
  const groupIdsByItem = {};
  attach.rows.forEach(a => { (groupIdsByItem[a.item_id] ||= []).push(a.group_id); });

  res.json({
    categories: cats.rows,
    items: items.rows.map(i => ({ ...i, price: cents2rm(i.price_cents), modifier_group_ids: groupIdsByItem[i.id] || [] })),
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
  // Per-IP alone under-protects a busy table: one phone hotspot is one IP for
  // a whole group of diners, so also cap by the table itself.
  if (!rateLimit('table:' + table_token, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many orders, please ask staff' });
  const t = await pool.query('SELECT id FROM tables WHERE qr_token = $1', [table_token]);
  if (!t.rows[0]) return res.status(400).json({ error: 'invalid table' });
  const parsed = await buildOrderItems(pool, items);
  try {
    const id = await insertOrder(t.rows[0].id, parsed, String(note || '').slice(0, 300), 'qr');
    res.status(201).json({ id });
  } catch (e) {
    // Same one_open_order_per_table race as staff orders (phase 03): a customer
    // double-tapping submit, or two phones at one table, must not 500.
    if (e.code === '23505' && e.constraint === 'one_open_order_per_table') {
      const existing = await pool.query(
        "SELECT id FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled') ORDER BY id DESC LIMIT 1",
        [t.rows[0].id]);
      return res.status(409).json({ error: 'table already has an open order', order_id: existing.rows[0]?.id });
    }
    throw e;
  }
}));

module.exports = router;
