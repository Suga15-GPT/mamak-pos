const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { cents2rm, roundCashCents, formatRM } = require('../lib/money');
const { lockBills } = require('../lib/billlock');
const { writeAudit, ordersWithItems } = require('./orders');
const rounds = require('./rounds');

/* ===== combined bills =====
   A bill group settles several card orders together. Nothing moves between
   orders: every card keeps its own order, rounds, kitchen tickets and its own
   per-order tax, computed exactly as it always was. The group total is simply
   the sum of its members' totals — tax is never recomputed on a combined
   subtotal. Payments stay one row per order, so shifts, Z reports and refunds
   read them exactly as before.

   A combined bill is paid all at once: the payment legs (say RM20 cash and the
   rest by card) are submitted together and written in one transaction, and
   anything short of the whole bill is refused. There is no state in which a
   combined bill is part-paid. */

const CLOSED = ['paid', 'cancelled', 'refunded'];
const METHODS = ['Cash', 'Card', 'DuitNow/eWallet'];
const UNCOMBINE_BLOCKED = "This combined bill has a payment on it and can't be split apart.";
const NOT_IN_FULL = 'A combined bill has to be paid in full in one go.';

/* Locks everything a group operation touches. The bill lock (lib/billlock)
   comes first: every operation that can change membership, settle a bill or
   change a total holds it, so the group closure read next cannot change
   underneath us, and the rows are then locked in one fixed order — orders by
   ascending id, groups by ascending id. The earlier version locked the orders
   it was given and then discovered and locked the rest of their groups while
   still holding the first set, which deadlocked whenever a discovered order had
   a lower id (PR #16 re-check, #5). Returns the locked orders (with card
   numbers) and the locked groups. */
async function lockGroupSet(client, orderIds) {
  await lockBills(client);
  const ids = [...new Set(orderIds.map(Number))].filter(id => id > 0);
  const closure = (await client.query(
    `SELECT id FROM orders WHERE id = ANY($1::int[])
     UNION
     SELECT m.id FROM orders o JOIN orders m ON m.bill_group_id = o.bill_group_id WHERE o.id = ANY($1::int[])`,
    [ids])).rows.map(r => r.id);
  const orders = (await client.query(
    `SELECT o.*, c.number AS card_number FROM orders o LEFT JOIN cards c ON c.id = o.card_id
      WHERE o.id = ANY($1::int[]) ORDER BY o.id FOR UPDATE OF o`, [closure])).rows;
  const groupIds = [...new Set(orders.map(o => o.bill_group_id).filter(Boolean))].sort((a, b) => a - b);
  const groups = groupIds.length ? (await client.query(
    'SELECT * FROM bill_groups WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [groupIds])).rows : [];
  return { orders, groups };
}

// Locks a group and all its members; members come back in allocation order
// (ascending card number). Membership is read after the bill lock, so it is
// the membership that gets locked.
async function lockGroup(client, groupId) {
  await lockBills(client);
  const memberIds = (await client.query('SELECT id FROM orders WHERE bill_group_id = $1', [groupId])).rows.map(r => r.id);
  const { orders, groups } = await lockGroupSet(client, memberIds);
  let g = groups.find(x => x.id === Number(groupId));
  if (!g) g = (await client.query('SELECT * FROM bill_groups WHERE id = $1 FOR UPDATE', [groupId])).rows[0];
  if (!g) throw AppError('combined bill not found', 404);
  if (g.closed_at) throw AppError('this combined bill is already closed', 409);
  const members = orders.filter(o => o.bill_group_id === g.id).sort((a, b) => a.card_number - b.card_number);
  return { group: g, members };
}

// Paid and not given back, per order.
async function paidByOrder(client, orderIds) {
  if (!orderIds.length) return {};
  const r = await client.query(
    `SELECT o.id,
            COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.order_id = o.id), 0)::int
          - COALESCE((SELECT SUM(amount_cents) FROM refunds r WHERE r.order_id = o.id), 0)::int AS s
       FROM orders o WHERE o.id = ANY($1::int[])`, [orderIds]);
  return Object.fromEntries(r.rows.map(x => [x.id, x.s]));
}

/* Clears bill_group_id on `removed`; a group left with fewer than two cards is
   not a combined bill and dissolves. One audit row for the removal, one for a
   dissolve. */
async function detach(client, group, members, removed, { userId, action, reason = null }) {
  const removedIds = removed.map(m => m.id);
  const rest = members.filter(m => !removedIds.includes(m.id));
  await client.query('UPDATE orders SET bill_group_id = NULL, updated_at = now() WHERE id = ANY($1::int[])', [removedIds]);
  await writeAudit(client, {
    userId, action, entityType: 'bill_group', entityId: group.id,
    detail: { order_ids: removedIds, cards: removed.map(m => `Card ${m.card_number}`), ...(reason ? { reason } : {}) },
  });
  if (rest.length >= 2) return { dissolved: false, order_ids: removedIds };
  await client.query('UPDATE bill_groups SET closed_at = now() WHERE id = $1', [group.id]);
  if (rest.length) {
    await client.query('UPDATE orders SET bill_group_id = NULL, updated_at = now() WHERE id = ANY($1::int[])', [rest.map(m => m.id)]);
    await writeAudit(client, {
      userId, action: 'bill_group.dissolve', entityType: 'bill_group', entityId: group.id,
      detail: { order_ids: rest.map(m => m.id), cards: rest.map(m => `Card ${m.card_number}`), reason: 'fewer than two cards left' },
    });
  }
  return { dissolved: true, order_ids: [...removedIds, ...rest.map(m => m.id)] };
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
    const { orders: locked, groups: lockedGroups } = await lockGroupSet(client, ids);
    const orders = locked.filter(o => ids.includes(o.id));
    if (orders.length !== ids.length) throw AppError('order not found', 404);
    for (const o of orders) {
      if (CLOSED.includes(o.status)) throw AppError(`Order #${o.id} is already closed and can't be combined`, 409);
      if (o.order_type !== 'dine_in' || !o.card_id) throw AppError('Only open card orders can be combined — not takeaway or table orders', 409);
    }
    // Combined bills are paid all at once, so a card that has already taken
    // money of its own can't join one.
    // Net of refunds: a card whose payment was refunded in full has nothing of
    // its own to settle, so "pay or refund it" really does let it join.
    const netPaid = await paidByOrder(client, ids);
    if (ids.some(id => netPaid[id] > 0)) throw AppError('This card has a payment on it — pay or refund it before combining.', 409);

    const groups = [...new Set(orders.map(o => o.bill_group_id).filter(Boolean))].sort((a, b) => a - b);
    for (const g of groups) {
      if (lockedGroups.find(x => x.id === g)?.closed_at) throw AppError('this combined bill is already closed', 409);
    }
    let groupId;
    if (groups.length) {
      groupId = groups[0];
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
   member has a payment — a card paid part-way on its own before it was
   combined keeps that money attached to the combined bill it joined. */
async function uncombine(groupId, { orderId = null, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { group, members } = await lockGroup(client, groupId);
    if (orderId != null && !members.some(m => m.id === Number(orderId))) throw AppError('that card is not on this combined bill', 404);
    // Net of refunds, as combine checks it.
    const paid = await paidByOrder(client, members.map(m => m.id));
    if (members.some(m => paid[m.id] > 0)) throw AppError(UNCOMBINE_BLOCKED, 409);

    const removed = orderId != null ? members.filter(m => m.id === Number(orderId)) : members;
    const r = await detach(client, group, members, removed, {
      userId, action: orderId != null ? 'bill_group.remove' : 'bill_group.dissolve',
    });
    await client.query('COMMIT');
    return r;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* A grouped card that closes on its own while its group is unpaid — voided to
   zero, comped, or cancelled when its only QR round was rejected — leaves the
   group automatically, and a group left with one card dissolves. Otherwise the
   remaining cards could never be paid (finding #1). No-op for an order that is
   not grouped or still open. */
async function leaveGroupIfClosedTx(client, orderId, userId, reason) {
  const { orders, groups } = await lockGroupSet(client, [orderId]);
  const me = orders.find(x => x.id === Number(orderId));
  const group = groups.find(g => g.id === me?.bill_group_id);
  if (!me || !group || group.closed_at || !CLOSED.includes(me.status)) return null;
  // A card with a customer order still awaiting approval never leaves on its
  // own: that order must stay visible and decidable (re-check, R-A).
  const held = (await client.query(
    "SELECT 1 FROM order_sends WHERE order_id = $1 AND approval_state = 'pending' LIMIT 1", [me.id])).rows[0];
  if (held) return null;
  const members = orders.filter(x => x.bill_group_id === group.id);
  return detach(client, group, members, [me], {
    userId, action: 'bill_group.remove', reason: `Card ${me.card_number} closed on its own (${reason})`,
  });
}

/* The combined bill: each member order (with its lines, for the "Card N"
   headings) and the money summed across members. */
async function getGroup(groupId) {
  const g = (await pool.query('SELECT * FROM bill_groups WHERE id = $1', [groupId])).rows[0];
  if (!g) throw AppError('combined bill not found', 404);
  const members = (await ordersWithItems('WHERE o.bill_group_id = $1', [g.id], 'ORDER BY cd.number'))
    .filter(o => o.status !== 'cancelled');
  const cents = (await pool.query(
    `SELECT o.id, o.status, o.subtotal_cents, o.service_charge_cents, o.tax_cents, o.discount_cents, o.rounding_cents, o.total_cents,
            COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.order_id = o.id), 0)::int
          - COALESCE((SELECT SUM(amount_cents) FROM refunds r WHERE r.order_id = o.id), 0)::int AS paid_cents,
            EXISTS (SELECT 1 FROM order_sends s WHERE s.order_id = o.id AND s.approval_state = 'pending') AS held
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
    // A round awaiting approval blocks payment until someone decides on it.
    awaiting_approval: cents.some(o => o.held),
  };
}

// Payment legs as the route passes them (cents). At most one cash leg; every
// other leg names its amount.
function checkLegs(legs) {
  if (!Array.isArray(legs) || !legs.length || legs.length > 4) throw AppError('legs must list how the bill is being paid', 400);
  for (const l of legs) {
    if (!l || !METHODS.includes(l.method)) throw AppError('bad method', 400);
    if (l.method !== 'Cash' && !(Number.isInteger(l.amountCents) && l.amountCents > 0)) throw AppError('each card or e-wallet leg needs an amount', 400);
    if (l.method === 'Cash' && l.amountCents != null && !(Number.isInteger(l.amountCents) && l.amountCents >= 0)) throw AppError('bad cash amount', 400);
  }
  if (legs.filter(l => l.method === 'Cash').length > 1) throw AppError('only one cash payment per combined bill', 400);
}

/* Pays a combined bill in full, in one go. `legs` are the ways the customer is
   paying ({method, amountCents, tenderedCents?}); card and e-wallet legs name
   their amounts and together may not exceed the group's due; the one cash leg
   covers whatever is left, after 5-sen rounding applied once to that
   remainder, and change = tendered − rounded remainder. Legs that do not
   settle the group exactly are refused: nothing is written.

   Every leg is written in one transaction as ordinary per-order payments rows
   (same taken_by and shift), allocated in ascending card number until each
   member's balance is covered — legs in the order given, cash last. The cash
   rounding lands on the last member settled in cash; a 1-2 sen cash remainder
   that rounds to nothing settles on the rounding alone, with no zero-sen
   payment row (finding #6). Every member becomes paid, and the group closes,
   in the same transaction. */
async function payGroup(groupId, { legs, userId }) {
  checkLegs(legs);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { members: all } = await lockGroup(client, groupId);
    const members = all.filter(m => !CLOSED.includes(m.status));
    if (!members.length) throw AppError('combined bill already settled', 400);
    await rounds.refuseWhileHeld(client, members.map(m => m.id));

    const paid = await paidByOrder(client, members.map(m => m.id));
    const dues = members.map(m => ({ m, due: Math.max(0, (m.total_cents || 0) - (paid[m.id] || 0)) }));
    const groupDue = dues.reduce((s, d) => s + d.due, 0);
    if (groupDue <= 0) throw AppError('combined bill already settled', 400);

    // Same control as a single order's payment: no open shift, no payment.
    const shiftId = (await client.query('SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1')).rows[0]?.id;
    if (!shiftId) throw AppError('no shift is open — open a shift before taking payment', 400);

    const nonCash = legs.filter(l => l.method !== 'Cash');
    const cash = legs.find(l => l.method === 'Cash');
    const nonCashSum = nonCash.reduce((s, l) => s + l.amountCents, 0);
    if (nonCashSum > groupDue) throw AppError('card and e-wallet amounts are more than the bill', 400);
    const remainder = groupDue - nonCashSum;

    let rounded = 0, tendered = null, changeCents = 0;
    if (remainder > 0) {
      if (!cash) throw AppError(NOT_IN_FULL, 400);
      rounded = roundCashCents(remainder);
      tendered = cash.tenderedCents ?? cash.amountCents ?? rounded;
      if (tendered < rounded) throw AppError(`Cash given ${formatRM(tendered)} is less than the ${formatRM(rounded)} still due`, 400);
      if (cash.amountCents != null && cash.amountCents < rounded) throw AppError(NOT_IN_FULL, 400);
      changeCents = tendered - rounded;
    } else if (cash) {
      throw AppError('the card and e-wallet amounts already cover this bill — take the cash off', 400);
    }

    // Allocate: members by card number, legs in the order given, cash last.
    const sources = nonCash.map(l => ({ method: l.method, left: l.amountCents }));
    if (remainder > 0) sources.push({ method: 'Cash', left: remainder });
    const rows = [];
    for (const d of dues) {
      let need = d.due;
      while (need > 0) {
        const src = sources.find(x => x.left > 0);
        const take = Math.min(need, src.left);
        rows.push({ m: d.m, method: src.method, amount: take, rounding: 0 });
        src.left -= take;
        need -= take;
      }
    }
    // Cash rounding, once: up onto the last cash row; down off the cash rows
    // from the last one back, so no row goes below zero.
    let adj = rounded - remainder;
    const cashRows = rows.filter(r => r.method === 'Cash');
    if (adj > 0) { cashRows[cashRows.length - 1].amount += adj; cashRows[cashRows.length - 1].rounding += adj; }
    for (let i = cashRows.length - 1; adj < 0 && i >= 0; i--) {
      const take = Math.min(-adj, cashRows[i].amount);
      cashRows[i].amount -= take;
      cashRows[i].rounding -= take;
      adj += take;
    }

    const written = rows.filter(r => r.amount > 0);
    const lastCash = [...written].reverse().find(r => r.method === 'Cash');
    for (const r of written) {
      // Each cash row's own change reads true: only the last one carries the
      // change handed back for the whole group.
      const rowTendered = r.method === 'Cash' ? r.amount + (r === lastCash ? changeCents : 0) : null;
      r.payment_id = (await client.query(
        'INSERT INTO payments (order_id, method, amount_cents, tendered_cents, taken_by, shift_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [r.m.id, r.method, r.amount, rowTendered, userId || null, shiftId])).rows[0].id;
      await writeAudit(client, {
        userId, action: 'order.pay', entityType: 'order', entityId: r.m.id,
        detail: {
          payment_id: r.payment_id, method: r.method, amount_cents: r.amount, tendered_cents: rowTendered,
          bill_group_id: Number(groupId), card: `Card ${r.m.card_number}`, settled: true,
        },
      });
    }
    const roundingByOrder = {};
    rows.forEach(r => { if (r.rounding) roundingByOrder[r.m.id] = (roundingByOrder[r.m.id] || 0) + r.rounding; });
    for (const [id, cents] of Object.entries(roundingByOrder)) {
      await client.query('UPDATE orders SET rounding_cents = rounding_cents + $1, total_cents = total_cents + $1 WHERE id = $2', [cents, Number(id)]);
    }

    await client.query(
      "UPDATE orders SET status = 'paid', paid_at = now(), paid_by = $1, closed_shift_id = $2, updated_at = now() WHERE id = ANY($3::int[])",
      [userId || null, shiftId, members.map(m => m.id)]);
    await client.query('UPDATE bill_groups SET closed_at = now() WHERE id = $1', [groupId]);

    const paidCents = nonCashSum + rounded;
    await writeAudit(client, {
      userId, action: 'bill_group.pay', entityType: 'bill_group', entityId: Number(groupId),
      detail: {
        legs: legs.map(l => ({ method: l.method, amount_cents: l.method === 'Cash' ? rounded : l.amountCents })),
        amount_cents: paidCents, tendered_cents: tendered, change_cents: changeCents, rounding_cents: rounded - remainder,
        allocations: written.map(r => ({ order_id: r.m.id, card: `Card ${r.m.card_number}`, payment_id: r.payment_id, method: r.method, amount_cents: r.amount })),
      },
    });
    await client.query('COMMIT');
    return {
      amount_cents: paidCents, tendered_cents: tendered, change_cents: changeCents, rounding_cents: rounded - remainder,
      settled: true, order_ids: members.map(m => m.id),
      allocations: written.map(r => ({ order_id: r.m.id, card_number: r.m.card_number, method: r.method, amount_cents: r.amount })),
    };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

module.exports = { combine, uncombine, getGroup, payGroup, leaveGroupIfClosedTx, UNCOMBINE_BLOCKED, NOT_IN_FULL };
