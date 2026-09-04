const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { pool } = require('../db');
const { requireRole, hashPin, pinPolicyError } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { rm2cents } = require('../lib/money');
const { writeAudit } = require('../services/orders');
const printing = require('../services/printing');
const rounds = require('../services/rounds');
const { publicBaseUrl, qrHealth } = require('../lib/baseurl');
const { systemHealth } = require('../services/health');
const { publish } = require('../lib/events');

const router = express.Router();

const adminOnly = requireRole('admin');

// Menu edits change what every till and every customer phone is offered, so
// they push the same realtime event an order does — a sold-out item disappears
// from the floor within a second instead of at the next reload.
function menuChanged() { publish('menu.updated', {}); }

/* ===== menu ===== */

router.get('/api/admin/menu', adminOnly, awaitH(async (req, res) => {
  const cats = await pool.query('SELECT * FROM categories ORDER BY sort, id');
  // `in_use` is what makes "safe delete" answerable without a second round
  // trip: how many *live* orders would be surprised by this going away.
  const items = await pool.query(`
    SELECT i.*, ps.name AS station_name,
           (SELECT count(*)::int FROM order_items oi
              JOIN orders o ON o.id = oi.order_id
             WHERE oi.item_id = i.id AND o.status NOT IN ('paid','cancelled','refunded')) AS open_order_lines,
           (SELECT count(*)::int FROM order_items oi WHERE oi.item_id = i.id) AS historical_lines
      FROM items i LEFT JOIN prep_stations ps ON ps.code = i.station_code
     ORDER BY i.sort, i.id`);
  const groups = await pool.query(`
    SELECT g.*,
           (SELECT count(*)::int FROM item_modifier_groups img WHERE img.group_id = g.id) AS attached_count
      FROM modifier_groups g ORDER BY g.sort, g.id`);
  const opts = await pool.query('SELECT * FROM modifier_options ORDER BY sort, id');
  const itemGroups = await pool.query('SELECT item_id, group_id, sort FROM item_modifier_groups ORDER BY item_id, sort, group_id');
  const stations = await rounds.listStations();
  res.json({
    categories: cats.rows, items: items.rows, modifier_groups: groups.rows, modifier_options: opts.rows,
    item_modifier_groups: itemGroups.rows, stations,
  });
}));

router.post('/api/admin/items', adminOnly, awaitH(async (req, res) => {
  const { category_id, name, price, kandar, station_code } = req.body || {};
  if (!String(name || '').trim() || !(price >= 0)) return res.status(400).json({ error: 'name and price required' });
  const station = await resolveStation(station_code);
  if (!station) return res.status(400).json({ error: 'unknown preparation station' });
  const r = await pool.query(
    'INSERT INTO items (category_id, name, price_cents, kandar, station_code, sort) VALUES ($1,$2,$3,$4,$5,COALESCE((SELECT max(sort)+1 FROM items),0)) RETURNING id',
    [category_id || null, String(name).trim().slice(0, 80), rm2cents(price), !!kandar, station]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'menu.item_create', entityType: 'item', entityId: r.rows[0].id,
    detail: { name: String(name).trim().slice(0, 80), price_cents: rm2cents(price), station_code: station },
  });
  menuChanged();
  res.json({ id: r.rows[0].id });
}));

async function resolveStation(code) {
  if (code == null || code === '') return 'kitchen';
  const r = await pool.query('SELECT code FROM prep_stations WHERE code = $1 AND active', [String(code)]);
  return r.rows[0]?.code || null;
}

router.patch('/api/admin/items/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).trim().slice(0, 80)))); }
  if (b.price !== undefined) { sets.push('price_cents = $' + (vals.push(rm2cents(b.price)))); }
  if (b.category_id !== undefined) { sets.push('category_id = $' + (vals.push(b.category_id || null))); }
  if (b.available !== undefined) { sets.push('available = $' + (vals.push(!!b.available))); }
  if (b.kandar !== undefined) { sets.push('kandar = $' + (vals.push(!!b.kandar))); }
  if (b.sort !== undefined) { sets.push('sort = $' + (vals.push(Number(b.sort) || 0))); }
  if (b.station_code !== undefined) {
    const station = await resolveStation(b.station_code);
    if (!station) return res.status(400).json({ error: 'unknown preparation station' });
    sets.push('station_code = $' + (vals.push(station)));
  }
  // "Sold out today" self-clears at KL midnight; "Sold out indefinitely" is the
  // existing `available` flag, which stays off until an admin turns it back on.
  if (b.sold_out_today !== undefined) {
    sets.push(b.sold_out_today ? "sold_out_until = (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date" : 'sold_out_until = NULL');
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  // Reordering fires on every drag; it isn't worth an audit row each time.
  if (Object.keys(b).some(k => k !== 'sort')) {
    await writeAudit(pool, {
      userId: req.user.id, action: 'menu.item_update', entityType: 'item', entityId: Number(req.params.id), detail: b,
    });
  }
  menuChanged();
  res.json({ ok: true });
}));

/* Safe delete. Historical bills keep their own snapshot of the name and price
   (order_items.item_id is ON DELETE SET NULL), so deleting a retired item never
   damages the record — but an item sitting on a bill the restaurant is still
   serving is refused, because that is a mistake, not an intention. */
router.delete('/api/admin/items/:id', adminOnly, awaitH(async (req, res) => {
  const it = (await pool.query('SELECT * FROM items WHERE id = $1', [req.params.id])).rows[0];
  if (!it) return res.status(404).json({ error: 'not found' });
  const open = await pool.query(
    `SELECT count(*)::int n FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.item_id = $1 AND o.status NOT IN ('paid','cancelled','refunded')`, [req.params.id]);
  if (open.rows[0].n > 0) {
    return res.status(409).json({
      error: `${it.name} is on ${open.rows[0].n} order that is still open. Finish or void those first, or switch the item off instead of deleting it.`,
    });
  }
  await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'menu.item_delete', entityType: 'item', entityId: Number(req.params.id),
    detail: { name: it.name, price_cents: it.price_cents },
  });
  menuChanged();
  res.json({ ok: true });
}));

/* ===== categories ===== */

router.post('/api/admin/categories', adminOnly, awaitH(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  const r = await pool.query(
    'INSERT INTO categories (name, sort) VALUES ($1, COALESCE((SELECT max(sort)+1 FROM categories),0)) RETURNING id', [name]);
  menuChanged();
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/categories/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).trim().slice(0, 60)))); }
  if (b.sort !== undefined) { sets.push('sort = $' + (vals.push(Number(b.sort) || 0))); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  menuChanged();
  res.json({ ok: true });
}));

/* A category with items in it is refused rather than silently orphaning them
   into an unreachable "no category" bucket the POS can't display. */
router.delete('/api/admin/categories/:id', adminOnly, awaitH(async (req, res) => {
  const cat = (await pool.query('SELECT * FROM categories WHERE id = $1', [req.params.id])).rows[0];
  if (!cat) return res.status(404).json({ error: 'not found' });
  const used = await pool.query('SELECT count(*)::int n FROM items WHERE category_id = $1', [req.params.id]);
  if (used.rows[0].n > 0) {
    return res.status(409).json({ error: `${cat.name} still has ${used.rows[0].n} item(s). Move them to another category first.` });
  }
  await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'menu.category_delete', entityType: 'category', entityId: Number(req.params.id),
    detail: { name: cat.name },
  });
  menuChanged();
  res.json({ ok: true });
}));

/* ===== food options (modifier groups + options) ===== */

router.post('/api/admin/modifier_groups', adminOnly, awaitH(async (req, res) => {
  const { name, mode } = req.body || {};
  if (!String(name || '').trim() || !['radio', 'checkbox'].includes(mode))
    return res.status(400).json({ error: 'name and mode (radio|checkbox) required' });
  // Match the same defaults the phase-04 migration backfilled onto existing groups.
  const [minSelect, maxSelect] = mode === 'radio' ? [1, 1] : [0, 99];
  const r = await pool.query(
    `INSERT INTO modifier_groups (name, mode, min_select, max_select, sort)
     VALUES ($1,$2,$3,$4, COALESCE((SELECT max(sort)+1 FROM modifier_groups),0)) RETURNING id`,
    [String(name).trim().slice(0, 60), mode, minSelect, maxSelect]);
  menuChanged();
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/modifier_groups/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).trim().slice(0, 60)))); }
  if (b.mode !== undefined) {
    if (!['radio', 'checkbox'].includes(b.mode)) return res.status(400).json({ error: 'bad mode' });
    sets.push('mode = $' + (vals.push(b.mode)));
  }
  if (b.min_select !== undefined) { sets.push('min_select = $' + (vals.push(Math.max(0, parseInt(b.min_select) || 0)))); }
  if (b.max_select !== undefined) { sets.push('max_select = $' + (vals.push(Math.max(0, parseInt(b.max_select) || 0)))); }
  if (b.sort !== undefined) { sets.push('sort = $' + (vals.push(Number(b.sort) || 0))); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE modifier_groups SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);

  // A group whose minimum exceeds its maximum can never be satisfied, and the
  // failure only shows up as an un-orderable item at the till.
  const g = (await pool.query('SELECT min_select, max_select FROM modifier_groups WHERE id = $1', [req.params.id])).rows[0];
  if (g && g.min_select > g.max_select) {
    await pool.query('UPDATE modifier_groups SET max_select = min_select WHERE id = $1', [req.params.id]);
  }
  menuChanged();
  res.json({ ok: true });
}));

/* Copies a group and its options — the fastest way to build "Extra Lauk
   (lunch)" from "Extra Lauk" without retyping eight rows. Attachments are not
   copied: the point of a duplicate is that it goes somewhere else. */
router.post('/api/admin/modifier_groups/:id/duplicate', adminOnly, awaitH(async (req, res) => {
  const g = (await pool.query('SELECT * FROM modifier_groups WHERE id = $1', [req.params.id])).rows[0];
  if (!g) return res.status(404).json({ error: 'not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const copy = await client.query(
      `INSERT INTO modifier_groups (name, mode, min_select, max_select, sort)
       VALUES ($1,$2,$3,$4, COALESCE((SELECT max(sort)+1 FROM modifier_groups),0)) RETURNING id`,
      [`${g.name} (copy)`.slice(0, 60), g.mode, g.min_select, g.max_select]);
    await client.query(
      `INSERT INTO modifier_options (group_id, name, price_cents, available, sort)
       SELECT $1, name, price_cents, available, sort FROM modifier_options WHERE group_id = $2`,
      [copy.rows[0].id, g.id]);
    await client.query('COMMIT');
    menuChanged();
    res.json({ id: copy.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

/* Deleting a group takes its options with it (ON DELETE CASCADE) and detaches
   it from every item. Historical bills are untouched: order_item_mods stores
   the option's name and price as its own snapshot and has no foreign key back
   here. Because detaching changes what staff are prompted for, a group that is
   still attached to items needs an explicit confirm. */
router.delete('/api/admin/modifier_groups/:id', adminOnly, awaitH(async (req, res) => {
  const g = (await pool.query('SELECT * FROM modifier_groups WHERE id = $1', [req.params.id])).rows[0];
  if (!g) return res.status(404).json({ error: 'not found' });
  const attached = await pool.query(
    `SELECT i.name FROM item_modifier_groups img JOIN items i ON i.id = img.item_id
      WHERE img.group_id = $1 ORDER BY i.name LIMIT 20`, [req.params.id]);
  const confirmed = req.body?.confirm === true || req.query.confirm === '1';
  if (attached.rows.length && !confirmed) {
    return res.status(409).json({
      error: `${g.name} is still used by ${attached.rows.length} menu item(s). Deleting it removes those food options from them.`,
      attached_items: attached.rows.map(r => r.name),
      needs_confirm: true,
    });
  }
  await pool.query('DELETE FROM modifier_groups WHERE id = $1', [req.params.id]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'menu.group_delete', entityType: 'modifier_group', entityId: Number(req.params.id),
    detail: { name: g.name, attached_items: attached.rows.map(r => r.name) },
  });
  menuChanged();
  res.json({ ok: true });
}));

router.post('/api/admin/modifier_options', adminOnly, awaitH(async (req, res) => {
  const { group_id, name, price } = req.body || {};
  if (!group_id || !String(name || '').trim()) return res.status(400).json({ error: 'group_id and name required' });
  const r = await pool.query(
    `INSERT INTO modifier_options (group_id, name, price_cents, sort)
     VALUES ($1,$2,$3, COALESCE((SELECT max(sort)+1 FROM modifier_options WHERE group_id = $1),0)) RETURNING id`,
    [group_id, String(name).trim().slice(0, 60), rm2cents(price || 0)]);
  menuChanged();
  res.json({ id: r.rows[0].id });
}));

router.patch('/api/admin/modifier_options/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).trim().slice(0, 60)))); }
  if (b.price !== undefined) { sets.push('price_cents = $' + (vals.push(rm2cents(b.price)))); }
  if (b.available !== undefined) { sets.push('available = $' + (vals.push(!!b.available))); }
  if (b.sort !== undefined) { sets.push('sort = $' + (vals.push(Number(b.sort) || 0))); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE modifier_options SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  menuChanged();
  res.json({ ok: true });
}));

// order_item_mods snapshots name and price and has no foreign key here, so
// removing an option never rewrites a historical bill.
router.delete('/api/admin/modifier_options/:id', adminOnly, awaitH(async (req, res) => {
  const o = (await pool.query('SELECT * FROM modifier_options WHERE id = $1', [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: 'not found' });
  await pool.query('DELETE FROM modifier_options WHERE id = $1', [req.params.id]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'menu.option_delete', entityType: 'modifier_option', entityId: Number(req.params.id),
    detail: { name: o.name, group_id: o.group_id },
  });
  menuChanged();
  res.json({ ok: true });
}));

/* attach/detach a modifier group to/from an item */
router.post('/api/admin/item_modifier_groups', adminOnly, awaitH(async (req, res) => {
  const { item_id, group_id, sort } = req.body || {};
  if (!item_id || !group_id) return res.status(400).json({ error: 'item_id and group_id required' });
  await pool.query(
    'INSERT INTO item_modifier_groups (item_id, group_id, sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [Number(item_id), Number(group_id), Number(sort) || 0]);
  menuChanged();
  res.json({ ok: true });
}));

router.delete('/api/admin/item_modifier_groups/:itemId/:groupId', adminOnly, awaitH(async (req, res) => {
  await pool.query('DELETE FROM item_modifier_groups WHERE item_id = $1 AND group_id = $2', [req.params.itemId, req.params.groupId]);
  menuChanged();
  res.json({ ok: true });
}));

/* ===== preparation stations ===== */

router.get('/api/admin/stations', adminOnly, awaitH(async (req, res) => {
  const stations = await rounds.listStations();
  const counts = await pool.query('SELECT station_code, count(*)::int n FROM items GROUP BY station_code');
  const byCode = Object.fromEntries(counts.rows.map(r => [r.station_code, r.n]));
  res.json(stations.map(s => ({ ...s, item_count: byCode[s.code] || 0 })));
}));

/* ===== tables & QR ===== */

router.get('/api/admin/qr-health', adminOnly, awaitH(async (req, res) => {
  res.json(qrHealth(req));
}));

router.get('/api/admin/tables', adminOnly, awaitH(async (req, res) => {
  const base = publicBaseUrl(req);
  const r = await pool.query(`
    SELECT t.id, t.name, t.qr_token, t.active, t.sort,
           (SELECT count(*)::int FROM orders o
             WHERE o.table_id = t.id AND o.status NOT IN ('paid','cancelled','refunded')) AS open_orders
      FROM tables t ORDER BY t.active DESC, t.sort, t.id`);
  res.json(r.rows.map(t => ({ ...t, url: `${base}/t/${t.qr_token}` })));
}));

router.post('/api/admin/tables', adminOnly, awaitH(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name required' });
  const token = crypto.randomBytes(5).toString('hex');
  try {
    const r = await pool.query(
      'INSERT INTO tables (name, qr_token, sort) VALUES ($1,$2, COALESCE((SELECT max(sort)+1 FROM tables),0)) RETURNING id', [name, token]);
    await writeAudit(pool, {
      userId: req.user.id, action: 'table.create', entityType: 'table', entityId: r.rows[0].id, detail: { name },
    });
    res.json({ id: r.rows[0].id, url: `${publicBaseUrl(req)}/t/${token}` });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: `A table called ${name} already exists` });
    throw e;
  }
}));

/* Rename, reorder, retire or bring back a table. Retiring is refused while the
   table still has a bill open on it — that bill has to be settled or moved
   first (POST /api/orders/:id/move). */
router.patch('/api/admin/tables/:id', adminOnly, awaitH(async (req, res) => {
  const b = req.body || {};
  const t = (await pool.query('SELECT * FROM tables WHERE id = $1', [req.params.id])).rows[0];
  if (!t) return res.status(404).json({ error: 'not found' });

  if (b.active === false && t.active) {
    const open = await pool.query(
      "SELECT count(*)::int n FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled','refunded')", [t.id]);
    if (open.rows[0].n > 0) return res.status(409).json({ error: `${t.name} still has an open order. Settle or move it first.` });
  }

  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).trim().slice(0, 40)))); }
  if (b.sort !== undefined) { sets.push('sort = $' + (vals.push(Number(b.sort) || 0))); }
  if (b.active !== undefined) { sets.push('active = $' + (vals.push(!!b.active))); }
  // Reissuing the token invalidates every printed sticker for this table —
  // exactly what you want after a QR is photographed and abused.
  if (b.regenerate_qr) { sets.push('qr_token = $' + (vals.push(crypto.randomBytes(5).toString('hex')))); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(t.id);
  try {
    await pool.query(`UPDATE tables SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Another active table already has that name' });
    throw e;
  }
  if (Object.keys(b).some(k => k !== 'sort')) {
    await writeAudit(pool, {
      userId: req.user.id, action: 'table.update', entityType: 'table', entityId: t.id, detail: b,
    });
  }
  const after = (await pool.query('SELECT qr_token FROM tables WHERE id = $1', [t.id])).rows[0];
  res.json({ ok: true, url: `${publicBaseUrl(req)}/t/${after.qr_token}` });
}));

// Deletion is deliberately retired: old bills name the table, and a hard delete
// would break `orders.table_id`. Deactivate instead.
router.delete('/api/admin/tables/:id', adminOnly, awaitH(async (req, res) => {
  res.status(410).json({ error: 'deleting a table is retired — PATCH /api/admin/tables/:id with {active:false} instead' });
}));

router.get('/api/admin/tables/:id/qr.png', adminOnly, awaitH(async (req, res) => {
  const r = await pool.query('SELECT qr_token FROM tables WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  const buf = await QRCode.toBuffer(`${publicBaseUrl(req)}/t/${r.rows[0].qr_token}`, { width: 512, margin: 1 });
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

/* ===== activity ===== */

router.get('/api/admin/audit', adminOnly, awaitH(async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const params = [];
  const where = [];
  if (req.query.entity_id) { params.push(Number(req.query.entity_id)); where.push(`a.entity_id = $${params.length}`); }
  if (req.query.action) { params.push(String(req.query.action)); where.push(`a.action = $${params.length}`); }
  params.push(limit);
  const r = await pool.query(
    `SELECT a.id, a.at, a.user_id, u.name AS user_name, a.action, a.entity_type, a.entity_id, a.detail
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.at DESC LIMIT $${params.length}`, params);
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
    `SELECT j.id, j.kind, j.order_id, j.status, j.attempts, j.last_error, j.created_at, j.send_id, j.station_code, j.retry_of,
            p.name AS printer_name, s.seq_no AS round, ps.name AS station_name,
            COALESCE(tb.name, 'Takeaway #' || o.id) AS order_label
     FROM print_jobs j
     LEFT JOIN printers p ON p.id = j.printer_id
     LEFT JOIN order_sends s ON s.id = j.send_id
     LEFT JOIN prep_stations ps ON ps.code = j.station_code
     LEFT JOIN orders o ON o.id = j.order_id
     LEFT JOIN tables tb ON tb.id = o.table_id
     ${where} ORDER BY j.id DESC LIMIT $${params.length}`, params);
  res.json(r.rows);
}));

/* Retry a failed print job — reprints the exact stored ticket on the same
   printer. Creates no order, no round and no charge; the bill is untouched. */
router.post('/api/admin/print-jobs/:id/retry', adminOnly, awaitH(async (req, res) => {
  const jobId = await printing.retryJob(Number(req.params.id), req.user.id);
  res.json({ ok: true, job_id: jobId });
}));

/* ===== system health =====
   Every row is measured, not assumed — printers are probed over TCP right now,
   the backup time is whatever a backup last recorded, and a check that cannot
   be made honestly is omitted rather than shown green. */
router.get('/api/admin/system', adminOnly, awaitH(async (req, res) => {
  res.json(await systemHealth(req));
}));

module.exports = router;
