const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { pool } = require('../db');
const { requireRole, hashPin } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { rm2cents } = require('../lib/money');

const router = express.Router();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const adminOnly = requireRole('admin');

router.get('/api/admin/menu', adminOnly, awaitH(async (req, res) => {
  const cats = await pool.query('SELECT * FROM categories ORDER BY sort, id');
  const items = await pool.query('SELECT * FROM items ORDER BY sort, id');
  const groups = await pool.query('SELECT * FROM modifier_groups ORDER BY id');
  const opts = await pool.query('SELECT * FROM modifier_options ORDER BY sort, id');
  const itemGroups = await pool.query('SELECT item_id, group_id, sort FROM item_modifier_groups ORDER BY item_id, sort, group_id');
  res.json({
    categories: cats.rows, items: items.rows, modifier_groups: groups.rows, modifier_options: opts.rows,
    item_modifier_groups: itemGroups.rows,
  });
}));

router.post('/api/admin/items', adminOnly, awaitH(async (req, res) => {
  const { category_id, name, price, kandar } = req.body || {};
  if (!name || !(price >= 0)) return res.status(400).json({ error: 'name and price required' });
  const r = await pool.query(
    'INSERT INTO items (category_id, name, price_cents, kandar) VALUES ($1,$2,$3,$4) RETURNING id',
    [category_id || null, String(name).slice(0, 80), rm2cents(price), !!kandar]);
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/items/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).slice(0, 80)))); }
  if (b.price !== undefined) { sets.push('price_cents = $' + (vals.push(rm2cents(b.price)))); }
  if (b.category_id !== undefined) { sets.push('category_id = $' + (vals.push(b.category_id))); }
  if (b.available !== undefined) { sets.push('available = $' + (vals.push(!!b.available))); }
  if (b.kandar !== undefined) { sets.push('kandar = $' + (vals.push(!!b.kandar))); }
  if (b.sort !== undefined) { sets.push('sort = $' + (vals.push(Number(b.sort) || 0))); }
  // "Sold out today" self-clears at KL midnight; "Sold out indefinitely" is the
  // existing `available` flag, which stays off until an admin turns it back on.
  if (b.sold_out_today !== undefined) {
    sets.push(b.sold_out_today ? "sold_out_until = (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date" : 'sold_out_until = NULL');
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
}));

router.delete('/api/admin/items/:id', adminOnly, awaitH(async (req, res) => {
  await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

router.post('/api/admin/categories', adminOnly, awaitH(async (req, res) => {
  const r = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [String(req.body?.name || '').slice(0, 60)]);
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/categories/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).slice(0, 60)))); }
  if (b.sort !== undefined) { sets.push('sort = $' + (vals.push(Number(b.sort) || 0))); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
}));

router.post('/api/admin/modifier_options', adminOnly, awaitH(async (req, res) => {
  const { group_id, name, price } = req.body || {};
  const r = await pool.query(
    'INSERT INTO modifier_options (group_id, name, price_cents) VALUES ($1,$2,$3) RETURNING id',
    [group_id, String(name || '').slice(0, 60), rm2cents(price || 0)]);
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/modifier_options/:id', adminOnly, awaitH(async (req, res) => {
  const { available } = req.body || {};
  if (available === undefined) return res.status(400).json({ error: 'available required' });
  await pool.query('UPDATE modifier_options SET available = $1 WHERE id = $2', [!!available, req.params.id]);
  res.json({ ok: true });
}));

router.delete('/api/admin/modifier_options/:id', adminOnly, awaitH(async (req, res) => {
  await pool.query('DELETE FROM modifier_options WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

router.post('/api/admin/modifier_groups', adminOnly, awaitH(async (req, res) => {
  const { name, mode } = req.body || {};
  if (!name || !['radio', 'checkbox'].includes(mode)) return res.status(400).json({ error: 'name and mode (radio|checkbox) required' });
  // Match the same defaults the phase-04 migration backfilled onto existing groups.
  const [minSelect, maxSelect] = mode === 'radio' ? [1, 1] : [0, 99];
  const r = await pool.query(
    'INSERT INTO modifier_groups (name, mode, min_select, max_select) VALUES ($1,$2,$3,$4) RETURNING id',
    [String(name).slice(0, 60), mode, minSelect, maxSelect]);
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/modifier_groups/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).slice(0, 60)))); }
  if (b.min_select !== undefined) { sets.push('min_select = $' + (vals.push(Math.max(0, parseInt(b.min_select) || 0)))); }
  if (b.max_select !== undefined) { sets.push('max_select = $' + (vals.push(Math.max(0, parseInt(b.max_select) || 0)))); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE modifier_groups SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
}));

/* attach/detach a modifier group to/from an item */
router.post('/api/admin/item_modifier_groups', adminOnly, awaitH(async (req, res) => {
  const { item_id, group_id, sort } = req.body || {};
  if (!item_id || !group_id) return res.status(400).json({ error: 'item_id and group_id required' });
  await pool.query(
    'INSERT INTO item_modifier_groups (item_id, group_id, sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [Number(item_id), Number(group_id), Number(sort) || 0]);
  res.json({ ok: true });
}));

router.delete('/api/admin/item_modifier_groups/:itemId/:groupId', adminOnly, awaitH(async (req, res) => {
  await pool.query('DELETE FROM item_modifier_groups WHERE item_id = $1 AND group_id = $2', [req.params.itemId, req.params.groupId]);
  res.json({ ok: true });
}));

router.get('/api/admin/tables', adminOnly, awaitH(async (req, res) => {
  const r = await pool.query('SELECT id, name, qr_token FROM tables ORDER BY id');
  res.json(r.rows.map(t => ({ ...t, url: `${BASE_URL}/t/${t.qr_token}` })));
}));

router.post('/api/admin/tables', adminOnly, awaitH(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name required' });
  const token = crypto.randomBytes(5).toString('hex');
  const r = await pool.query('INSERT INTO tables (name, qr_token) VALUES ($1,$2) RETURNING id', [name, token]);
  res.json({ id: r.rows[0].id, url: `${BASE_URL}/t/${token}` });
}));

router.get('/api/admin/tables/:id/qr.png', adminOnly, awaitH(async (req, res) => {
  const r = await pool.query('SELECT qr_token FROM tables WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  const buf = await QRCode.toBuffer(`${BASE_URL}/t/${r.rows[0].qr_token}`, { width: 512, margin: 1 });
  res.type('image/png').send(buf);
}));

router.get('/api/admin/users', adminOnly, awaitH(async (req, res) => {
  const r = await pool.query('SELECT id, name, role FROM users ORDER BY id');
  res.json(r.rows);
}));
router.post('/api/admin/users', adminOnly, awaitH(async (req, res) => {
  const { name, role, pin } = req.body || {};
  if (!['admin', 'staff', 'kitchen'].includes(role) || !name || !pin)
    return res.status(400).json({ error: 'name, role, pin required' });
  const r = await pool.query('INSERT INTO users (name, role, pin_hash) VALUES ($1,$2,$3) RETURNING id',
    [String(name).slice(0, 40), role, hashPin(pin)]);
  res.json({ id: r.rows[0].id });
}));
router.delete('/api/admin/users/:id', adminOnly, awaitH(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

router.get('/api/admin/audit', adminOnly, awaitH(async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const params = [];
  let where = '';
  if (req.query.entity_id) { params.push(Number(req.query.entity_id)); where = `WHERE a.entity_id = $${params.length}`; }
  params.push(limit);
  const r = await pool.query(
    `SELECT a.id, a.at, a.user_id, u.name AS user_name, a.action, a.entity_type, a.entity_id, a.detail
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     ${where} ORDER BY a.at DESC LIMIT $${params.length}`, params);
  res.json(r.rows);
}));

module.exports = router;
