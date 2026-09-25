const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { cents2rm, roundCashCents } = require('../lib/money');
const { writeAudit, ordersWithItems } = require('./orders');

/* ===== combined bills =====
   A bill group settles several card orders together. Nothing moves between
   orders: every card keeps its own order, rounds, kitchen tickets and its own
   per-order tax, computed exactly as it always was. The group total is simply
   the sum of its members' totals — tax is never recomputed on a combined
   subtotal. Payments stay one row per order, so shifts, Z reports and refunds
   read them exactly as before. */

const CLOSED = ['paid', 'cancelled', 'refunded'];
const UNCOMBINE_BLOCKED = "This combined bill has a payment on it and can't be split apart.";

async function lockGroup(client, groupId) {
  const g = (await client.query('SELECT * FROM bill_groups WHERE id = $1 FOR UPDATE', [groupId])).rows[0];
  if (!g) throw AppError('combined bill not found', 404);
  if (g.closed_at) throw AppError('this combined bill is already closed', 409);
  return g;
}

// Members in the order payments are allocated: ascending card number.
async function lockMembers(client, groupId) {
  return (await client.query(
    `SELECT o.*, c.number AS card_number FROM orders o JOIN cards c ON c.id = o.card_id
      WHERE o.bill_group_id = $1 ORDER BY c.number FOR UPDATE OF o`, [groupId])).rows;
}

async function paidByOrder(client, orderIds) {
  if (!orderIds.length) return {};
  const r = await client.query(
    'SELECT order_id, COALESCE(SUM(amount_cents), 0)::int s FROM payments WHERE order_id = ANY($1::int[]) GROUP BY order_id',
    [orderIds]);
  return Object.fromEntries(r.rows.map(x => [x.order_id, x.s]));
}

/* Combine. Adding a card that is already grouped joins its group; naming
   orders from two different groups merges them into one (the older group
   survives, the other is closed). */
async function combine(orderIds, userId) {
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map(Number))].filter(id => id > 0);
  if (ids.length < 2) throw AppError('choose at least two cards to combine', 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orders = (await client.query(
      `SELECT o.id, o.status, o.order_type, o.card_id, o.bill_group_id, c.number AS card_number
         FROM orders o LEFT JOIN cards c ON c.id = o.card_id
        WHERE o.id = ANY($1::int[]) ORDER BY o.id FOR UPDATE OF o`, [ids])).rows;
    if (orders.length !== ids.length) throw AppError('order not found', 404);
    for (const o of orders) {
      if (CLOSED.includes(o.status)) throw AppError(`Order #${o.id} is already closed and can't be combined`, 409);
      if (o.order_type !== 'dine_in' || !o.card_id) throw AppError('Only open card orders can be combined — not takeaway or table orders', 409);
    }

    const groups = [...new Set(orders.map(o => o.bill_group_id).filter(Boolean))].sort((a, b) => a - b);
    let groupId;
    if (groups.length) {
      groupId = groups[0];
      for (const g of groups) await lockGroup(client, g);
      const others = groups.slice(1);
      if (others.length) {
        await client.query('UPDATE orders SET bill_group_id = $1, updated_at = now() WHERE bill_group_id = ANY($2::int[])', [groupId, others]);
        await client.query('UPDATE bill_groups SET closed_at = now() WHERE id = ANY($1::int[])', [others]);
      }
    } else {
      groupId = (await client.query('INSERT INTO bill_groups (created_by) VALUES ($1) RETURNING id', [userId || null])).rows[0].id;
    }
    await client.query('UPDATE orders SET bill_group_id = $1, updated_at = now() WHERE id = ANY($2::int[])', [groupId, ids]);

    await writeAudit(client, {
      userId, action: 'bill_group.combine', entityType: 'bill_group', entityId: groupId,
      detail: {
        order_ids: ids, cards: orders.map(o => `Card ${o.card_number}`),
        merged_groups: groups.filter(g => g !== groupId),
      },
    });
    await client.query('COMMIT');
    return { id: groupId };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* Un-combine: remove one card, or dissolve the whole group. Refused once any
   member has a payment — that money was allocated across the group, and
   splitting it apart afterwards would leave each card's payments meaningless. */
async function uncombine(groupId, { orderId = null, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockGroup(client, groupId);
    const members = await lockMembers(client, groupId);
    if (orderId != null && !members.some(m => m.id === Number(orderId))) throw AppError('that card is not on this combined bill', 404);
    const paid = await paidByOrder(client, members.map(m => m.id));
    if (members.some(m => paid[m.id] > 0)) throw AppError(UNCOMBINE_BLOCKED, 409);

    let removed = orderId != null ? members.filter(m => m.id === Number(orderId)) : members;
    // A group of one is not a combined bill: removing the second-last card
    // dissolves it.
    if (members.length - removed.length < 2) removed = members;
    const dissolved = removed.length === members.length;
    await client.query('UPDATE orders SET bill_group_id = NULL, updated_at = now() WHERE id = ANY($1::int[])', [removed.map(m => m.id)]);
    if (dissolved) await client.query('UPDATE bill_groups SET closed_at = now() WHERE id = $1', [groupId]);

    await writeAudit(client, {
      userId, action: orderId != null ? 'bill_group.remove' : 'bill_group.dissolve', entityType: 'bill_group', entityId: Number(groupId),
      detail: { order_ids: removed.map(m => m.id), cards: removed.map(m => `Card ${m.card_number}`), dissolved },
    });
    await client.query('COMMIT');
    return { dissolved, order_ids: removed.map(m => m.id) };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* The combined bill: each member order (with its lines, for the "Card N"
   headings) and the money summed across members. A cancelled member owes
   nothing and is left out of the sums. */
async function getGroup(groupId) {
  const g = (await pool.query('SELECT * FROM bill_groups WHERE id = $1', [groupId])).rows[0];
  if (!g) throw AppError('combined bill not found', 404);
  const members = (await ordersWithItems('WHERE o.bill_group_id = $1', [g.id], 'ORDER BY cd.number'))
    .filter(o => o.status !== 'cancelled');
  const cents = (await pool.query(
    `SELECT o.id, o.status, o.subtotal_cents, o.service_charge_cents, o.tax_cents, o.discount_cents, o.rounding_cents, o.total_cents,
            COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.order_id = o.id), 0)::int AS paid_cents
       FROM orders o WHERE o.bill_group_id = $1 AND o.status <> 'cancelled'`, [g.id])).rows;
  const sum = k => cents.reduce((s, o) => s + (o[k] || 0), 0);
  const dueCents = cents.filter(o => !CLOSED.includes(o.status))
    .reduce((s, o) => s + Math.max(0, (o.total_cents || 0) - o.paid_cents), 0);
  const byId = Object.fromEntries(cents.map(o => [o.id, o]));
  return {
    id: g.id, created_at: g.created_at, closed_at: g.closed_at,
    members: members.map(o => ({
      ...o,
      paid: cents2rm(byId[o.id]?.paid_cents || 0),
      amount_due: cents2rm(CLOSED.includes(o.status) ? 0 : Math.max(0, (byId[o.id]?.total_cents || 0) - (byId[o.id]?.paid_cents || 0))),
    })),
    subtotal: cents2rm(sum('subtotal_cents')),
    service_charge: cents2rm(sum('service_charge_cents')),
    tax: cents2rm(sum('tax_cents')),
    discount: cents2rm(sum('discount_cents')),
    rounding: cents2rm(sum('rounding_cents')),
    total: cents2rm(sum('total_cents')),
    paid: cents2rm(sum('paid_cents')),
    amount_due: cents2rm(dueCents),
  };
}

/* One payment against the whole group. It is written as one payments row per
   member order it reaches (same method, taken_by, shift_id), allocated in
   ascending card number until each member's balance is covered, so the rows
   always sum exactly to what was taken. Cash 5-sen rounding is applied once,
   to the group's remaining due, only on the leg that settles the group; its
   adjustment lands on the last member settled. Change is the group's. When the
   group's due reaches zero every open member becomes paid, and the group
   closes, in this same transaction. */
async function payGroup(groupId, { method, amountCents, tenderedCents, userId }) {
  if (!['Cash', 'Card', 'DuitNow/eWallet'].includes(method)) throw AppError('bad method', 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockGroup(client, groupId);
    const members = (await lockMembers(client, groupId)).filter(m => !CLOSED.includes(m.status));
    const paid = await paidByOrder(client, members.map(m => m.id));
    const dues = members.map(m => ({ m, due: Math.max(0, (m.total_cents || 0) - (paid[m.id] || 0)) }));
    const groupDue = dues.reduce((s, d) => s + d.due, 0);
    if (groupDue <= 0) throw AppError('combined bill already settled', 400);

    // Same control as a single order's payment: no open shift, no payment.
    const shiftId = (await client.query('SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1')).rows[0]?.id;
    if (!shiftId) throw AppError('no shift is open — open a shift before taking payment', 400);

    let apply = amountCents == null ? groupDue : Number(amountCents);
    if (!(Number.isInteger(apply) && apply > 0)) throw AppError('amount must be positive', 400);

    let roundingAdj = 0;
    let tendered = null;
    if (method === 'Cash') {
      tendered = tenderedCents == null ? apply : Number(tenderedCents);
      if (apply >= groupDue) {
        const rounded = roundCashCents(groupDue);
        roundingAdj = rounded - groupDue;
        apply = rounded;
        if (tenderedCents == null) tendered = apply;
      }
      if (tendered < apply) throw AppError('cash tendered is less than the amount', 400);
    } else if (apply > groupDue) {
      throw AppError('amount exceeds balance due', 400);
    }
    const settling = apply - roundingAdj >= groupDue;

    // Allocate the pre-rounding amount member by member, then fold the
    // rounding into the last member settled (the last one with a share big
    // enough to absorb a round-down, since a payment row must be > 0).
    let left = apply - roundingAdj;
    const legs = [];
    for (const d of dues) {
      if (left <= 0) break;
      const take = Math.min(d.due, left);
      if (take > 0) legs.push({ m: d.m, amount: take });
      left -= take;
    }
    if (roundingAdj) {
      const target = [...legs].reverse().find(l => l.amount + roundingAdj > 0);
      target.amount += roundingAdj;
      target.rounding = roundingAdj;
    }

    const changeCents = tendered != null ? tendered - apply : 0;
    for (const [i, leg] of legs.entries()) {
      // tendered is recorded per row so each row's own change reads true: only
      // the last row carries the change handed back for the whole group.
      const legTendered = tendered == null ? null : leg.amount + (i === legs.length - 1 ? changeCents : 0);
      leg.payment_id = (await client.query(
        'INSERT INTO payments (order_id, method, amount_cents, tendered_cents, taken_by, shift_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [leg.m.id, method, leg.amount, legTendered, userId || null, shiftId])).rows[0].id;
      if (leg.rounding) {
        await client.query('UPDATE orders SET rounding_cents = rounding_cents + $1, total_cents = total_cents + $1 WHERE id = $2',
          [leg.rounding, leg.m.id]);
      }
      await writeAudit(client, {
        userId, action: 'order.pay', entityType: 'order', entityId: leg.m.id,
        detail: {
          payment_id: leg.payment_id, method, amount_cents: leg.amount, tendered_cents: legTendered,
          bill_group_id: Number(groupId), card: `Card ${leg.m.card_number}`, settled: settling,
        },
      });
    }

    if (settling) {
      await client.query(
        "UPDATE orders SET status = 'paid', paid_at = now(), paid_by = $1, closed_shift_id = $2, updated_at = now() WHERE id = ANY($3::int[])",
        [userId || null, shiftId, members.map(m => m.id)]);
      await client.query('UPDATE bill_groups SET closed_at = now() WHERE id = $1', [groupId]);
    }

    const remainingCents = settling ? 0 : groupDue - apply;
    await writeAudit(client, {
      userId, action: 'bill_group.pay', entityType: 'bill_group', entityId: Number(groupId),
      detail: {
        method, amount_cents: apply, tendered_cents: tendered, change_cents: changeCents, rounding_cents: roundingAdj,
        remaining_cents: remainingCents, settled: settling,
        allocations: legs.map(l => ({ order_id: l.m.id, card: `Card ${l.m.card_number}`, payment_id: l.payment_id, amount_cents: l.amount })),
      },
    });
    await client.query('COMMIT');
    return {
      amount_cents: apply, tendered_cents: tendered, change_cents: changeCents, remaining_cents: remainingCents,
      settled: settling, order_ids: members.map(m => m.id),
      allocations: legs.map(l => ({ order_id: l.m.id, card_number: l.m.card_number, amount_cents: l.amount })),
    };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

module.exports = { combine, uncombine, getGroup, payGroup, UNCOMBINE_BLOCKED };
