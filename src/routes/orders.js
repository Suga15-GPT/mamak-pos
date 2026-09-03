const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, computeBill } = require('../lib/money');
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

  // Recompute from order_items/order_item_mods server-side; never trust a client total.
  const items = await pool.query('SELECT id, price_cents, qty FROM order_items WHERE order_id = $1', [o.rows[0].id]);
  const mods = items.rows.length
    ? await pool.query('SELECT order_item_id, price_cents FROM order_item_mods WHERE order_item_id = ANY($1::int[])',
        [items.rows.map(i => i.id)])
    : { rows: [] };
  const modsByItem = {};
  mods.rows.forEach(m => (modsByItem[m.order_item_id] ||= []).push(m));
  const lines = items.rows.map(i => ({ price_cents: i.price_cents, qty: i.qty, mods: modsByItem[i.id] || [] }));

  const rateRows = await pool.query("SELECT key, value FROM settings WHERE key IN ('tax_rate_bp', 'svc_rate_bp')");
  const rates = Object.fromEntries(rateRows.rows.map(r => [r.key, Number(r.value)]));
  const taxRateBp = rates.tax_rate_bp || 0;
  const svcRateBp = rates.svc_rate_bp || 0;

  const bill = computeBill({ lines, taxRateBp, svcRateBp, discountCents: 0, method });

  await pool.query(
    `UPDATE orders SET status = 'paid', paid_at = now(), updated_at = now(), pay_method = $1, pay_total_cents = $2,
       subtotal_cents = $3, service_charge_cents = $4, tax_cents = $5, discount_cents = $6,
       rounding_cents = $7, total_cents = $8, tax_rate_bp = $9, svc_rate_bp = $10
     WHERE id = $11`,
    [method, bill.total_cents, bill.subtotal_cents, bill.service_charge_cents, bill.tax_cents,
     bill.discount_cents, bill.rounding_cents, bill.total_cents, taxRateBp, svcRateBp, o.rows[0].id]);

  res.json({
    ok: true,
    paid: cents2rm(bill.total_cents),
    bill: {
      subtotal: cents2rm(bill.subtotal_cents),
      service_charge: cents2rm(bill.service_charge_cents),
      tax: cents2rm(bill.tax_cents),
      discount: cents2rm(bill.discount_cents),
      rounding: cents2rm(bill.rounding_cents),
      total: cents2rm(bill.total_cents),
    },
  });
}));

module.exports = router;
