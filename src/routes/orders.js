const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, roundCashCents } = require('../lib/money');
const { buildOrderItems, insertOrder, ordersWithItems } = require('../services/orders');

const router = express.Router();

router.get('/api/orders', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  if (req.query.mode === 'recent') {
    res.json(await ordersWithItems('', [], 'ORDER BY o.id DESC LIMIT 15'));
  } else {
    res.json(await ordersWithItems("WHERE o.status NOT IN ('paid','cancelled')", []));
  }
}));

/* tables for staff/kitchen: names only, no qr_token (that stays admin-only) */
router.get('/api/tables', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const r = await pool.query('SELECT id, name FROM tables ORDER BY id');
  res.json(r.rows);
}));

router.post('/api/orders', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const { table_id, items, note } = req.body || {};
  const parsed = await buildOrderItems(pool, items);
  const id = await insertOrder(Number(table_id), parsed, String(note || '').slice(0, 300), 'staff');
  res.json({ id });
}));

/* append items to an open order */
router.post('/api/orders/:id/items', requireRole('admin', 'staff'), awaitH(async (req, res) => {
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
router.patch('/api/orders/:id', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const { status } = req.body || {};
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  const cur = o.rows[0].status;
  if (!(TRANSITIONS[cur] || []).includes(status)) return res.status(400).json({ error: `cannot go ${cur} -> ${status}` });
  if (status === 'cancelled' && req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  await pool.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [status, o.rows[0].id]);
  res.json({ ok: true });
}));

router.post('/api/orders/:id/pay', requireRole('admin', 'staff'), awaitH(async (req, res) => {
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

module.exports = router;
