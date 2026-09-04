const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireRole, verifyPin } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, rm2cents } = require('../lib/money');
const { buildOrderItems, insertOrder, ordersWithItems, writeAudit } = require('../services/orders');
const { publish } = require('../lib/events');
const {
  recomputeOrderBill, amountDue, hasPayments, listPayments, addPayment, addDiscount, listDiscounts, removeDiscount,
  splitEvenly, splitBySeat, paidCentsFor, guardAgainstShortfall, settleIfMatchesPaid, previewBillExcludingLine,
} = require('../services/billing');

const router = express.Router();

// Short-lived, one-use authorization for a staff member to apply a discount that
// requires admin sign-off (Do #4) — an admin's PIN, not a full login session.
// In-memory is deliberate: same pattern as rateLimit in lib/auth.js, and these
// tokens are only ever meant to live for the next couple of minutes.
const discountAuthTokens = new Map();

router.get('/api/orders', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const orders = req.query.mode === 'recent'
    ? await ordersWithItems('', [], 'ORDER BY o.id DESC LIMIT 15')
    : await ordersWithItems("WHERE o.status NOT IN ('paid','cancelled')", []);

  // Live payments-so-far + remaining balance, for the "RM X.XX remaining" display
  // and the payment modal's split/partial flows; discounts-so-far, so the payment
  // modal can show each applied discount with its reason and let an admin remove one.
  for (const o of orders) {
    const [payments, dueCents, discounts] = await Promise.all([listPayments(o.id), amountDue(o.id), listDiscounts(o.id)]);
    o.payments = payments.map(p => ({
      method: p.method, amount: cents2rm(p.amount_cents),
      tendered: p.tendered_cents == null ? null : cents2rm(p.tendered_cents), at: p.at,
    }));
    o.amount_due = cents2rm(Math.max(0, dueCents));
    o.discounts = discounts.map(d => ({
      id: d.id, kind: d.kind, amount: cents2rm(d.amount_cents), reason: d.reason, at: d.at,
    }));
  }
  res.json(orders);
}));

/* tables for staff/kitchen: names only, no qr_token (that stays admin-only) */
router.get('/api/tables', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const r = await pool.query('SELECT id, name FROM tables ORDER BY id');
  res.json(r.rows);
}));

/* Idempotency-Key (phase 07): a client-generated UUID per submission batch, so
   the offline outbox can retry a create it's unsure landed without risking a
   duplicate order. A duplicate key returns the original result with 200
   instead of erroring or creating a second row — checked up front for the
   common (sequential) retry, and again by catching the unique-index violation
   for the concurrent-retry race, the same pattern one_open_order_per_table
   already uses below. */
router.post('/api/orders', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const { table_id, items, note } = req.body || {};
  const idemKey = req.headers['idempotency-key'] || null;
  if (idemKey) {
    const existing = await pool.query('SELECT id FROM orders WHERE idempotency_key = $1', [idemKey]);
    if (existing.rows[0]) return res.status(200).json({ id: existing.rows[0].id });
  }

  const parsed = await buildOrderItems(pool, items);
  try {
    const id = await insertOrder(Number(table_id), parsed, String(note || '').slice(0, 300), 'staff', req.user.id, idemKey);
    await recomputeOrderBill(id);
    await writeAudit(pool, {
      userId: req.user.id, action: 'order.create', entityType: 'order', entityId: id,
      detail: { table_id: Number(table_id), source: 'staff' },
    });
    publish('order.created', { order_id: id, table_id: Number(table_id) });
    res.status(201).json({ id });
  } catch (e) {
    if (idemKey && e.code === '23505' && e.constraint === 'uniq_orders_idem') {
      const existing = await pool.query('SELECT id FROM orders WHERE idempotency_key = $1', [idemKey]);
      return res.status(200).json({ id: existing.rows[0].id });
    }
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

/* append items to an open order. Idempotency-Key (phase 07) covers the whole
   batch; uniq_order_items_idem is one key per row, so each line gets a
   derived sub-key (`${key}:${index}`). The insert is one transaction, so a
   partial batch never persists — checking (or catching a concurrent-retry
   race on) line 0's derived key is enough to know the whole batch already
   landed, without needing a batch-level key column of its own. */
router.post('/api/orders/:id/items', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0] || ['paid', 'cancelled'].includes(o.rows[0].status))
    return res.status(400).json({ error: 'order closed' });
  // Once any payment is recorded against the order, its total is being settled —
  // adding more lines would make what was just paid for wrong.
  if (await hasPayments(o.rows[0].id)) return res.status(409).json({ error: 'order has a payment recorded; cannot add items' });

  const idemKey = req.headers['idempotency-key'] || null;
  if (idemKey) {
    const existing = await pool.query('SELECT 1 FROM order_items WHERE idempotency_key = $1', [`${idemKey}:0`]);
    if (existing.rows[0]) return res.json({ ok: true });
  }

  const parsed = await buildOrderItems(pool, req.body.items);
  const client = await pool.connect();
  let duplicate = false;
  try {
    await client.query('BEGIN');
    for (const [i, l] of parsed.entries()) {
      const oi = await client.query(
        'INSERT INTO order_items (order_id, item_id, name, price_cents, qty, note, added_by, seat, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [o.rows[0].id, l.item.id, l.item.name, l.item.price_cents, l.qty, l.note || null, req.user.id, l.seat, idemKey ? `${idemKey}:${i}` : null]);
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
  } catch (e) {
    await client.query('ROLLBACK');
    if (idemKey && e.code === '23505' && e.constraint === 'uniq_order_items_idem') duplicate = true;
    else throw e;
  } finally { client.release(); }
  if (duplicate) return res.json({ ok: true });

  await recomputeOrderBill(o.rows[0].id);
  publish('order.updated', { order_id: o.rows[0].id, table_id: o.rows[0].table_id });
  res.json({ ok: true });
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

  // A partially-paid order's status stays 'sent' — voiding a line can drop the
  // total below what's already been paid, which the status check alone (paid
  // orders only) never catches. Guard before committing anything.
  const paidCents = await paidCentsFor(o.rows[0].id);
  const preview = await previewBillExcludingLine(o.rows[0].id, li.rows[0].id);
  guardAgainstShortfall('voiding this line', preview.total_cents, paidCents);

  await pool.query(
    'UPDATE order_items SET voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3',
    [req.user.id, reason, li.rows[0].id]);
  await pool.query('UPDATE orders SET updated_at = now() WHERE id = $1', [o.rows[0].id]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'order.void_line', entityType: 'order_item', entityId: li.rows[0].id,
    detail: { order_id: o.rows[0].id, name: li.rows[0].name, qty: li.rows[0].qty, price_cents: li.rows[0].price_cents, reason },
  });
  const bill = await recomputeOrderBill(o.rows[0].id);
  await settleIfMatchesPaid(o.rows[0].id, bill.total_cents, paidCents, req.user.id, 'void');
  publish('order.voided', { order_id: o.rows[0].id, table_id: o.rows[0].table_id });
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
  publish('order.updated', { order_id: o.rows[0].id, table_id: o.rows[0].table_id });
  res.json({ ok: true });
}));

/* One payment leg. Body: { method, amount?, tendered? } — amount (RM) defaults to
   the full remaining balance, so the old "click a method to pay in full" flow keeps
   working unchanged. tendered (RM, cash only) drives change due. Over-tendering in
   cash settles the order and returns change; over-amount by card/e-wallet is 400. */
router.post('/api/orders/:id/pay', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const { method, amount, tendered } = req.body || {};
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!['served', 'ready', 'preparing', 'sent'].includes(o.rows[0].status))
    return res.status(400).json({ error: 'order already closed' });

  const result = await addPayment(o.rows[0].id, {
    method,
    amountCents: amount != null ? rm2cents(amount) : null,
    tenderedCents: tendered != null ? rm2cents(tendered) : null,
    userId: req.user.id,
  });

  const after = (await pool.query('SELECT * FROM orders WHERE id = $1', [o.rows[0].id])).rows[0];
  publish('order.paid', { order_id: o.rows[0].id, table_id: o.rows[0].table_id });
  res.json({
    ok: true,
    paid: cents2rm(result.amount_cents),
    change: cents2rm(result.change_cents),
    remaining: cents2rm(result.remaining_cents),
    settled: result.settled,
    bill: {
      subtotal: cents2rm(after.subtotal_cents),
      service_charge: cents2rm(after.service_charge_cents),
      tax: cents2rm(after.tax_cents),
      discount: cents2rm(after.discount_cents),
      rounding: cents2rm(after.rounding_cents),
      total: cents2rm(after.total_cents),
    },
  });
}));

/* Preview only — does not record anything. ?ways=N for an even split of the
   remaining balance, or ?by=seat for a per-seat breakdown. */
router.get('/api/orders/:id/split', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  if (req.query.by === 'seat') {
    const bySeat = await splitBySeat(req.params.id);
    return res.json({ seats: Object.fromEntries(Object.entries(bySeat).map(([k, v]) => [k, cents2rm(v)])) });
  }
  const ways = parseInt(req.query.ways);
  if (!ways) return res.status(400).json({ error: 'ways or by=seat required' });
  const due = await amountDue(req.params.id);
  const shares = splitEvenly(due, ways);
  res.json({ shares: shares.map(cents2rm) });
}));

/* Staff can't self-approve a discount — an admin types their PIN here, which
   returns a short-lived, one-use token authorizing exactly one discount action. */
router.post('/api/discounts/authorize', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const name = String(req.body?.name || '');
  const u = await pool.query("SELECT id, pin_hash FROM users WHERE name = $1 AND role = 'admin'", [name]);
  if (!u.rows[0] || !verifyPin(req.body?.pin, u.rows[0].pin_hash)) return res.status(401).json({ error: 'invalid admin credentials' });
  const token = crypto.randomBytes(24).toString('hex');
  discountAuthTokens.set(token, { adminId: u.rows[0].id, expires: Date.now() + 2 * 60 * 1000 });
  res.json({ token, expires_in: 120 });
}));

router.post('/api/orders/:id/discounts', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const { kind, value, reason, authorize_token } = req.body || {};
  let approverId = req.user.id;
  if (req.user.role !== 'admin') {
    const auth = authorize_token && discountAuthTokens.get(authorize_token);
    if (!auth || auth.expires < Date.now()) return res.status(403).json({ error: 'admin authorization required' });
    discountAuthTokens.delete(authorize_token); // one-use
    approverId = auth.adminId;
  }
  // value at the API boundary is RM/percent for humans; billing.js works in cents/bp.
  const valueForBilling = kind === 'percent' ? Math.round(Number(value) * 100)
    : kind === 'amount' ? rm2cents(value)
    : 0;
  const result = await addDiscount(req.params.id, { kind, value: valueForBilling, reason, userId: approverId });
  res.json({ ok: true, id: result.id, amount: cents2rm(result.amount_cents) });
}));

/* Undo a discount applied by mistake — admin only, and only before any payment is
   recorded against the order (removing a discount only ever raises the total, so
   there's no shortfall to guard against; the restriction is about not undoing
   something the customer was already charged against). */
router.delete('/api/orders/:id/discounts/:discountId', requireRole('admin'), awaitH(async (req, res) => {
  await removeDiscount(req.params.id, req.params.discountId, { userId: req.user.id });
  res.json({ ok: true });
}));

module.exports = router;
