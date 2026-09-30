const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { lockBills } = require('../lib/billlock');
const { isClosed, openSql, closedBillError } = require('../lib/status');
const { writeAudit } = require('./orders');
const { recomputeOrderBill, paidCentsFor, settleIfMatchesPaid } = require('./billing');
const rounds = require('./rounds');
const features = require('./features');

/* ===== combining cards: one bill =====
   The owner's rule: on Card 1, Combine -> Card 4, and Card 4's items move
   onto Card 1's bill now; Card 4 is free for the next group.

   What moves is Card 4's rounds (order_sends), their lines and — because a
   kitchen ticket belongs to its round — every kitchen ticket, at whatever
   state it is in. Nothing is re-sent or re-printed. Each moved round
   remembers the card, order and round number it was sent as, so the kitchen
   board and the till call it "Card 1 (from 4) · Round 1", and "Separate Card
   4" knows exactly which rounds go back. A round keeps the card it was first
   ordered on: merging a card that had itself taken another card's items
   leaves those items labelled with their own card, separable on their own.

   Card 4's emptied order is closed as 'merged' (migration 019): a closed
   status of its own, so it is neither a sale ('paid'/'refunded') nor a
   cancellation, its card is free (one_open_order_per_card ignores it), and
   its row, id and idempotency key stay — a till retrying the create that
   opened it finds it, rather than opening Card 4 again with the same food.

   Both directions run under the bill lock (lib/billlock), then lock the
   orders, rounds and lines they touch, each in ascending id, and re-read
   everything they check after locking. A payment, kitchen tap, customer round
   or another merge is therefore wholly before or wholly after each one. */

const NAME = o => (o.card_number != null ? `Card ${o.card_number}` : `Order #${o.id}`);
// A row id: a positive int4. Anything else names nothing.
const isId = n => Number.isInteger(n) && n > 0 && n <= 2147483647;

async function lockOrders(client, ids) {
  return (await client.query(
    `SELECT o.*, cd.number AS card_number FROM orders o LEFT JOIN cards cd ON cd.id = o.card_id
      WHERE o.id = ANY($1::int[]) ORDER BY o.id FOR UPDATE OF o`, [ids])).rows;
}

async function heldRound(client, orderId) {
  return !!(await client.query(
    "SELECT 1 FROM order_sends WHERE order_id = $1 AND approval_state = 'pending' LIMIT 1", [orderId])).rows[0];
}

/* Card `fromOrderId`'s bill joins card `intoOrderId`'s. Refused (409) when
   either bill has a payment (net of refunds, as every other "has a payment"
   check), when the card moving has a discount of its own (remove it first) or
   a customer round still awaiting approval, and for takeaway, table orders,
   closed bills and cards still on a combined bill from before. */
async function merge(intoOrderId, fromOrderId, userId) {
  const into = Number(intoOrderId);
  const from = Number(fromOrderId);
  if (!isId(into) || !isId(from)) throw AppError('Choose the card to combine.', 400);
  if (into === from) throw AppError("A card can't be combined with itself.", 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockBills(client);
    // Switched off while this waited on the lock: the route would have 404ed.
    await features.requireOnTx(client, 'split_combine');
    const locked = await lockOrders(client, [into, from]);
    const target = locked.find(o => o.id === into);
    const source = locked.find(o => o.id === from);
    if (!target || !source) throw AppError('order not found', 404);

    for (const o of [target, source]) {
      if (isClosed(o.status)) throw await closedBillError(client, o, `${NAME(o)}'s bill is already closed.`);
      if (o.order_type !== 'dine_in' || !o.card_id) {
        throw AppError('Only card bills can be combined — not takeaway or table orders.', 409);
      }
      if (o.bill_group_id) {
        throw AppError(`${NAME(o)} is on a combined bill from before — take it off that bill first.`, 409);
      }
    }
    for (const o of [target, source]) {
      if (await paidCentsFor(o.id, client) > 0) {
        throw AppError(`${NAME(o)} has a payment on it, so it can't be combined.`, 409);
      }
    }
    if ((await client.query('SELECT 1 FROM discounts WHERE order_id = $1 LIMIT 1', [source.id])).rows[0]) {
      throw AppError(`${NAME(source)} has a discount — remove the discount first.`, 409);
    }
    if (await heldRound(client, source.id)) {
      throw AppError(`${NAME(source)} has a customer order waiting for approval — approve or reject it first.`, 409);
    }

    // Rounds move in their own order, numbered on after the target's rounds
    // (order_sends is unique on order and number); each keeps the card and
    // number it was first sent as — unless that card is the one it is
    // joining, in which case it is simply home again.
    const base = (await client.query(
      'SELECT COALESCE(max(seq_no), 0)::int AS n FROM order_sends WHERE order_id = $1', [target.id])).rows[0].n;
    const sends = (await client.query(
      `SELECT id, seq_no, merged_from_card_id, merged_from_order_id, merged_from_seq_no
         FROM order_sends WHERE order_id = $1 ORDER BY id FOR UPDATE`, [source.id])).rows
      .sort((a, b) => a.seq_no - b.seq_no);
    for (const [i, s] of sends.entries()) {
      const origin = s.merged_from_card_id
        ? { card: s.merged_from_card_id, order: s.merged_from_order_id, seq: s.merged_from_seq_no }
        : { card: source.card_id, order: source.id, seq: s.seq_no };
      const home = origin.card === target.card_id;
      await client.query(
        `UPDATE order_sends
            SET order_id = $1, seq_no = $2, merged_from_card_id = $3, merged_from_order_id = $4,
                merged_from_seq_no = $5, merged_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() END
          WHERE id = $6`,
        [target.id, base + i + 1, home ? null : origin.card, home ? null : origin.order, home ? null : origin.seq, s.id]);
    }
    await client.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id FOR UPDATE', [source.id]);
    const moved = await client.query(
      'UPDATE order_items SET order_id = $1 WHERE order_id = $2 RETURNING id', [target.id, source.id]);

    const bill = await recomputeOrderBill(target.id, client);
    // Card 4's tickets are now Card 1's: its status is the most urgent of all.
    await rounds.deriveOrderStatus(client, target.id);
    await client.query('UPDATE orders SET updated_at = now() WHERE id = $1', [target.id]);

    // Card 4's order is empty: its bill is zero, and it closes as merged.
    await client.query(
      `UPDATE orders SET status = 'merged', merged_into_order_id = $1, closed_by = $2,
              subtotal_cents = 0, service_charge_cents = 0, tax_cents = 0, discount_cents = 0,
              rounding_cents = 0, total_cents = 0, updated_at = now()
        WHERE id = $3`,
      [target.id, userId || null, source.id]);

    await writeAudit(client, {
      userId, action: 'order.merge', entityType: 'order', entityId: target.id,
      detail: {
        from_order_id: source.id, from: NAME(source), to: NAME(target),
        send_ids: sends.map(s => s.id), line_count: moved.rowCount, bill_total_cents: bill.total_cents,
      },
    });
    await client.query('COMMIT');
    return {
      order_id: target.id, label: NAME(target), from_order_id: source.id, from_label: NAME(source),
      from_card_id: source.card_id, rounds: sends.length, lines: moved.rowCount,
    };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* "Separate Card 4" on the bill Card 4 was merged into: exactly the rounds
   that came from Card 4 — their lines and kitchen tickets with them — go to a
   new order on Card 4, numbered as they were sent there. Allowed only while
   this bill has no payment (net of refunds) and Card 4 is still free, and not
   while this bill carries a discount given after Card 4 joined it: nobody can
   say whose that discount was, so it comes off first. */
async function separate(orderId, cardId, userId) {
  const id = Number(orderId);
  const card = Number(cardId);
  if (!isId(id) || !isId(card)) throw AppError('Choose the card to separate.', 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockBills(client);
    await features.requireOnTx(client, 'split_combine');
    const [order] = await lockOrders(client, [id]);
    if (!order) throw AppError('order not found', 404);
    if (isClosed(order.status)) throw await closedBillError(client, order, 'This bill is already closed.');

    // FOR SHARE, as opening an order takes it: lowering the card count can't
    // retire the card in the same instant (cards.setCardCountTx).
    const c = (await client.query('SELECT id, number, active FROM cards WHERE id = $1 FOR SHARE', [card])).rows[0];
    if (!c) throw AppError('card not found', 404);
    const label = `Card ${c.number}`;
    const sends = (await client.query(
      `SELECT id, sent_at, merged_at, merged_from_order_id FROM order_sends
        WHERE order_id = $1 AND merged_from_card_id = $2 ORDER BY id FOR UPDATE`, [order.id, c.id])).rows
      .sort((a, b) => a.sent_at - b.sent_at || a.id - b.id);
    if (!sends.length) throw AppError(`Nothing on this bill came from ${label}.`, 404);

    if (await paidCentsFor(order.id, client) > 0) {
      throw AppError(`This bill has a payment on it, so ${label}'s items can't be separated.`, 409);
    }
    if (!c.active) throw AppError(`${label} is no longer in use at this shop, so its items can't go back to it.`, 409);
    const busy = (await client.query(
      `SELECT 1 FROM orders WHERE card_id = $1 AND ${openSql()} LIMIT 1`, [c.id])).rows[0];
    if (busy) throw AppError(`${label} has a new bill of its own now, so its earlier items can't go back to it.`, 409);
    const joined = sends.reduce((t, s) => (!t || s.merged_at < t ? s.merged_at : t), null);
    const discounted = (await client.query(
      'SELECT 1 FROM discounts WHERE order_id = $1 AND at >= $2 LIMIT 1', [order.id, joined])).rows[0];
    if (discounted) throw AppError(`This bill has a discount given after ${label} joined it — remove the discount first.`, 409);

    // The new bill carries what the card's first bill did, and the shift open
    // now, like any order opened now (none with shifts switched off).
    const first = (await client.query(
      'SELECT source, note FROM orders WHERE id = $1', [sends[0].merged_from_order_id])).rows[0] || {};
    const shiftId = await features.moneyShift(client);
    const fresh = (await client.query(
      `INSERT INTO orders (card_id, status, source, note, opened_by, shift_id, order_type)
       VALUES ($1, 'sent', $2, $3, $4, $5, 'dine_in') RETURNING id`,
      [c.id, first.source || 'staff', first.note || null, userId || null, shiftId])).rows[0].id;

    for (const [i, s] of sends.entries()) {
      await client.query(
        `UPDATE order_sends
            SET order_id = $1, seq_no = $2,
                merged_from_card_id = NULL, merged_from_order_id = NULL, merged_from_seq_no = NULL, merged_at = NULL
          WHERE id = $3`,
        [fresh, i + 1, s.id]);
    }
    await client.query(
      'SELECT id FROM order_items WHERE order_id = $1 AND send_id = ANY($2::int[]) ORDER BY id FOR UPDATE',
      [order.id, sends.map(s => s.id)]);
    const moved = await client.query(
      'UPDATE order_items SET order_id = $1 WHERE order_id = $2 AND send_id = ANY($3::int[]) RETURNING id',
      [fresh, order.id, sends.map(s => s.id)]);

    await client.query('UPDATE orders SET updated_at = now() WHERE id = $1', [order.id]);
    for (const oid of [order.id, fresh]) {
      const bill = await recomputeOrderBill(oid, client);
      // A discount bigger than what stays on this bill (its own lines voided
      // since) would leave it owing less than nothing.
      if (oid === order.id && bill.total_cents < 0) {
        throw AppError(`This bill's discount is more than what would be left on it without ${label} — remove the discount first.`, 409);
      }
      await rounds.deriveOrderStatus(client, oid);
      // Neither bill has a payment (refused above), so one whose lines were
      // all voided comes to RM0 and closes itself, as a void to zero does
      // anywhere else — never an open RM0 bill staff can't pay or cancel (D7).
      await settleIfMatchesPaid(client, oid, bill.total_cents, 0, userId, 'separate');
    }

    await writeAudit(client, {
      userId, action: 'order.separate', entityType: 'order', entityId: order.id,
      detail: {
        from: NAME(order), to: label, new_order_id: fresh,
        send_ids: sends.map(s => s.id), line_count: moved.rowCount,
      },
    });
    await client.query('COMMIT');
    return { order_id: order.id, new_order_id: fresh, card_id: c.id, label, rounds: sends.length, lines: moved.rowCount };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

module.exports = { merge, separate };
