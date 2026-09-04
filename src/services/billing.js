const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { computeBill, roundCashCents, roundHalfUp, formatRM } = require('../lib/money');
const { writeAudit } = require('./orders');

// Same math recomputeOrderBill writes, without writing — lets a caller preview
// what the bill would become (excluding a line about to be voided, or with an
// extra discount about to be applied) before committing anything.
async function computeLiveBill(orderId, { excludeItemId, extraDiscountCents = 0 } = {}) {
  const items = await pool.query(
    excludeItemId
      ? 'SELECT id, price_cents, qty FROM order_items WHERE order_id = $1 AND voided_at IS NULL AND id != $2'
      : 'SELECT id, price_cents, qty FROM order_items WHERE order_id = $1 AND voided_at IS NULL',
    excludeItemId ? [orderId, excludeItemId] : [orderId]);
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
  const discountCents = Number(discRows.rows[0].s) + extraDiscountCents;

  return { bill: computeBill({ lines, taxRateBp, svcRateBp, discountCents, method: null }), taxRateBp, svcRateBp };
}

// Rebuilds subtotal/service_charge/tax/discount/total from order_items + discounts,
// using the *current* live settings rates (this order isn't paid/finalised yet, so
// nothing here is "historical" — the snapshot-at-payment rule from phase 02 only
// bites once the order actually closes). No cash rounding is baked in here: that's
// a payment-time artifact applied only to the final settling cash leg, in
// addPayment, not a property of the bill itself.
async function recomputeOrderBill(orderId) {
  const { bill, taxRateBp, svcRateBp } = await computeLiveBill(orderId);

  await pool.query(
    `UPDATE orders SET subtotal_cents = $1, service_charge_cents = $2, tax_cents = $3, discount_cents = $4,
       rounding_cents = 0, total_cents = $5, tax_rate_bp = $6, svc_rate_bp = $7, updated_at = now()
     WHERE id = $8`,
    [bill.subtotal_cents, bill.service_charge_cents, bill.tax_cents, bill.discount_cents, bill.total_cents,
     taxRateBp, svcRateBp, orderId]);

  return bill;
}

async function paidCentsFor(orderId) {
  const r = await pool.query('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE order_id = $1', [orderId]);
  return Number(r.rows[0].s);
}

// Void and discount can each shrink an order's total below what's already been
// paid against it (a partially-paid order's status stays 'sent', so the status
// check that already protects a fully-paid order never fires) — refuse rather
// than leave the shop owing the customer a negative balance it can't settle.
function guardAgainstShortfall(actionLabel, newTotalCents, paidCents) {
  if (newTotalCents < paidCents) {
    throw AppError(
      `${actionLabel} would leave ${formatRM(paidCents)} already paid against a ${formatRM(newTotalCents)} bill — refund the payment first`,
      409);
  }
}

// If the change brought the total down to exactly what's already been paid, the
// sale is done — close it now rather than leaving what looks like an occupied
// table open all night (settling normally requires the balance to reach zero,
// which a paid amount > 0 can never do on its own).
async function settleIfMatchesPaid(orderId, totalCents, paidCents, userId, trigger) {
  if (totalCents !== paidCents) return false;
  await pool.query(
    "UPDATE orders SET status = 'paid', paid_at = now(), closed_by = $1, updated_at = now() WHERE id = $2",
    [userId || null, orderId]);
  await writeAudit(pool, {
    userId, action: 'order.settle', entityType: 'order', entityId: orderId,
    detail: { trigger, total_cents: totalCents, paid_cents: paidCents },
  });
  return true;
}

// Previews the bill with one line excluded (as if it were voided) — used to guard
// a void before committing it.
async function previewBillExcludingLine(orderId, itemId) {
  const { bill } = await computeLiveBill(orderId, { excludeItemId: itemId });
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

  // Phase 09: the drawer this cash lands in (and the shift a card/eWallet sale
  // is attributed to) must be the open one — refusing here is the control that
  // makes shift cash reconciliation trustworthy at all.
  const openShift = await pool.query('SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1');
  const shiftId = openShift.rows[0]?.id;
  if (!shiftId) throw AppError('no shift is open — open a shift before taking payment', 400);

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
    'INSERT INTO payments (order_id, method, amount_cents, tendered_cents, taken_by, shift_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [orderId, method, apply, tendered, userId || null, shiftId]);

  if (roundingAdj) {
    await pool.query('UPDATE orders SET rounding_cents = rounding_cents + $1, total_cents = total_cents + $1 WHERE id = $2',
      [roundingAdj, orderId]);
  }

  const remainingCents = Math.max(0, due - apply + roundingAdj);
  const settled = remainingCents === 0;
  if (settled) {
    await pool.query(
      "UPDATE orders SET status = 'paid', paid_at = now(), paid_by = $1, updated_at = now() WHERE id = $2",
      [userId || null, orderId]);
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

  const paidCents = await paidCentsFor(orderId);
  const { bill: preview } = await computeLiveBill(orderId, { extraDiscountCents: amountCents });
  guardAgainstShortfall('applying this discount', preview.total_cents, paidCents);

  const d = await pool.query(
    'INSERT INTO discounts (order_id, kind, value, amount_cents, reason, approved_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [orderId, kind, Number(value) || 0, amountCents, cleanReason, userId]);

  const bill = await recomputeOrderBill(orderId);

  await writeAudit(pool, {
    userId, action: 'discount.apply', entityType: 'order', entityId: orderId,
    detail: { discount_id: d.rows[0].id, kind, value: Number(value) || 0, amount_cents: amountCents, reason: cleanReason },
  });

  // A discount that brings the balance down to exactly what's already been paid
  // (0 when nothing has been paid yet — a comp, or a partial one that happens to
  // zero it — or the paid amount itself) settles the order immediately.
  // payments.amount_cents must be > 0, so a zero remainder never needs a payment
  // row — the discount alone closes it.
  await settleIfMatchesPaid(orderId, bill.total_cents, paidCents, userId, 'discount');

  return { id: d.rows[0].id, amount_cents: amountCents, bill };
}

async function listDiscounts(orderId) {
  const r = await pool.query(
    'SELECT id, kind, value, amount_cents, reason, approved_by, at FROM discounts WHERE order_id = $1 ORDER BY at', [orderId]);
  return r.rows;
}

// Reverses a discount that was applied by mistake — admin only, and only before
// any payment is recorded (removing a discount can only ever raise the total, so
// there's no shortfall risk here; the restriction is about not undoing something
// the customer was already charged against).
async function removeDiscount(orderId, discountId, { userId }) {
  const o = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  if (!o.rows[0]) throw AppError('order not found', 404);
  if (['paid', 'cancelled'].includes(o.rows[0].status)) throw AppError('order closed', 400);
  if (await hasPayments(orderId)) throw AppError('order has a payment recorded; cannot remove discount', 409);

  const d = await pool.query('DELETE FROM discounts WHERE id = $1 AND order_id = $2 RETURNING *', [discountId, orderId]);
  if (!d.rows[0]) throw AppError('discount not found', 404);

  const bill = await recomputeOrderBill(orderId);

  await writeAudit(pool, {
    userId, action: 'discount.remove', entityType: 'order', entityId: orderId,
    detail: { discount_id: d.rows[0].id, kind: d.rows[0].kind, amount_cents: d.rows[0].amount_cents, reason: d.rows[0].reason },
  });

  return { bill };
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
  recomputeOrderBill, amountDue, hasPayments, listPayments, addPayment, addDiscount, listDiscounts, removeDiscount,
  splitEvenly, splitBySeat, paidCentsFor, guardAgainstShortfall, settleIfMatchesPaid, previewBillExcludingLine,
};
