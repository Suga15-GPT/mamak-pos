const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireRole, verifyPin } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, rm2cents } = require('../lib/money');
const { buildOrderItems, insertOrder, appendSend, ordersWithItems, writeAudit } = require('../services/orders');
const { publish } = require('../lib/events');
const printing = require('../services/printing');
const rounds = require('../services/rounds');
const {
  recomputeOrderBill, amountDue, hasPayments, listPayments, addPayment, addDiscount, listDiscounts, removeDiscount,
  addRefund, listRefunds,
  splitEvenly, splitBySeat, paidCentsFor, guardAgainstShortfall, settleIfMatchesPaid, previewBillExcludingLine,
} = require('../services/billing');

const router = express.Router();

// Short-lived, one-use authorization for a staff member to apply a discount, or
// (phase 12) issue a refund, that requires admin sign-off — an admin's PIN, not
// a full login session. In-memory is deliberate: same pattern as rateLimit in
// lib/auth.js, and these tokens are only ever meant to live for the next couple
// of minutes. Shared between the two actions rather than inventing a second
// authorize endpoint — a token just proves "an admin typed their PIN just now".
const discountAuthTokens = new Map();

router.get('/api/orders', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  let orders;
  if (req.query.mode === 'recent') {
    orders = await ordersWithItems('', [], 'ORDER BY o.id DESC LIMIT 15');
  } else {
    // #29: an open order forgotten for a week must not sit in every response
    // forever — bounded even on the default "everything open" call. ?since=
    // (an ISO timestamp) narrows to orders touched since then, for a caller
    // that already holds everything older.
    const sinceDate = req.query.since ? new Date(req.query.since) : null;
    orders = sinceDate && !isNaN(sinceDate)
      ? await ordersWithItems("WHERE o.status NOT IN ('paid','cancelled','refunded') AND o.updated_at > $1", [sinceDate], 'ORDER BY o.id ASC LIMIT 200')
      : await ordersWithItems("WHERE o.status NOT IN ('paid','cancelled','refunded')", [], 'ORDER BY o.id ASC LIMIT 200');
  }

  // Live payments-so-far + remaining balance, for the "RM X.XX remaining" display
  // and the payment modal's split/partial flows; discounts-so-far, so the payment
  // modal can show each applied discount with its reason and let an admin remove
  // one. (Phase 12) refunds-so-far, and each payment's still-refundable balance,
  // so the payment modal's refund dialog can offer a payment to refund against
  // without a second round trip.
  for (const o of orders) {
    const [payments, dueCents, discounts, refunds] = await Promise.all(
      [listPayments(o.id), amountDue(o.id), listDiscounts(o.id), listRefunds(o.id)]);
    const refundedByPayment = {};
    refunds.forEach(r => { refundedByPayment[r.payment_id] = (refundedByPayment[r.payment_id] || 0) + r.amount_cents; });
    o.payments = payments.map(p => ({
      id: p.id, method: p.method, amount: cents2rm(p.amount_cents),
      tendered: p.tendered_cents == null ? null : cents2rm(p.tendered_cents), at: p.at,
      refundable: cents2rm(p.amount_cents - (refundedByPayment[p.id] || 0)),
    }));
    o.amount_due = cents2rm(Math.max(0, dueCents));
    o.discounts = discounts.map(d => ({
      id: d.id, kind: d.kind, amount: cents2rm(d.amount_cents), reason: d.reason, at: d.at,
    }));
    o.refunds = refunds.map(r => ({
      id: r.id, payment_id: r.payment_id, method: r.method, amount: cents2rm(r.amount_cents), reason: r.reason, at: r.at,
    }));
  }
  res.json(orders);
}));

/* tables for staff/kitchen: names only, no qr_token (that stays admin-only).
   Retired tables are hidden from the floor but kept in the database, because
   old bills still name them. */
router.get('/api/tables', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const r = await pool.query('SELECT id, name FROM tables WHERE active ORDER BY sort, id');
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
  // Takeaway is a first-class order type, not a table called "Takeaway"
  // (master spec §23) — it takes no table at all, and any number can be open.
  const orderType = req.body?.order_type === 'takeaway' ? 'takeaway' : 'dine_in';
  const tableId = orderType === 'takeaway' ? null : Number(table_id);
  if (orderType === 'dine_in' && !(tableId > 0)) return res.status(400).json({ error: 'table_id required for a dine-in order' });

  const idemKey = req.headers['idempotency-key'] || null;
  if (idemKey) {
    const existing = await pool.query('SELECT id FROM orders WHERE idempotency_key = $1', [idemKey]);
    if (existing.rows[0]) return res.status(200).json({ id: existing.rows[0].id });
  }

  const parsed = await buildOrderItems(pool, items);
  try {
    const { orderId: id, sendId } = await insertOrder(
      tableId, parsed, String(note || '').slice(0, 300), 'staff', req.user.id, idemKey, { orderType });
    await recomputeOrderBill(id);
    await writeAudit(pool, {
      userId: req.user.id, action: 'order.create', entityType: 'order', entityId: id,
      detail: { table_id: tableId, order_type: orderType, source: 'staff', send_id: sendId, round: 1 },
    });
    publish('order.created', { order_id: id, table_id: tableId });
    await printing.enqueueRoundChits(sendId);
    res.status(201).json({ id });
  } catch (e) {
    // A concurrent retry of the *same* request (same table, same key) can hit
    // either unique index first depending on Postgres's own check ordering —
    // not just uniq_orders_idem specifically. Whenever a key was supplied,
    // check for it on any unique violation, not only that one constraint.
    if (idemKey && e.code === '23505') {
      const existing = await pool.query('SELECT id FROM orders WHERE idempotency_key = $1', [idemKey]);
      if (existing.rows[0]) return res.status(200).json({ id: existing.rows[0].id });
    }
    // one_open_order_per_table: a second tablet raced us to the same table.
    // Not a 500 — tell the client which order already exists so it can join it.
    if (e.code === '23505' && e.constraint === 'one_open_order_per_table') {
      const existing = await pool.query(
        "SELECT id FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled','refunded') ORDER BY id DESC LIMIT 1",
        [tableId]);
      return res.status(409).json({ error: 'table already has an open order', order_id: existing.rows[0]?.id });
    }
    throw e;
  }
}));

/* Append items to an open order — this opens a NEW kitchen round.
   The bill stays one bill; the new round starts at 'sent' with its own
   preparation lifecycle and never inherits the earlier rounds' state, which is
   the bug this whole redesign exists to fix.

   Idempotency-Key (phase 07) covers the whole batch; uniq_order_items_idem is
   one key per row, so each line gets a derived sub-key (`${key}:${index}`). The
   insert is one transaction, so a partial batch never persists — checking (or
   catching a concurrent-retry race on) line 0's derived key is enough to know
   the whole batch already landed. */
router.post('/api/orders/:id/items', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0] || ['paid', 'cancelled', 'refunded'].includes(o.rows[0].status))
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
  let result;
  try {
    result = await appendSend(o.rows[0].id, parsed, 'staff', req.user.id, idemKey, {
      audit: {
        userId: req.user.id, action: 'order.append', entityType: 'order', entityId: o.rows[0].id,
        detail: { items: parsed.map(l => ({ item_id: l.item.id, name: l.item.name, qty: l.qty })) },
      },
    });
  } catch (e) {
    if (idemKey && e.code === '23505' && e.constraint === 'uniq_order_items_idem') return res.json({ ok: true });
    throw e;
  }

  await recomputeOrderBill(o.rows[0].id);
  publish('order.updated', { order_id: o.rows[0].id, table_id: o.rows[0].table_id });
  // The new round prints its own chit(s) — only its own lines, at each station
  // it touches. The original order is never reprinted.
  await printing.enqueueRoundChits(result.sendId);
  res.json({ ok: true, send_id: result.sendId, round: result.seqNo });
}));

/* void a sent line — never deleted, just marked. staff may void while the order is
   still 'sent'; once the kitchen has moved it on, only admin may. */
router.post('/api/orders/:id/items/:lineId/void', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3 || reason.length > 200) return res.status(400).json({ error: 'reason must be 3-200 chars' });

  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  if (['paid', 'cancelled', 'refunded'].includes(o.rows[0].status)) return res.status(400).json({ error: 'order closed' });

  const li = await pool.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [req.params.lineId, o.rows[0].id]);
  if (!li.rows[0]) return res.status(404).json({ error: 'line not found' });
  if (li.rows[0].voided_at) return res.status(400).json({ error: 'already voided' });

  // Now that one bill can hold several rounds at different stages, "has the
  // kitchen started this?" is a question about *this line's* station ticket,
  // not about the order as a whole: a still-'sent' add-on stays staff-voidable
  // even though round 1 was served an hour ago.
  const lineStatus = await rounds.ticketStatusForLine(pool, li.rows[0].id);
  if (lineStatus && lineStatus !== 'sent' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'admin only once the kitchen has started this item' });

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
  await printing.enqueue('void', o.rows[0].id, { itemId: li.rows[0].id });
  res.json({ ok: true });
}));

/* Order-level status change.

   Cancelling is still an order-level act (an admin writes off the whole bill).
   Everything else is now really a statement about preparation, so it is applied
   to every live station ticket on the order that can legally make that move and
   the order's own status is re-derived from the result. Kitchen staff work
   tickets directly (PATCH /api/kitchen/tickets/:id); this route is what an
   order-level correction, and every pre-rounds client, still goes through. */
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE orders SET status = $1, closed_by = $2, updated_at = now() WHERE id = $3', [status, req.user.id, o.rows[0].id]);
      // Cancelling the bill stops every station: a cancelled ticket drops off
      // the kitchen display instead of being cooked for nobody.
      await client.query(
        `UPDATE order_send_tickets SET status = 'cancelled'
          WHERE send_id IN (SELECT id FROM order_sends WHERE order_id = $1) AND status <> 'served'`, [o.rows[0].id]);
      await writeAudit(client, {
        userId: req.user.id, action: 'order.cancel', entityType: 'order', entityId: o.rows[0].id,
        detail: { from: cur },
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tickets = (await client.query(
        `SELECT t.* FROM order_send_tickets t JOIN order_sends s ON s.id = t.send_id
          WHERE s.order_id = $1 AND s.approval_state = 'approved' AND t.status <> 'cancelled' FOR UPDATE OF t`,
        [o.rows[0].id])).rows;
      for (const t of tickets) {
        // Skip a ticket this move doesn't apply to rather than failing the
        // whole request: an order-level "Ready" on a bill whose drinks are
        // already ready should still move the food.
        if (!(rounds.TICKET_TRANSITIONS[t.status] || []).includes(status)) continue;
        const stamp = { preparing: ['preparing_at', 'preparing_by'], ready: ['ready_at', 'ready_by'], served: ['served_at', 'served_by'] }[status];
        if (stamp) {
          await client.query(`UPDATE order_send_tickets SET status = $1, ${stamp[0]} = now(), ${stamp[1]} = $2 WHERE id = $3`,
            [status, req.user.id, t.id]);
        } else {
          await client.query('UPDATE order_send_tickets SET status = $1 WHERE id = $2', [status, t.id]);
        }
      }
      await rounds.deriveOrderStatus(client, o.rows[0].id);
      await writeAudit(client, {
        userId: req.user.id, action: 'order.status', entityType: 'order', entityId: o.rows[0].id,
        detail: { from: cur, to: status, tickets: tickets.length },
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  publish('order.updated', { order_id: o.rows[0].id, table_id: o.rows[0].table_id });
  res.json({ ok: true });
}));

/* Move an open order to another table (master spec §50) — the whole dining
   order goes with it: rounds, bill, payments and audit are untouched, nothing
   is re-entered. Refuses a table that already has an open order rather than
   letting two bills collide on one table. */
router.post('/api/orders/:id/move', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const targetId = Number(req.body?.table_id);
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  if (['paid', 'cancelled', 'refunded'].includes(o.rows[0].status)) return res.status(400).json({ error: 'order closed' });
  if (!(targetId > 0)) return res.status(400).json({ error: 'table_id required' });

  const target = (await pool.query('SELECT id, name FROM tables WHERE id = $1', [targetId])).rows[0];
  if (!target) return res.status(404).json({ error: 'table not found' });
  if (o.rows[0].table_id === targetId) return res.status(400).json({ error: 'order is already on that table' });

  const from = (await pool.query('SELECT name FROM tables WHERE id = $1', [o.rows[0].table_id])).rows[0]?.name || null;
  try {
    await pool.query(
      "UPDATE orders SET table_id = $1, order_type = 'dine_in', updated_at = now() WHERE id = $2", [targetId, o.rows[0].id]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: `${target.name} already has an open order` });
    throw e;
  }
  await writeAudit(pool, {
    userId: req.user.id, action: 'order.move', entityType: 'order', entityId: o.rows[0].id,
    detail: { from_table_id: o.rows[0].table_id, from_table: from, to_table_id: targetId, to_table: target.name },
  });
  publish('order.updated', { order_id: o.rows[0].id, table_id: targetId });
  res.json({ ok: true, table_id: targetId, table: target.name });
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
  if (result.settled) await printing.enqueue('receipt', o.rows[0].id);
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

/* Manual reprint — admin only, and always audited: a reprinted receipt is a
   known fraud vector (a second copy handed to a customer who already paid,
   used to claim a refund elsewhere). */
router.post('/api/orders/:id/reprint-receipt', requireRole('admin'), awaitH(async (req, res) => {
  const o = await pool.query('SELECT id FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  await printing.reprintReceipt(o.rows[0].id, req.user.id);
  res.json({ ok: true });
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

/* Refund a specific payment (audit #39). Same admin-approval shape as a
   discount: admin issues directly, staff needs a token from
   POST /api/discounts/authorize (reused here rather than a second endpoint).
   Always against one payment_id, never free-floating, so it refunds by the
   method it was taken by and the drawer maths stays honest. */
router.post('/api/orders/:id/refunds', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const { payment_id, amount, reason, authorize_token } = req.body || {};
  const o = await pool.query('SELECT id, table_id FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });

  let approverId = req.user.id;
  if (req.user.role !== 'admin') {
    const auth = authorize_token && discountAuthTokens.get(authorize_token);
    if (!auth || auth.expires < Date.now()) return res.status(403).json({ error: 'admin authorization required' });
    discountAuthTokens.delete(authorize_token); // one-use
    approverId = auth.adminId;
  }

  const result = await addRefund(o.rows[0].id, {
    paymentId: Number(payment_id), amountCents: rm2cents(amount), reason, approvedBy: approverId, userId: req.user.id,
  });
  publish('order.updated', { order_id: o.rows[0].id, table_id: o.rows[0].table_id });
  res.json({ ok: true, id: result.id, amount: cents2rm(result.amount_cents), refunded_to_zero: result.refunded_to_zero });
}));

module.exports = router;
