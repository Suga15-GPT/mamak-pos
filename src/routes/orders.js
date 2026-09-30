const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireRole, verifyPin, pinAttempts } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, rm2cents } = require('../lib/money');
const { buildOrderItems, insertOrder, appendSend, ordersWithItems, writeAudit } = require('../services/orders');
const { publish } = require('../lib/events');
const printing = require('../services/printing');
const rounds = require('../services/rounds');
const { leaveGroupIfClosedTx } = require('../services/bill_groups');
const { lockBills } = require('../lib/billlock');
const { isClosed, openSql, closedBillError } = require('../lib/status');
const { requireFeature, isOn } = require('../services/features');
const merging = require('../services/merge');
const {
  recomputeOrderBill, amountDue, hasPayments, listPayments, addPayment, addDiscount, listDiscounts, removeDiscount,
  addRefund, listRefunds,
  splitEvenly, itemShare, paidCentsFor, guardAgainstShortfall, settleIfMatchesPaid, previewBillExcludingLine,
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
      ? await ordersWithItems(`WHERE ${openSql('o.status')} AND o.updated_at > $1`, [sinceDate], 'ORDER BY o.id ASC LIMIT 200')
      : await ordersWithItems(`WHERE ${openSql('o.status')}`, [], 'ORDER BY o.id ASC LIMIT 200');
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
      item_ids: p.item_ids || null,
    }));
    // Lines a "Split by items" share has paid for (a share refunded in full
    // paid for nothing), so the till can grey them out.
    o.paid_item_ids = [...new Set(payments
      .filter(p => p.item_ids && p.amount_cents > (refundedByPayment[p.id] || 0))
      .flatMap(p => p.item_ids))];
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

/* Idempotency-Key (phase 07): a client-generated UUID per submission batch, so
   the offline outbox can retry a create it's unsure landed without risking a
   duplicate order. A duplicate key returns the original result with 200
   instead of erroring or creating a second row — checked up front for the
   common (sequential) retry, and again by catching the unique-index violation
   for the concurrent-retry race, the same pattern one_open_order_per_card
   already uses below. */
router.post('/api/orders', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const { card_id, items, note } = req.body || {};
  // Takeaway is a first-class order type (master spec §23) — it takes no card
  // at all, and any number can be open. A dine-in order is identified by its
  // customer card; a new order never names a table (card mode, migration 014).
  const orderType = req.body?.order_type === 'takeaway' ? 'takeaway' : 'dine_in';
  const cardId = orderType === 'takeaway' ? null : Number(card_id);
  if (orderType === 'dine_in' && !(cardId > 0)) return res.status(400).json({ error: 'card_id required for a dine-in order' });

  const idemKey = req.headers['idempotency-key'] || null;
  if (idemKey) {
    const existing = await pool.query('SELECT id FROM orders WHERE idempotency_key = $1', [idemKey]);
    if (existing.rows[0]) return res.status(200).json({ id: existing.rows[0].id });
    // Landed before a Clear sales data: answered as done, never re-opened (D4).
    const archived = await pool.query("SELECT order_id FROM archived_idempotency_keys WHERE key = $1 AND kind = 'order'", [idemKey]);
    if (archived.rows[0]) return res.status(200).json({ id: archived.rows[0].order_id, archived: true });
  }

  const parsed = await buildOrderItems(pool, items);
  try {
    const { orderId: id, sendId } = await insertOrder(
      cardId, parsed, String(note || '').slice(0, 300), 'staff', req.user.id, idemKey, { orderType });
    const cardNo = cardId ? (await pool.query('SELECT number FROM cards WHERE id = $1', [cardId])).rows[0]?.number : null;
    await writeAudit(pool, {
      userId: req.user.id, action: 'order.create', entityType: 'order', entityId: id,
      detail: { card_id: cardId, card: cardNo != null ? `Card ${cardNo}` : null, order_type: orderType, source: 'staff', send_id: sendId, round: 1 },
    });
    publish('order.created', { order_id: id, card_id: cardId });
    await printing.enqueueRoundChits(sendId);
    res.status(201).json({ id });
  } catch (e) {
    // A concurrent retry of the *same* request (same card, same key) can hit
    // either unique index first depending on Postgres's own check ordering —
    // not just uniq_orders_idem specifically. Whenever a key was supplied,
    // check for it on any unique violation, not only that one constraint.
    if (idemKey && e.code === '23505') {
      const existing = await pool.query('SELECT id FROM orders WHERE idempotency_key = $1', [idemKey]);
      if (existing.rows[0]) return res.status(200).json({ id: existing.rows[0].id });
    }
    // one_open_order_per_card: a second till raced us to the same card.
    // Not a 500 — tell the client which order already exists so it can join it.
    if (e.code === '23505' && e.constraint === 'one_open_order_per_card') {
      const existing = await pool.query(
        `SELECT id FROM orders WHERE card_id = $1 AND ${openSql()} ORDER BY id DESC LIMIT 1`,
        [cardId]);
      return res.status(409).json({ error: 'card already has an open order', order_id: existing.rows[0]?.id });
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
  // A replay of a batch that already landed answers as it did the first time,
  // whatever has happened to the bill since: paid, combined into another card
  // (review D3), or moved out by Clear sales data (D4). Checked before the
  // bill is even looked up: otherwise a till whose first answer was lost is
  // told its items failed when they are in fact on the bill.
  const idemKey = req.headers['idempotency-key'] || null;
  if (idemKey) {
    const existing = await pool.query(
      `SELECT 1 FROM order_items WHERE idempotency_key = $1
       UNION ALL SELECT 1 FROM archived_idempotency_keys WHERE key = $1 AND kind = 'item'`, [`${idemKey}:0`]);
    if (existing.rows[0]) return res.json({ ok: true });
  }

  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(400).json({ error: 'order closed' });

  if (isClosed(o.rows[0].status)) {
    const e = await closedBillError(pool, o.rows[0], 'order closed', 400);
    return res.status(e.status).json({ error: e.message });
  }
  // Once any payment is recorded against the order, its total is being settled —
  // adding more lines would make what was just paid for wrong.
  if (await hasPayments(o.rows[0].id)) return res.status(409).json({ error: 'order has a payment recorded; cannot add items' });

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

  // appendSend recomputed the bill inside its own transaction; recomputing it
  // again here could land after a payment and rewrite a settled bill.
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

  // One transaction under the bill lock and the order's row lock. Everything
  // is read after locking: checked before it, a void racing a payment waited
  // on the payment's lock and then recomputed the bill it had just paid
  // (re-check, N-B). A bill closed by then is refused with 409.
  const client = await pool.connect();
  let o, li;
  try {
    await client.query('BEGIN');
    await lockBills(client);
    o = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!o.rows[0]) throw Object.assign(new Error('not found'), { status: 404 });
    if (isClosed(o.rows[0].status)) throw await closedBillError(client, o.rows[0], 'order closed');

    li = await client.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [req.params.lineId, o.rows[0].id]);
    if (!li.rows[0]) throw Object.assign(new Error('line not found'), { status: 404 });
    if (li.rows[0].voided_at) throw Object.assign(new Error('already voided'), { status: 400 });

    // Now that one bill can hold several rounds at different stages, "has the
    // kitchen started this?" is a question about *this line's* station ticket,
    // not about the order as a whole: a still-'sent' add-on stays staff-voidable
    // even though round 1 was served an hour ago.
    const lineStatus = await rounds.ticketStatusForLine(client, li.rows[0].id);
    if (lineStatus && lineStatus !== 'sent' && req.user.role !== 'admin')
      throw Object.assign(new Error('admin only once the kitchen has started this item'), { status: 403 });

    // A partially-paid order's status stays 'sent' — voiding a line can drop the
    // total below what's already been paid, which the status check alone (paid
    // orders only) never catches. Guard before committing anything.
    const paidCents = await paidCentsFor(o.rows[0].id, client);
    const preview = await previewBillExcludingLine(o.rows[0].id, li.rows[0].id, client);
    guardAgainstShortfall('voiding this line', preview.total_cents, paidCents);

    await client.query(
      'UPDATE order_items SET voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3',
      [req.user.id, reason, li.rows[0].id]);
    await client.query('UPDATE orders SET updated_at = now() WHERE id = $1', [o.rows[0].id]);
    await writeAudit(client, {
      userId: req.user.id, action: 'order.void_line', entityType: 'order_item', entityId: li.rows[0].id,
      detail: { order_id: o.rows[0].id, name: li.rows[0].name, qty: li.rows[0].qty, price_cents: li.rows[0].price_cents, reason },
    });
    const bill = await recomputeOrderBill(o.rows[0].id, client);
    await settleIfMatchesPaid(client, o.rows[0].id, bill.total_cents, paidCents, req.user.id, 'void');
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
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
  // Cancelling a bill is the till's; every other move here is preparation.
  if (status !== 'cancelled' && !(await isOn('kitchen'))) return res.status(404).json({ error: 'feature_disabled' });
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
      // Cancelling closes a bill: bill lock first, then re-read under the lock.
      await lockBills(client);
      const now = (await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [o.rows[0].id])).rows[0];
      if (!(TRANSITIONS[now.status] || []).includes('cancelled')) throw Object.assign(new Error(`cannot go ${now.status} -> cancelled`), { status: 409 });
      await client.query('UPDATE orders SET status = $1, closed_by = $2, updated_at = now() WHERE id = $3', [status, req.user.id, o.rows[0].id]);
      // Cancelling the bill stops every station: a cancelled ticket drops off
      // the kitchen display instead of being cooked for nobody.
      await rounds.cancelOpenTickets(client, o.rows[0].id);
      await writeAudit(client, {
        userId: req.user.id, action: 'order.cancel', entityType: 'order', entityId: o.rows[0].id,
        detail: { from: cur },
      });
      await leaveGroupIfClosedTx(client, o.rows[0].id, req.user.id, 'cancelled');
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Writes tickets and the order's status: bill lock first, then re-read
      // the order. Read before the lock, a tap racing a payment waited on it
      // and then wrote "served" over "paid" (re-check 2, K).
      await lockBills(client);
      const now = (await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [o.rows[0].id])).rows[0];
      if (!(TRANSITIONS[now.status] || []).includes(status)) throw Object.assign(new Error(`cannot go ${now.status} -> ${status}`), { status: 409 });
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

/* Move an open order to another card (a lost or swapped card) — the whole
   dining order goes with it: rounds, bill, payments, a combined bill and audit
   are untouched, nothing is re-entered. Refuses a card that already has an
   open order rather than letting two bills collide on one card. A table order
   from before card mode moves onto a card the same way, keeping its table_id
   as history — the card is what names it from then on. */
router.post('/api/orders/:id/move', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const targetId = Number(req.body?.card_id);
  const o = await pool.query(
    `SELECT o.*, c.number AS card_number, t.name AS table_name
       FROM orders o LEFT JOIN cards c ON c.id = o.card_id LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = $1`,
    [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  if (isClosed(o.rows[0].status)) return res.status(400).json({ error: 'order closed' });
  if (!(targetId > 0)) return res.status(400).json({ error: 'card_id required' });

  if (o.rows[0].card_id === targetId) return res.status(400).json({ error: 'order is already on that card' });

  const from = o.rows[0].card_number != null ? `Card ${o.rows[0].card_number}` : (o.rows[0].table_name || null);
  // The target card is locked FOR SHARE and its `active` re-read after the
  // lock, exactly as opening an order does: lowering the card count locks the
  // cards it retires FOR UPDATE, so the two can no longer interleave and leave
  // an open bill on a card that is off the floor (finding #4).
  const client = await pool.connect();
  let target;
  try {
    await client.query('BEGIN');
    await lockBills(client);
    // Re-read under the lock: checked only before it, a move racing a payment
    // waited for the payment and then relabelled the bill it had just paid
    // (a takeaway turned dine-in, a paid card moved). A bill closed by now is
    // refused.
    const now = (await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [o.rows[0].id])).rows[0];
    if (isClosed(now.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This bill has just been closed, so it can no longer be moved.' });
    }
    target = (await client.query('SELECT id, number, active FROM cards WHERE id = $1 FOR SHARE', [targetId])).rows[0];
    if (!target || !target.active) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'card not found' }); }
    await client.query(
      "UPDATE orders SET card_id = $1, order_type = 'dine_in', updated_at = now() WHERE id = $2", [targetId, o.rows[0].id]);
    // In the same transaction as the move, so the audit trail's order matches
    // the order things actually happened in.
    await writeAudit(client, {
      userId: req.user.id, action: 'order.move', entityType: 'order', entityId: o.rows[0].id,
      detail: {
        from_card_id: o.rows[0].card_id, from_table_id: o.rows[0].table_id, from, to_card_id: targetId, to: `Card ${target.number}`,
      },
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: `Card ${target.number} already has an open order` });
    throw e;
  } finally { client.release(); }
  publish('order.updated', { order_id: o.rows[0].id, card_id: targetId });
  res.json({ ok: true, card_id: targetId, card_number: target.number, label: `Card ${target.number}` });
}));

/* Combine: { from_order_id } — that card's bill joins this one. Its rounds,
   lines and kitchen tickets move here now, and its card is free (services/
   merge.js). This is what the till's Combine does; POST /api/bill-groups, the
   old pay-together grouping, stays for groups made before this shipped. */
const positiveId = v => /^[1-9][0-9]{0,9}$/.test(String(v)) && Number(v) <= 2147483647;
router.post('/api/orders/:id/merge', requireRole('admin', 'staff'), requireFeature('split_combine'), awaitH(async (req, res) => {
  if (!positiveId(req.params.id)) return res.status(404).json({ error: 'not found' });
  const r = await merging.merge(Number(req.params.id), req.body?.from_order_id, req.user.id);
  publish('order.updated', { order_id: r.order_id });
  publish('order.updated', { order_id: r.from_order_id, card_id: r.from_card_id });
  res.json({ ok: true, ...r });
}));

/* Separate: { card_id } — the rounds on this bill that came from that card go
   back to a new bill on it (services/merge.js). */
router.post('/api/orders/:id/separate', requireRole('admin', 'staff'), requireFeature('split_combine'), awaitH(async (req, res) => {
  if (!positiveId(req.params.id)) return res.status(404).json({ error: 'not found' });
  const r = await merging.separate(Number(req.params.id), req.body?.card_id, req.user.id);
  publish('order.updated', { order_id: r.order_id });
  publish('order.created', { order_id: r.new_order_id, card_id: r.card_id });
  res.json({ ok: true, ...r });
}));

/* One payment leg. Body: { method, amount?, tendered?, item_ids?, expected_due? } — amount (RM)
   defaults to the full remaining balance, so the old "click a method to pay in
   full" flow keeps working unchanged. tendered (RM, cash only) drives change due.
   Over-tendering in cash settles the order and returns change; over-amount by
   card/e-wallet is 400. item_ids makes the leg a "Split by items" share: the
   server works out what those lines come to, and `amount`, when given, is what
   the till showed — a bill that changed since is refused (409), not re-priced.
   expected_due (RM) is the "To pay" the till showed; when it no longer matches
   the balance, the leg is refused (409) the same way. */
router.post('/api/orders/:id/pay', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const { method, amount, tendered, item_ids: itemIds, expected_due: expectedDue } = req.body || {};
  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  if (isClosed(o.rows[0].status)) {
    const e = await closedBillError(pool, o.rows[0], 'order already closed', 400);
    return res.status(e.status).json({ error: e.message });
  }
  if (itemIds != null) {
    if (!(await isOn('split_combine'))) return res.status(404).json({ error: 'feature_disabled' });
    if (o.rows[0].bill_group_id) return res.status(409).json({ error: 'This card is on a combined bill. Remove it from the combined bill before splitting it.' });
  }

  const result = await addPayment(o.rows[0].id, {
    method,
    amountCents: amount != null ? rm2cents(amount) : null,
    tenderedCents: tendered != null ? rm2cents(tendered) : null,
    itemIds: itemIds != null ? itemIds : null,
    expectedDueCents: expectedDue != null ? rm2cents(expectedDue) : null,
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
router.post('/api/orders/:id/reprint-receipt', requireRole('admin'), requireFeature('printing'), awaitH(async (req, res) => {
  const o = await pool.query('SELECT id FROM orders WHERE id = $1', [req.params.id]);
  if (!o.rows[0]) return res.status(404).json({ error: 'not found' });
  await printing.reprintReceipt(o.rows[0].id, req.user.id);
  res.json({ ok: true });
}));

/* Preview only — does not record anything. ?ways=N for an even split of the
   remaining balance, or ?by=items&items=12,13 for what those lines come to
   with their share of the service charge and tax (the last share: whatever
   is left). Paying it is POST /pay with item_ids. */
router.get('/api/orders/:id/split', requireRole('admin', 'staff'), requireFeature('split_combine'), awaitH(async (req, res) => {
  const o = (await pool.query('SELECT bill_group_id FROM orders WHERE id = $1', [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: 'not found' });
  if (o.bill_group_id) return res.status(409).json({ error: 'This card is on a combined bill. Remove it from the combined bill before splitting it.' });
  if (req.query.by === 'items') {
    const ids = String(req.query.items || '').split(',').filter(Boolean).map(Number);
    const s = await itemShare(Number(req.params.id), ids);
    return res.json({ amount: cents2rm(s.share_cents), last: s.last, due: cents2rm(s.due_cents), item_ids: s.item_ids });
  }
  const ways = parseInt(req.query.ways);
  if (!ways) return res.status(400).json({ error: 'ways or by=items required' });
  const due = await amountDue(req.params.id);
  const shares = splitEvenly(due, ways);
  res.json({ shares: shares.map(cents2rm) });
}));

/* Staff can't self-approve a discount — an admin types their PIN here, which
   returns a short-lived, one-use token authorizing exactly one discount action. */
const AUTHORIZE_WINDOW_MS = 10 * 60 * 1000;
router.post('/api/discounts/authorize', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  // Shared by discounts and refunds, so it exists while either one does.
  if (!(await isOn('discounts')) && !(await isOn('refunds'))) return res.status(404).json({ error: 'feature_disabled' });
  const name = String(req.body?.name || '');
  // Any staff session can reach this, and the PIN it checks is an admin's
  // login PIN, so it gets the same wrong-PIN limit as login and Clear sales
  // data (review D2): five wrong per staff account, and ten per admin name
  // across every till, in ten minutes. Counted before anything is awaited.
  // A wrong PIN answers 403, not 401: 401 would log the staff member out.
  const attempts = await pinAttempts([
    [`admin-pin:user:${req.user.id}`, 5],
    [`admin-pin:admin:${name.trim().toLowerCase()}`, 10],
  ], AUTHORIZE_WINDOW_MS);
  if (!attempts) return res.status(429).json({ error: 'Too many wrong admin PINs. Wait ten minutes and try again.' });
  let u;
  try {
    u = await pool.query("SELECT id, pin_hash FROM users WHERE name = $1 AND role = 'admin' AND active", [name]);
    if (!u.rows[0] || !verifyPin(req.body?.pin, u.rows[0].pin_hash)) {
      attempts.wrong();
      return res.status(403).json({ error: 'invalid admin credentials' });
    }
  } finally {
    attempts.release();
  }
  const token = crypto.randomBytes(24).toString('hex');
  discountAuthTokens.set(token, { adminId: u.rows[0].id, expires: Date.now() + 2 * 60 * 1000 });
  res.json({ token, expires_in: 120 });
}));

router.post('/api/orders/:id/discounts', requireRole('admin', 'staff'), requireFeature('discounts'), awaitH(async (req, res) => {
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
router.delete('/api/orders/:id/discounts/:discountId', requireRole('admin'), requireFeature('discounts'), awaitH(async (req, res) => {
  await removeDiscount(req.params.id, req.params.discountId, { userId: req.user.id });
  res.json({ ok: true });
}));

/* Refund a specific payment (audit #39). Same admin-approval shape as a
   discount: admin issues directly, staff needs a token from
   POST /api/discounts/authorize (reused here rather than a second endpoint).
   Always against one payment_id, never free-floating, so it refunds by the
   method it was taken by and the drawer maths stays honest. */
router.post('/api/orders/:id/refunds', requireRole('admin', 'staff'), requireFeature('refunds'), awaitH(async (req, res) => {
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
