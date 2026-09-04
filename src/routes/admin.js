const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { pool } = require('../db');
const { requireRole, hashPin, pinPolicyError } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { rm2cents } = require('../lib/money');
const { writeAudit } = require('../services/orders');
const printing = require('../services/printing');

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

/* ===== staff & PINs (phase 11) =====
   Deletion is retired — after phase 03, orders reference the staff who took
   them, so a user with history can't be deleted at all and their name must
   stay readable on old bills. Deactivate instead. */
router.get('/api/admin/users', adminOnly, awaitH(async (req, res) => {
  // Never pin_hash. last_seen_at is the max across that user's sessions
  // (null if they've never had one, or all have expired/been cleared).
  const r = await pool.query(
    `SELECT u.id, u.name, u.role, u.active, u.must_change_pin, u.created_at,
            (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
     FROM users u ORDER BY u.active DESC, u.name`);
  res.json(r.rows);
}));

router.post('/api/admin/users', adminOnly, awaitH(async (req, res) => {
  const { name, role, pin } = req.body || {};
  if (!['admin', 'staff', 'kitchen'].includes(role) || !String(name || '').trim())
    return res.status(400).json({ error: 'name and role required' });
  const policyError = pinPolicyError(pin, null);
  if (policyError) return res.status(400).json({ error: policyError });
  // A newly-created account is always asked to choose its own PIN at first
  // login — the PIN given here is a temporary one, not the real credential.
  const r = await pool.query(
    'INSERT INTO users (name, role, pin_hash, must_change_pin) VALUES ($1,$2,$3,true) RETURNING id',
    [String(name).trim().slice(0, 40), role, hashPin(pin)]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'user.create', entityType: 'user', entityId: r.rows[0].id,
    detail: { name: String(name).trim().slice(0, 40), role },
  });
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/users/:id', adminOnly, awaitH(async (req, res) => {
  const targetId = Number(req.params.id);
  const b = req.body || {};
  const target = (await pool.query('SELECT * FROM users WHERE id = $1', [targetId])).rows[0];
  if (!target) return res.status(404).json({ error: 'not found' });

  const deactivating = b.active === false && target.active;
  if (deactivating && targetId === req.user.id) return res.status(400).json({ error: 'cannot deactivate yourself' });

  const demoting = b.role !== undefined && b.role !== 'admin' && target.role === 'admin';
  if ((deactivating || demoting) && target.role === 'admin') {
    const activeAdmins = await pool.query("SELECT count(*)::int n FROM users WHERE role = 'admin' AND active");
    if (activeAdmins.rows[0].n <= 1) return res.status(400).json({ error: 'cannot deactivate or demote the last active admin' });
  }

  const sets = [], vals = [];
  if (b.name !== undefined) sets.push('name = $' + vals.push(String(b.name).trim().slice(0, 40)));
  if (b.role !== undefined) {
    if (!['admin', 'staff', 'kitchen'].includes(b.role)) return res.status(400).json({ error: 'bad role' });
    sets.push('role = $' + vals.push(b.role));
  }
  if (b.active !== undefined) sets.push('active = $' + vals.push(!!b.active));
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(targetId);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);

  // Deactivating someone ejects them mid-shift rather than waiting for their
  // session to expire.
  if (b.active === false) await pool.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);

  await writeAudit(pool, {
    userId: req.user.id, action: deactivating ? 'user.deactivate' : 'user.update', entityType: 'user', entityId: targetId,
    detail: { name: b.name, role: b.role, active: b.active },
  });
  res.json({ ok: true });
}));

router.post('/api/admin/users/:id/reset-pin', adminOnly, awaitH(async (req, res) => {
  const targetId = Number(req.params.id);
  const target = (await pool.query('SELECT pin_hash FROM users WHERE id = $1', [targetId])).rows[0];
  if (!target) return res.status(404).json({ error: 'not found' });
  const policyError = pinPolicyError(req.body?.new_pin, target.pin_hash);
  if (policyError) return res.status(400).json({ error: policyError });

  await pool.query(
    'UPDATE users SET pin_hash = $1, must_change_pin = true, pin_changed_at = now() WHERE id = $2',
    [hashPin(req.body.new_pin), targetId]);
  // A stolen session must not survive its owner's PIN being reset out from under them.
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);
  await writeAudit(pool, { userId: req.user.id, action: 'user.pin_reset', entityType: 'user', entityId: targetId, detail: {} });
  res.json({ ok: true });
}));

router.delete('/api/admin/users/:id', adminOnly, awaitH(async (req, res) => {
  res.status(410).json({ error: "deleting a user is retired — PATCH /api/admin/users/:id with {active:false} instead" });
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

/* ===== printers (phase 08) — CRUD, a test print, and the jobs list so a
   jammed printer is visible instead of silently eating chits/receipts ===== */
router.get('/api/admin/printers', adminOnly, awaitH(async (req, res) => {
  const r = await pool.query('SELECT * FROM printers ORDER BY id');
  res.json(r.rows);
}));

router.post('/api/admin/printers', adminOnly, awaitH(async (req, res) => {
  const { name, host, port, role, width, enabled } = req.body || {};
  if (!name || !host || !['kitchen', 'receipt', 'bar'].includes(role))
    return res.status(400).json({ error: "name, host, role ('kitchen'|'receipt'|'bar') required" });
  const r = await pool.query(
    'INSERT INTO printers (name, host, port, role, width, enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [String(name).slice(0, 60), String(host).slice(0, 120), Number(port) || 9100, role, Number(width) || 42, enabled !== false]);
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/printers/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) sets.push('name = $' + vals.push(String(b.name).slice(0, 60)));
  if (b.host !== undefined) sets.push('host = $' + vals.push(String(b.host).slice(0, 120)));
  if (b.port !== undefined) sets.push('port = $' + vals.push(Number(b.port) || 9100));
  if (b.role !== undefined) {
    if (!['kitchen', 'receipt', 'bar'].includes(b.role)) return res.status(400).json({ error: 'bad role' });
    sets.push('role = $' + vals.push(b.role));
  }
  if (b.width !== undefined) sets.push('width = $' + vals.push(Number(b.width) || 42));
  if (b.enabled !== undefined) sets.push('enabled = $' + vals.push(!!b.enabled));
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE printers SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
}));

router.delete('/api/admin/printers/:id', adminOnly, awaitH(async (req, res) => {
  await pool.query('DELETE FROM printers WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

router.post('/api/admin/printers/:id/test-print', adminOnly, awaitH(async (req, res) => {
  const jobId = await printing.testPrint(Number(req.params.id));
  res.json({ ok: true, job_id: jobId });
}));

router.get('/api/admin/print-jobs', adminOnly, awaitH(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const params = [];
  let where = '';
  if (req.query.status) { params.push(req.query.status); where = `WHERE j.status = $${params.length}`; }
  params.push(limit);
  const r = await pool.query(
    `SELECT j.id, j.kind, j.order_id, j.status, j.attempts, j.last_error, j.created_at, p.name AS printer_name
     FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id
     ${where} ORDER BY j.id DESC LIMIT $${params.length}`, params);
  res.json(r.rows);
}));

module.exports = router;
