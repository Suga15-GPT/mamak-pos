const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const KL = 'Asia/Kuala_Lumpur';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/* ---------- helpers ---------- */
const cents2rm = c => Math.round(c) / 100;
const rm2cents = r => Math.round(Number(r) * 100);
const roundCashCents = c => Math.round(c / 5) * 5;

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
const awaitH = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message || 'server error' }); });

async function requireAuth(...roles) {
  return async (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return res.status(401).json({ error: 'login required' });
    const r = await pool.query(
      'SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1', [token]);
    if (!r.rows[0]) return res.status(401).json({ error: 'invalid session' });
    req.user = r.rows[0];
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

/* ---------- auth ---------- */
app.post('/api/login', awaitH(async (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name and pin required' });
  const r = await pool.query('SELECT * FROM users WHERE lower(name) = lower($1)', [name.trim()]);
  const u = r.rows[0];
  if (!u || !verifyPin(pin, u.pin_hash)) return res.status(401).json({ error: 'wrong name or PIN' });
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, u.id]);
  res.json({ token, name: u.name, role: u.role });
}));

/* ---------- public: menu + customer table + QR ordering ---------- */
app.get('/api/menu', awaitH(async (req, res) => {
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

app.get('/api/t/:token', awaitH(async (req, res) => {
  const r = await pool.query('SELECT id, name FROM tables WHERE qr_token = $1', [req.params.token]);
  if (!r.rows[0]) return res.status(404).json({ error: 'unknown table QR' });
  res.json({ table: r.rows[0] });
}));

async function buildOrderItems(client, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 60)
    throw Object.assign(new Error('invalid items'), { status: 400 });
  
  const itemIds = [...new Set(rawItems.map(i => Number(i.item_id)))].filter(id => id > 0);
  const optIds = [...new Set(rawItems.flatMap(i => (i.modifier_option_ids || []).map(Number)))].filter(id => id > 0);
  
  const im = new Map(itemIds.length
    ? (await client.query('SELECT * FROM items WHERE id = ANY($1::int[])', [itemIds])).rows.map(x => [x.id, x])
    : []);
  
  const om = new Map(optIds.length
    ? (await client.query('SELECT * FROM modifier_options WHERE id = ANY($1::int[])', [optIds])).rows.map(x => [x.id, x])
    : []);
  
  return rawItems.map(li => {
    const it = im.get(Number(li.item_id));
    if (!it || !it.available) throw Object.assign(new Error('item unavailable'), { status: 400 });
    const qty = Math.min(20, Math.max(1, parseInt(li.qty) || 1));
    const mods = (li.modifier_option_ids || []).slice(0, 12).map(id => {
      const o = om.get(Number(id));
      if (!o || !o.available) throw Object.assign(new Error('modifier unavailable'), { status: 400 });
      return o;
    });
    return { item: it, qty, mods, note: String(li.note || '').slice(0, 200) };
  });
}

async function insertOrder(tableId, parsed, note, source) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      'INSERT INTO orders (table_id, status, source, note) VALUES ($1, $2, $3, $4) RETURNING id',
      [tableId, 'sent', source, note || null]);
    const orderId = o.rows[0].id;
    for (const l of parsed) {
      const oi = await client.query(
        'INSERT INTO order_items (order_id, item_id, name, price_cents, qty, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [orderId, l.item.id, l.item.name, l.item.price_cents, l.qty, l.note || null]);
      for (const m of l.mods) {
        await client.query(
          'INSERT INTO order_item_mods (order_item_id, name, price_cents) VALUES ($1,$2,$3)',
          [oi.rows[0].id, m.name, m.price_cents]);
      }
    }
    await client.query('COMMIT');
    return orderId;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* customer QR order (public, rate-limited) */
app.post('/api/public/orders', awaitH(async (req, res) => {
  if (!rateLimit(req.ip, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many orders, please ask staff' });
  const { table_token, items, note } = req.body || {};
  const t = await pool.query('SELECT id FROM tables WHERE qr_token = $1', [table_token]);
  if (!t.rows[0]) return res.status(400).json({ error: 'invalid table' });
  const parsed = await buildOrderItems(pool, items);
  const id = await insertOrder(t.rows[0].id, parsed, String(note || '').slice(0, 300), 'qr');
  res.json({ id });
}));

/* ---------- staff: orders ---------- */
async function ordersWithItems(where, params) {
  const oq = await pool.query(
    `SELECT o.*, t.name AS table_name FROM orders o JOIN tables t ON t.id = o.table_id ${where} ORDER BY o.created_at ASC`, params);
  const orders = oq.rows;
  if (!orders.length) return [];
  const ids = orders.map(o => o.id);
  const iq = await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id', [ids]);
  const itemIds = iq.rows.map(i => i.id);
  const mq = itemIds.length
    ? await pool.query('SELECT * FROM order_item_mods WHERE order_item_id = ANY($1::int[]) ORDER BY id', [itemIds])
    : { rows: [] };
  const byOrder = {}; orders.forEach(o => { o.items = []; byOrder[o.id] = o; });
  const byItem = {}; iq.rows.forEach(i => { i.mods = []; byItem[i.id] = i; byOrder[i.order_id].items.push(i); });
  mq.rows.forEach(m => byItem[m.order_item_id]?.mods.push(m));
  const totalCents = o => o.items.reduce((s, i) =>
    s + (i.price_cents + i.mods.reduce((a, m) => a + m.price_cents, 0)) * i.qty, 0);
  return orders.map(o => ({
    id: o.id, table: o.table_name, table_id: o.table_id, status: o.status, source: o.source,
    note: o.note, created_at: o.created_at, updated_at: o.updated_at, paid_at: o.paid_at,
    pay_method: o.pay_method, total: cents2rm(totalCents(o)),
    items: o.items.map(i => ({
      item_id: i.item_id, name: i.name, qty: i.qty, price: cents2rm(i.price_cents), note: i.note,
      mods: i.mods.map(m => ({ name: m.name, price: cents2rm(m.price_cents) })),
    })),
  }));
}

app.get('/api/orders', awaitH(async (req, res) => {
  const auth = await requireAuth('admin', 'staff', 'kitchen'); await auth(req, res, () => {}); if (res.headersSent) return;
  if (req.query.mode === 'recent') {
    res.json(await ordersWithItems('WHERE true ORDER BY o.id DESC LIMIT 15', []));
  } else {
    res.json(await ordersWithItems("WHERE o.status NOT IN ('paid','cancelled')", []));
  }
}));

app.post('/api/orders', awaitH(async (req, res) => {
  const auth = await requireAuth('admin', 'staff'); await auth(req, res, () => {}); if (res.headersSent) return;
  const { table_id, items, note } = req.body || {};
  const parsed = await buildOrderItems(pool, items);
  const id = await insertOrder(Number(table_id), parsed, String(note || '').slice(0, 300), 'staff');
  res.json({ id });
}));

/* append items to an open order */
app.post('/api/orders/:id/items', awaitH(async (req, res) => {
  const auth = await requireAuth('admin', 'staff'); await auth(req, res, () => {}); if (res.headersSent) return;
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0] || ['paid', 'cancelled'].includes(o.rows[0].status))
    return res.status(400).json({ error: 'order closed' });
  const parsed = await buildOrderItems(pool, req.body.items);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const l of parsed) {
      const oi = await client.query(
        'INSERT INTO order_items (order_id, item_id, name, price_cents, qty, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [o.rows[0].id, l.item.id, l.item.name, l.item.price_cents, l.qty, l.note || null]);
      for (const m of l.mods)
        await client.query('INSERT INTO order_item_mods (order_item_id, name, price_cents) VALUES ($1,$2,$3)',
          [oi.rows[0].id, m.name, m.price_cents]);
    }
    await client.query('UPDATE orders SET updated_at = now() WHERE id = $1', [o.rows[0].id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

const TRANSITIONS = {
  sent: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served'],
  served: ['cancelled'],
};
app.patch('/api/orders/:id', awaitH(async (req, res) => {
  const auth = await requireAuth('admin', 'staff', 'kitchen'); await auth(req, res, () => {}); if (res.headersSent) return;
  const { status } = req.body || {};
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  const cur = o.rows[0].status;
  if (!(TRANSITIONS[cur] || []).includes(status)) return res.status(400).json({ error: `cannot go ${cur} -> ${status}` });
  if (status === 'cancelled' && req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  await pool.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [status, o.rows[0].id]);
  res.json({ ok: true });
}));

app.post('/api/orders/:id/pay', awaitH(async (req, res) => {
  const auth = await requireAuth('admin', 'staff'); await auth(req, res, () => {}); if (res.headersSent) return;
  const method = req.body?.method;
  if (!['Cash', 'Card', 'DuitNow/eWallet'].includes(method)) return res.status(400).json({ error: 'bad method' });
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!['served', 'ready', 'preparing', 'sent'].includes(o.rows[0].status))
    return res.status(400).json({ error: 'order already closed' });
  const t = await pool.query(`
    SELECT COALESCE(SUM((oi.price_cents + COALESCE(m.mx, 0)) * oi.qty), 0) AS c
    FROM order_items oi
    LEFT JOIN (SELECT order_item_id, SUM(price_cents) mx FROM order_item_mods GROUP BY 1) m
      ON m.order_item_id = oi.id
    WHERE oi.order_id = $1`, [o.rows[0].id]);
  let cents = Number(t.rows[0].c);
  if (method === 'Cash') cents = roundCashCents(cents);
  await pool.query(
    'UPDATE orders SET status = $1, paid_at = now(), updated_at = now(), pay_method = $2, pay_total_cents = $3 WHERE id = $4',
    ['paid', method, cents, o.rows[0].id]);
  res.json({ ok: true, paid: cents2rm(cents) });
}));

/* ---------- dashboard summary ---------- */
app.get('/api/summary', awaitH(async (req, res) => {
  const auth = await requireAuth('admin', 'staff'); await auth(req, res, () => {}); if (res.headersSent) return;
  const s = await pool.query(`
    WITH p AS (SELECT pay_total_cents, paid_at AT TIME ZONE '${KL}' AS lt FROM orders WHERE status = 'paid'),
    today AS (SELECT (now() AT TIME ZONE '${KL}')::date AS d)
    SELECT
      COALESCE(SUM(CASE WHEN lt::date = (SELECT d FROM today) THEN pay_total_cents END), 0)  today_cents,
      COUNT(CASE WHEN lt::date = (SELECT d FROM today) THEN 1 END)                           today_orders,
      COALESCE(SUM(CASE WHEN date_trunc('month', lt) = date_trunc('month', (SELECT d FROM today)::timestamptz) THEN pay_total_cents END), 0) month_cents,
      COUNT(CASE WHEN date_trunc('month', lt) = date_trunc('month', (SELECT d FROM today)::timestamptz) THEN 1 END) month_orders,
      COALESCE(SUM(CASE WHEN date_trunc('year', lt) = date_trunc('year', (SELECT d FROM today)::timestamptz) THEN pay_total_cents END), 0)  year_cents,
      COUNT(CASE WHEN date_trunc('year', lt) = date_trunc('year', (SELECT d FROM today)::timestamptz) THEN 1 END)  year_orders
    FROM p`);
  const open = await pool.query(
    "SELECT count(*)::int n FROM orders WHERE status IN ('sent','preparing','ready','served')");
  const top = await pool.query(`
    SELECT oi.name, SUM(oi.qty)::int sold
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status = 'paid' AND (o.paid_at AT TIME ZONE '${KL}')::date = (now() AT TIME ZONE '${KL}')::date
    GROUP BY oi.name ORDER BY sold DESC LIMIT 5`);
  const r = s.rows[0];
  res.json({
    today: { sales: cents2rm(r.today_cents), orders: Number(r.today_orders) },
    month: { sales: cents2rm(r.month_cents), orders: Number(r.month_orders) },
    year:  { sales: cents2rm(r.year_cents),  orders: Number(r.year_orders) },
    open_orders: open.rows[0].n,
    top_items: top.rows,
  });
}));

/* ---------- settings ---------- */
app.get('/api/settings', awaitH(async (req, res) => {
  const auth = await requireAuth('admin', 'staff', 'kitchen'); await auth(req, res, () => {}); if (res.headersSent) return;
  const r = await pool.query("SELECT value FROM settings WHERE key = 'sst_on'");
  res.json({ sst_on: r.rows[0]?.value === 'true' });
}));
app.patch('/api/settings', awaitH(async (req, res) => {
  const auth = await requireAuth('admin'); await auth(req, res, () => {}); if (res.headersSent) return;
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('sst_on', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [req.body?.sst_on ? 'true' : 'false']);
  res.json({ ok: true });
}));

/* ---------- admin: menu / tables / QR / users ---------- */
const adminOnly = () => requireAuth('admin');

app.get('/api/admin/menu', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const cats = await pool.query('SELECT * FROM categories ORDER BY sort, id');
  const items = await pool.query('SELECT * FROM items ORDER BY sort, id');
  const groups = await pool.query('SELECT * FROM modifier_groups ORDER BY id');
  const opts = await pool.query('SELECT * FROM modifier_options ORDER BY sort, id');
  res.json({ categories: cats.rows, items: items.rows, modifier_groups: groups.rows, modifier_options: opts.rows });
}));

app.post('/api/admin/items', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const { category_id, name, price, kandar } = req.body || {};
  if (!name || !(price >= 0)) return res.status(400).json({ error: 'name and price required' });
  const r = await pool.query(
    'INSERT INTO items (category_id, name, price_cents, kandar) VALUES ($1,$2,$3,$4) RETURNING id',
    [category_id || null, String(name).slice(0, 80), rm2cents(price), !!kandar]);
  res.json({ id: r.rows[0].id });
}));

app.patch('/api/admin/items/:id', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = $' + (vals.push(String(b.name).slice(0, 80)))); }
  if (b.price !== undefined) { sets.push('price_cents = $' + (vals.push(rm2cents(b.price)))); }
  if (b.category_id !== undefined) { sets.push('category_id = $' + (vals.push(b.category_id))); }
  if (b.available !== undefined) { sets.push('available = $' + (vals.push(!!b.available))); }
  if (b.kandar !== undefined) { sets.push('kandar = $' + (vals.push(!!b.kandar))); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  await pool.query(`UPDATE items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
}));

app.delete('/api/admin/items/:id', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/admin/categories', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const r = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [String(req.body?.name || '').slice(0, 60)]);
  res.json({ id: r.rows[0].id });
}));

app.post('/api/admin/modifier_options', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const { group_id, name, price } = req.body || {};
  const r = await pool.query(
    'INSERT INTO modifier_options (group_id, name, price_cents) VALUES ($1,$2,$3) RETURNING id',
    [group_id, String(name || '').slice(0, 60), rm2cents(price || 0)]);
  res.json({ id: r.rows[0].id });
}));

app.patch('/api/admin/modifier_options/:id', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const { available } = req.body || {};
  if (available === undefined) return res.status(400).json({ error: 'available required' });
  await pool.query('UPDATE modifier_options SET available = $1 WHERE id = $2', [!!available, req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/admin/modifier_options/:id', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  await pool.query('DELETE FROM modifier_options WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/admin/tables', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const r = await pool.query('SELECT id, name, qr_token FROM tables ORDER BY id');
  res.json(r.rows.map(t => ({ ...t, url: `${BASE_URL}/t/${t.qr_token}` })));
}));

app.post('/api/admin/tables', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name required' });
  const token = crypto.randomBytes(5).toString('hex');
  const r = await pool.query('INSERT INTO tables (name, qr_token) VALUES ($1,$2) RETURNING id', [name, token]);
  res.json({ id: r.rows[0].id, url: `${BASE_URL}/t/${token}` });
}));

app.get('/api/admin/tables/:id/qr.png', awaitH(async (req, res) => {
  const r = await pool.query('SELECT qr_token FROM tables WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  const buf = await QRCode.toBuffer(`${BASE_URL}/t/${r.rows[0].qr_token}`, { width: 512, margin: 1 });
  res.type('image/png').send(buf);
}));

app.get('/api/admin/users', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const r = await pool.query('SELECT id, name, role FROM users ORDER BY id');
  res.json(r.rows);
}));
app.post('/api/admin/users', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  const { name, role, pin } = req.body || {};
  if (!['admin', 'staff', 'kitchen'].includes(role) || !name || !pin)
    return res.status(400).json({ error: 'name, role, pin required' });
  const r = await pool.query('INSERT INTO users (name, role, pin_hash) VALUES ($1,$2,$3) RETURNING id',
    [String(name).slice(0, 40), role, hashPin(pin)]);
  res.json({ id: r.rows[0].id });
}));
app.delete('/api/admin/users/:id', awaitH(async (req, res) => {
  const auth = await adminOnly(); await auth(req, res, () => {}); if (res.headersSent) return;
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* customer page route */
app.get('/t/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer.html'), err => {
    if (err) res.type('text/plain').send('Customer page not deployed yet.');
  });
});

app.get('/', (req, res) => res.redirect('/index.html'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ---------- boot: schema + seed ---------- */
const CATS = ['Nasi Kandar', 'Mee & Goreng', 'Roti', 'Minuman Panas', 'Minuman Ais', 'Extras'];
const ITEMS = [
  [0, 'Nasi Kandar Ayam', 1200, true], [0, 'Nasi Kandar Daging', 1300, true],
  [0, 'Nasi Kandar Campur', 1400, true], [0, 'Nasi Kandar Sotong', 1500, true],
  [0, 'Nasi Kandar Udang', 1600, true],
  [1, 'Mee Goreng Mamak', 850, false], [1, 'Maggi Goreng', 800, false],
  [1, 'Nasi Goreng Kampung', 900, false], [1, 'Mee Rebus', 850, false],
  [2, 'Roti Canai', 200, false], [2, 'Roti Telur', 350, false],
  [2, 'Roti Tissue', 300, false], [2, 'Murtabak Ayam', 800, false],
  [3, 'Teh Tarik', 280, false], [3, 'Milo Panas', 320, false],
  [3, 'Kopi O', 250, false], [3, 'Teh Halia', 300, false],
  [4, 'Teh Tarik Ais', 350, false], [4, 'Milo Ais', 380, false],
  [4, 'Limau Ais', 300, false], [4, 'Sirap Bandung', 300, false],
  [5, 'Telur', 250, false], [5, 'Vadai', 250, false],
  [5, 'Samosa', 200, false], [5, 'Sambal', 150, false],
];

async function seed() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  
  // Add available column to modifier_options if not exists
  try {
    await pool.query('ALTER TABLE modifier_options ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT true');
  } catch(e) { /* column might already exist */ }
  
  const c = await pool.query('SELECT count(*)::int n FROM categories');
  if (c.rows[0].n === 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const catIds = [];
      for (const name of CATS)
        catIds.push((await client.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name])).rows[0].id);
      for (const [ci, name, cents, kandar] of ITEMS)
        await client.query('INSERT INTO items (category_id, name, price_cents, kandar) VALUES ($1,$2,$3,$4)',
          [catIds[ci], name, cents, kandar]);
      const g1 = (await client.query("INSERT INTO modifier_groups (name, mode) VALUES ('Kuah','radio') RETURNING id")).rows[0].id;
      const g2 = (await client.query("INSERT INTO modifier_groups (name, mode) VALUES ('Extra Lauk','checkbox') RETURNING id")).rows[0].id;
      for (const n of ['Banjir', 'Asing', 'Lebih Kuah'])
        await client.query('INSERT INTO modifier_options (group_id, name, price_cents, available) VALUES ($1,$2,0,true)', [g1, n]);
      for (const [n, p] of [['Telur', 250], ['Bendi', 200], ['Sambal', 150], ['Lebih Nasi', 200]])
        await client.query('INSERT INTO modifier_options (group_id, name, price_cents, available) VALUES ($1,$2,$3,true)', [g2, n, p]);
      await client.query('COMMIT');
      console.log('Seeded menu + modifiers');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  const t = await pool.query('SELECT count(*)::int n FROM tables');
  if (t.rows[0].n === 0) {
    const names = [...Array(12)].map((_, i) => `T${i + 1}`).concat(['Counter', 'Takeaway']);
    for (const n of names)
      await pool.query('INSERT INTO tables (name, qr_token) VALUES ($1,$2)', [n, crypto.randomBytes(5).toString('hex')]);
    console.log('Seeded 14 tables');
  }
  const u = await pool.query('SELECT count(*)::int n FROM users');
  if (u.rows[0].n === 0) {
    const pin = process.env.ADMIN_PIN || '1234';
    await pool.query("INSERT INTO users (name, role, pin_hash) VALUES ('Admin','admin',$1)", [hashPin(pin)]);
    console.log(`Seeded admin user (name: Admin, PIN: ${pin}) — CHANGE THIS PIN IN PRODUCTION`);
  }
}

async function boot(retries = 15) {
  try {
    await seed();
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`POS API + static on :${port}`));
  } catch (e) {
    if (retries <= 0) { console.error('Failed to boot:', e); process.exit(1); }
    console.log('DB not ready, retrying in 2s…');
    setTimeout(() => boot(retries - 1), 2000);
  }
}
boot();