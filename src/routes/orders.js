const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, computeBill } = require('../lib/money');
const { buildOrderItems, insertOrder, ordersWithItems, writeAudit } = require('../services/orders');

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
  try {
    const id = await insertOrder(Number(table_id), parsed, String(note || '').slice(0, 300), 'staff', req.user.id);
    await writeAudit(pool, {
      userId: req.user.id, action: 'order.create', entityType: 'order', entityId: id,
      detail: { table_id: Number(table_id), source: 'staff' },
    });
    res.status(201).json({ id });
  } catch (e) {
    // one_open_order_per_table: a second tablet raced us to the same table.
    // Not a 500 — tell the client which order already exists so it can join it.
    if (e.code === '23505' && e.constraint === 'one_open_order_per_table') {
      const existing = await pool.query(
        "SELECT id FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled') ORDER BY id DESC LIMIT 1",
        [Number(table_id)]);
      return res.status(409).json({ error: 'table already has an open order', order_id: existing.rows[0]?.id });
    }
    throw e;
  }
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
        'INSERT INTO order_items (order_id, item_id, name, price_cents, qty, note, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [o.rows[0].id, l.item.id, l.item.name, l.item.price_cents, l.qty, l.note || null, req.user.id]);
      for (const m of l.mods)
        await client.query('INSERT INTO order_item_mods (order_item_id, name, price_cents) VALUES ($1,$2,$3)',
          [oi.rows[0].id, m.name, m.price_cents]);
    }
    await client.query('UPDATE orders SET updated_at = now() WHERE id = $1', [o.rows[0].id]);
    await writeAudit(client, {
      userId: req.user.id, action: 'order.append', entityType: 'order', entityId: o.rows[0].id,
      detail: { items: parsed.map(l => ({ item_id: l.item.id, name: l.item.name, qty: l.qty })) },
    });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

/* void a sent line — never deleted, just marked. staff may void while the order is
   still 'sent'; once the kitchen has moved it on, only admin may. */
router.post('/api/orders/:id/items/:lineId/void', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3 || reason.length > 200) return res.status(400).json({ error: 'reason must be 3-200 chars' });

  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  if (['paid', 'cancelled'].includes(o.rows[0].status)) return res.status(400).json({ error: 'order closed' });
  if (o.rows[0].status !== 'sent' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'admin only once the kitchen has started this order' });

  const li = await pool.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [req.params.lineId, o.rows[0].id]);
  if (!li.rows[0]) return res.status(404).json({ error: 'line not found' });
  if (li.rows[0].voided_at) return res.status(400).json({ error: 'already voided' });

  await pool.query(
    'UPDATE order_items SET voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3',
    [req.user.id, reason, li.rows[0].id]);
  await pool.query('UPDATE orders SET updated_at = now() WHERE id = $1', [o.rows[0].id]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'order.void_line', entityType: 'order_item', entityId: li.rows[0].id,
    detail: { order_id: o.rows[0].id, name: li.rows[0].name, qty: li.rows[0].qty, price_cents: li.rows[0].price_cents, reason },
  });
  res.json({ ok: true });
}));

const TRANSITIONS = {
  sent: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled', 'sent'],
  ready: ['served', 'preparing'],
  served: ['cancelled', 'ready'],
};
// Backward moves are a staff/admin correction of a mis-tap, not something kitchen
// should be able to self-serve (kitchen only ever moves an order forward).
const BACKWARD = new Set(['preparing>sent', 'ready>preparing', 'served>ready']);
router.patch('/api/orders/:id', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const { status } = req.body || {};
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  const cur = o.rows[0].status;
  if (!(TRANSITIONS[cur] || []).includes(status)) return res.status(400).json({ error: `cannot go ${cur} -> ${status}` });
  if (status === 'cancelled' && req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  if (BACKWARD.has(`${cur}>${status}`) && req.user.role === 'kitchen') return res.status(403).json({ error: 'staff/admin only' });

  if (status === 'cancelled') {
    await pool.query('UPDATE orders SET status = $1, closed_by = $2, updated_at = now() WHERE id = $3', [status, req.user.id, o.rows[0].id]);
    await writeAudit(pool, {
      userId: req.user.id, action: 'order.cancel', entityType: 'order', entityId: o.rows[0].id,
      detail: { from: cur },
    });
  } else {
    await pool.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [status, o.rows[0].id]);
    await writeAudit(pool, {
      userId: req.user.id, action: 'order.status', entityType: 'order', entityId: o.rows[0].id,
      detail: { from: cur, to: status },
    });
  }
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
  // Voided lines are excluded — they were never actually served.
  const items = await pool.query('SELECT id, price_cents, qty FROM order_items WHERE order_id = $1 AND voided_at IS NULL', [o.rows[0].id]);
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
       rounding_cents = $7, total_cents = $8, tax_rate_bp = $9, svc_rate_bp = $10, paid_by = $11
     WHERE id = $12`,
    [method, bill.total_cents, bill.subtotal_cents, bill.service_charge_cents, bill.tax_cents,
     bill.discount_cents, bill.rounding_cents, bill.total_cents, taxRateBp, svcRateBp, req.user.id, o.rows[0].id]);

  await writeAudit(pool, {
    userId: req.user.id, action: 'order.pay', entityType: 'order', entityId: o.rows[0].id,
    detail: { method, total_cents: bill.total_cents },
  });

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
