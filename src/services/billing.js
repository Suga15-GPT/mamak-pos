const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { computeBill, roundCashCents, roundHalfUp } = require('../lib/money');
const { writeAudit } = require('./orders');

// Rebuilds subtotal/service_charge/tax/discount/total from order_items + discounts,
// using the *current* live settings rates (this order isn't paid/finalised yet, so
// nothing here is "historical" — the snapshot-at-payment rule from phase 02 only
// bites once the order actually closes). No cash rounding is baked in here: that's
// a payment-time artifact applied only to the final settling cash leg, in
// addPayment, not a property of the bill itself.
async function recomputeOrderBill(orderId) {
  const items = await pool.query(
    'SELECT id, price_cents, qty FROM order_items WHERE order_id = $1 AND voided_at IS NULL', [orderId]);
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

  const discRows = await pool.query('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM discounts WHERE order_id = $1', [orderId]);
  const discountCents = Number(discRows.rows[0].s);

  const bill = computeBill({ lines, taxRateBp, svcRateBp, discountCents, method: null });

  await pool.query(
    `UPDATE orders SET subtotal_cents = $1, service_charge_cents = $2, tax_cents = $3, discount_cents = $4,
       rounding_cents = 0, total_cents = $5, tax_rate_bp = $6, svc_rate_bp = $7, updated_at = now()
     WHERE id = $8`,
    [bill.subtotal_cents, bill.service_charge_cents, bill.tax_cents, bill.discount_cents, bill.total_cents,
     taxRateBp, svcRateBp, orderId]);

  return bill;
}

async function amountDue(orderId) {
  const o = await pool.query('SELECT total_cents FROM orders WHERE id = $1', [orderId]);
  if (!o.rows[0]) throw AppError('order not found', 404);
  const paid = await pool.query('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE order_id = $1', [orderId]);
  return (o.rows[0].total_cents || 0) - Number(paid.rows[0].s);
}

async function hasPayments(orderId) {
  const r = await pool.query('SELECT 1 FROM payments WHERE order_id = $1 LIMIT 1', [orderId]);
  return r.rows.length > 0;
}

async function listPayments(orderId) {
  const r = await pool.query(
    'SELECT id, method, amount_cents, tendered_cents, taken_by, at FROM payments WHERE order_id = $1 ORDER BY at', [orderId]);
  return r.rows;
}

// One payment "leg". amountCents defaults to the full remaining balance (the common
// case: pay in full). Over-payment is rejected for every method except cash, where
// tendering more than the amount due just means change — and if this leg brings the
// order's remaining balance to zero, the 5-sen cash-rounding adjustment (kept out of
// the bill until now) is folded into this final leg and the order's stored total.
async function addPayment(orderId, { method, amountCents, tenderedCents, userId }) {
  if (!['Cash', 'Card', 'DuitNow/eWallet'].includes(method)) throw AppError('bad method', 400);

  const o = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  if (!o.rows[0]) throw AppError('order not found', 404);
  if (['paid', 'cancelled'].includes(o.rows[0].status)) throw AppError('order already closed', 400);

  const due = await amountDue(orderId);
  if (due <= 0) throw AppError('order already settled', 400);

  let apply = amountCents == null ? due : Number(amountCents);
  if (!(apply > 0)) throw AppError('amount must be positive', 400);

  let roundingAdj = 0;
  let tendered = null;

  if (method === 'Cash') {
    tendered = tenderedCents == null ? apply : Number(tenderedCents);
    if (apply >= due) {
      const rounded = roundCashCents(due);
      roundingAdj = rounded - due;
      apply = rounded;
      if (tenderedCents == null) tendered = apply;
    }
    if (tendered < apply) throw AppError('cash tendered is less than the amount', 400);
  } else if (apply > due) {
    throw AppError('amount exceeds balance due', 400);
  }

  const p = await pool.query(
    'INSERT INTO payments (order_id, method, amount_cents, tendered_cents, taken_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [orderId, method, apply, tendered, userId || null]);

  if (roundingAdj) {
    await pool.query('UPDATE orders SET rounding_cents = rounding_cents + $1, total_cents = total_cents + $1 WHERE id = $2',
      [roundingAdj, orderId]);
  }

  const remainingCents = Math.max(0, due - apply + roundingAdj);
  const settled = remainingCents === 0;
  if (settled) {
    // pay_method/pay_total_cents are legacy columns `GET /api/summary`'s dashboard
    // still sums (phase 02 kept them "for now"; phase 09 migrates reports off them).
    // A split payment has no single true method — record whichever leg closed it,
    // which is exactly right for the common (non-split) case that dashboard cares about.
    const totalRow = await pool.query('SELECT total_cents FROM orders WHERE id = $1', [orderId]);
    await pool.query(
      "UPDATE orders SET status = 'paid', paid_at = now(), paid_by = $1, pay_method = $2, pay_total_cents = $3, updated_at = now() WHERE id = $4",
      [userId || null, method, totalRow.rows[0].total_cents, orderId]);
  }

  const changeCents = tendered != null ? tendered - apply : 0;
  await writeAudit(pool, {
    userId, action: 'order.pay', entityType: 'order', entityId: orderId,
    detail: { payment_id: p.rows[0].id, method, amount_cents: apply, tendered_cents: tendered, change_cents: changeCents, settled },
  });

  return { payment_id: p.rows[0].id, amount_cents: apply, tendered_cents: tendered, change_cents: changeCents, remaining_cents: remainingCents, settled };
}

// Discounts apply to the subtotal before tax (docs/REBUILD-PLAN.md §3): tax stays
// computed on the undiscounted subtotal+service_charge; the discount only reduces
// gross. `value` is basis points for 'percent', cents for 'amount', ignored for 'comp'.
async function addDiscount(orderId, { kind, value, reason, userId }) {
  if (!['percent', 'amount', 'comp'].includes(kind)) throw AppError('bad discount kind', 400);
  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 3 || cleanReason.length > 200) throw AppError('reason must be 3-200 chars', 400);

  const o = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o.rows[0]) throw AppError('order not found', 404);
  if (['paid', 'cancelled'].includes(o.rows[0].status)) throw AppError('order closed', 400);

  const subtotalCents = o.rows[0].subtotal_cents || 0;
  const grossBeforeThisDiscount =
    subtotalCents + (o.rows[0].service_charge_cents || 0) + (o.rows[0].tax_cents || 0) - (o.rows[0].discount_cents || 0);

  let amountCents;
  if (kind === 'comp') amountCents = grossBeforeThisDiscount;
  else if (kind === 'percent') amountCents = roundHalfUp(subtotalCents * (Number(value) || 0) / 10000);
  else amountCents = Number(value) || 0;

  if (!(amountCents >= 0)) throw AppError('bad discount value', 400);
  amountCents = Math.min(amountCents, grossBeforeThisDiscount);

  const d = await pool.query(
    'INSERT INTO discounts (order_id, kind, value, amount_cents, reason, approved_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [orderId, kind, Number(value) || 0, amountCents, cleanReason, userId]);

  const bill = await recomputeOrderBill(orderId);

  await writeAudit(pool, {
    userId, action: 'discount.apply', entityType: 'order', entityId: orderId,
    detail: { discount_id: d.rows[0].id, kind, value: Number(value) || 0, amount_cents: amountCents, reason: cleanReason },
  });

  // A discount that zeroes the balance (a comp, or a partial one that happens to)
  // settles the order immediately. payments.amount_cents must be > 0, so no payment
  // row is written for the zero remainder — the discount alone closes it.
  if (bill.total_cents <= 0) {
    await pool.query("UPDATE orders SET status = 'paid', paid_at = now(), paid_by = $1, updated_at = now() WHERE id = $2",
      [userId, orderId]);
  }

  return { id: d.rows[0].id, amount_cents: amountCents, bill };
}

// Divide, floor, then hand the leftover sen one at a time to the first shares —
// never lose or invent a cent. assert(Σ shares === totalCents).
function splitEvenly(totalCents, ways) {
  const n = parseInt(ways, 10);
  if (!Number.isInteger(n) || n < 1) throw AppError('ways must be a positive integer', 400);
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  const shares = Array(n).fill(base);
  for (let i = 0; i < remainder; i++) shares[i] += 1;
  return shares;
}

async function splitBySeat(orderId) {
  const r = await pool.query(
    `SELECT oi.id, oi.seat, oi.price_cents, oi.qty, COALESCE(SUM(m.price_cents), 0) AS mods_cents
     FROM order_items oi LEFT JOIN order_item_mods m ON m.order_item_id = oi.id
     WHERE oi.order_id = $1 AND oi.voided_at IS NULL
     GROUP BY oi.id`, [orderId]);
  const bySeat = {};
  r.rows.forEach(row => {
    const seat = row.seat == null ? 'unassigned' : String(row.seat);
    bySeat[seat] = (bySeat[seat] || 0) + (row.price_cents + Number(row.mods_cents)) * row.qty;
  });
  return bySeat;
}

module.exports = {
  recomputeOrderBill, amountDue, hasPayments, listPayments, addPayment, addDiscount, splitEvenly, splitBySeat,
};
