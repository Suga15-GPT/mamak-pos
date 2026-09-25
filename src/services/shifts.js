const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { writeAudit } = require('./orders');
const { lockBills } = require('../lib/billlock');
const features = require('./features');

// The single currently-open shift, or null. The `one_open_shift` partial
// unique index (migration 008) is what actually enforces there's ever at
// most one — this is just a read of that invariant.
async function current() {
  const r = await pool.query('SELECT * FROM shifts WHERE closed_at IS NULL LIMIT 1');
  return r.rows[0] || null;
}

/* Under the bill lock, with the shifts switch re-read under it: switching
   shifts off takes the same lock and is refused while a shift is open, so a
   shift can't open in the instant after that check and leave shifts off with
   a drawer nobody's cash reaches (features.js guardTurnOff). */
async function open({ userId, floatCents }) {
  if (!(Number.isInteger(floatCents) && floatCents >= 0)) throw AppError('float must be a non-negative amount', 400);
  const client = await pool.connect();
  let shift;
  try {
    await client.query('BEGIN');
    await lockBills(client);
    await features.requireOnTx(client, 'shifts');
    try {
      shift = (await client.query('INSERT INTO shifts (opened_by, float_cents) VALUES ($1,$2) RETURNING *', [userId, floatCents])).rows[0];
    } catch (e) {
      if (e.code === '23505') throw AppError('a shift is already open', 409);
      throw e;
    }
    await writeAudit(client, { userId, action: 'shift.open', entityType: 'shift', entityId: shift.id, detail: { float_cents: floatCents } });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return shift;
}

// Petty cash in/out against the open shift's drawer.
async function addMovement({ kind, amountCents, reason, userId }) {
  if (!['payin', 'payout'].includes(kind)) throw AppError('bad movement kind', 400);
  if (!(Number.isInteger(amountCents) && amountCents > 0)) throw AppError('amount must be a positive amount', 400);
  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 3 || cleanReason.length > 200) throw AppError('reason must be 3-200 chars', 400);

  // Under the bill lock, like close: a movement can't land in a shift whose
  // expected cash has just been frozen without it.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockBills(client);
    const shift = (await client.query('SELECT * FROM shifts WHERE closed_at IS NULL LIMIT 1 FOR UPDATE')).rows[0];
    if (!shift) throw AppError('no shift is open', 400);
    const r = await client.query(
      'INSERT INTO cash_movements (shift_id, kind, amount_cents, reason, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [shift.id, kind, amountCents, cleanReason, userId]);
    await writeAudit(client, {
      userId, action: `shift.${kind}`, entityType: 'shift', entityId: shift.id,
      detail: { amount_cents: amountCents, reason: cleanReason },
    });
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// float + cash sales taken during this shift + payins - payouts - cash refunds
// given during this shift. Card/eWallet sales and refunds never touch the
// physical drawer, so they're excluded.
async function expectedCashCents(shiftId, floatCents, client = pool) {
  const cash = await client.query(
    "SELECT COALESCE(SUM(amount_cents), 0) s FROM payments WHERE shift_id = $1 AND method = 'Cash'", [shiftId]);
  const movements = await client.query(
    'SELECT kind, COALESCE(SUM(amount_cents), 0) s FROM cash_movements WHERE shift_id = $1 GROUP BY kind', [shiftId]);
  let payins = 0, payouts = 0;
  movements.rows.forEach(m => { if (m.kind === 'payin') payins = Number(m.s); else payouts = Number(m.s); });
  const cashRefunds = await client.query(
    `SELECT COALESCE(SUM(r.amount_cents), 0) s FROM refunds r JOIN payments p ON p.id = r.payment_id
     WHERE r.shift_id = $1 AND p.method = 'Cash'`, [shiftId]);
  return floatCents + Number(cash.rows[0].s) + payins - payouts - Number(cashRefunds.rows[0].s);
}

// Closes the open shift, freezing counted/expected/variance onto the row —
// never recomputed again on read, so a later order can't change a past Z report.
async function close({ userId, countedCents, note }) {
  if (!(Number.isInteger(countedCents) && countedCents >= 0)) throw AppError('counted amount must be a non-negative amount', 400);
  // Under the bill lock: every payment, refund and movement takes it too, so
  // none can commit into this shift after its expected cash is computed and
  // before it is frozen (re-check 2, S1).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockBills(client);
    const shift = (await client.query('SELECT * FROM shifts WHERE closed_at IS NULL LIMIT 1 FOR UPDATE')).rows[0];
    if (!shift) throw AppError('no shift is open', 400);
    const expected = await expectedCashCents(shift.id, shift.float_cents, client);
    const variance = countedCents - expected;
    const cleanNote = String(note || '').trim();
    if (variance !== 0 && !cleanNote) throw AppError('a note is required when variance is non-zero', 400);

    // Snapshot "open orders carried forward" right now, same reasoning as
    // expected/counted/variance above — one of those orders settling in a later
    // shift must never change what this shift's own Z report already said.
    const carried = await client.query(
      `SELECT COUNT(*)::int n, COALESCE(SUM(total_cents), 0)::int cents
       FROM orders WHERE shift_id = $1 AND status NOT IN ('paid', 'cancelled', 'refunded')`, [shift.id]);

    const r = await client.query(
      `UPDATE shifts SET closed_at = now(), closed_by = $1, counted_cents = $2, expected_cents = $3,
         variance_cents = $4, note = $5, carried_forward_count = $6, carried_forward_cents = $7 WHERE id = $8 RETURNING *`,
      [userId, countedCents, expected, variance, cleanNote || null, carried.rows[0].n, carried.rows[0].cents, shift.id]);
    await writeAudit(client, {
      userId, action: 'shift.close', entityType: 'shift', entityId: shift.id,
      detail: { counted_cents: countedCents, expected_cents: expected, variance_cents: variance },
    });
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// X (interim, final=false) or Z (final=true, written once at close) report.
// Sales-side figures (gross/net/voids/categories/top items/average check) are
// scoped by orders.closed_shift_id — the shift the order *settled* in (phase
// 12) — matching cash reconciliation and payment mix, which were already
// scoped by payments.shift_id, the shift that actually took the money. Before
// phase 12 the sales side read orders.shift_id (opened-in) instead, which for
// an order spanning a shift change put its sales in one Z report and its cash
// in the next — this is what made the two sides agree by construction.
// orders.shift_id (opened-in) still drives "open orders carried forward"
// below — the one place this report still needs to know where an order
// started rather than where it ended. A closed shift's cash figures are read
// back from the frozen row (see close()) rather than recomputed.
async function report(shiftId, { final = false } = {}) {
  const shiftRow = await pool.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
  const shift = shiftRow.rows[0];
  if (!shift) throw AppError('shift not found', 404);

  // 'refunded' counts here too — the sale happened and belongs in gross/net;
  // the money given back is its own line below, not a silent exclusion.
  const orders = await pool.query(
    `SELECT id, subtotal_cents, service_charge_cents, tax_cents, rounding_cents, total_cents
     FROM orders WHERE closed_shift_id = $1 AND status IN ('paid', 'refunded')`, [shiftId]);
  const orderIds = orders.rows.map(o => o.id);

  // An order opened in this shift but not yet settled by anyone belongs to no
  // shift's sales yet — visible here rather than mysteriously absent. Once the
  // shift is closed this is read back from the frozen snapshot (see close()),
  // not recomputed — one of those orders settling later must never change
  // this shift's own report.
  const carried = shift.closed_at
    ? { rows: [{ n: shift.carried_forward_count || 0, cents: shift.carried_forward_cents || 0 }] }
    : await pool.query(
        `SELECT COUNT(*)::int n, COALESCE(SUM(total_cents), 0)::int cents
         FROM orders WHERE shift_id = $1 AND status NOT IN ('paid', 'cancelled', 'refunded')`, [shiftId]);

  const gross_cents = orders.rows.reduce((s, o) => s + (o.subtotal_cents || 0), 0);
  const service_charge_cents = orders.rows.reduce((s, o) => s + (o.service_charge_cents || 0), 0);
  const tax_cents = orders.rows.reduce((s, o) => s + (o.tax_cents || 0), 0);
  const rounding_cents = orders.rows.reduce((s, o) => s + (o.rounding_cents || 0), 0);
  const net_sales_cents = orders.rows.reduce((s, o) => s + (o.total_cents || 0), 0);
  const order_count = orders.rows.length;
  const avg_check_cents = order_count ? Math.round(net_sales_cents / order_count) : 0;

  const discRows = orderIds.length
    ? await pool.query('SELECT kind, COALESCE(SUM(amount_cents), 0) s FROM discounts WHERE order_id = ANY($1::int[]) GROUP BY kind', [orderIds])
    : { rows: [] };
  let discounts_cents = 0, comps_cents = 0;
  discRows.rows.forEach(r => { if (r.kind === 'comp') comps_cents = Number(r.s); else discounts_cents += Number(r.s); });

  const voidRows = orderIds.length
    ? await pool.query(
        `SELECT oi.id, oi.price_cents, oi.qty, COALESCE(SUM(m.price_cents), 0) mods_cents
         FROM order_items oi LEFT JOIN order_item_mods m ON m.order_item_id = oi.id
         WHERE oi.order_id = ANY($1::int[]) AND oi.voided_at IS NOT NULL
         GROUP BY oi.id`, [orderIds])
    : { rows: [] };
  const voids_count = voidRows.rows.length;
  const voids_cents = voidRows.rows.reduce((s, r) => s + (r.price_cents + Number(r.mods_cents)) * r.qty, 0);

  const paymentMix = await pool.query(
    'SELECT method, COALESCE(SUM(amount_cents), 0) s FROM payments WHERE shift_id = $1 GROUP BY method', [shiftId]);

  const categoryRows = orderIds.length
    ? await pool.query(
        `SELECT COALESCE(c.name, 'Uncategorised') category, SUM(oi.price_cents * oi.qty)::int cents
         FROM order_items oi LEFT JOIN items i ON i.id = oi.item_id LEFT JOIN categories c ON c.id = i.category_id
         WHERE oi.order_id = ANY($1::int[]) AND oi.voided_at IS NULL
         GROUP BY c.name ORDER BY cents DESC`, [orderIds])
    : { rows: [] };

  const topItems = orderIds.length
    ? await pool.query(
        `SELECT name, SUM(qty)::int sold FROM order_items
         WHERE order_id = ANY($1::int[]) AND voided_at IS NULL GROUP BY name ORDER BY sold DESC LIMIT 10`, [orderIds])
    : { rows: [] };

  const staffSales = await pool.query(
    `SELECT COALESCE(u.name, 'Unknown') staff, COALESCE(SUM(p.amount_cents), 0)::int cents
     FROM payments p LEFT JOIN users u ON u.id = p.taken_by
     WHERE p.shift_id = $1 GROUP BY u.name ORDER BY cents DESC`, [shiftId]);

  const staffVoids = orderIds.length
    ? await pool.query(
        `SELECT COALESCE(u.name, 'Unknown') staff, COUNT(*)::int n, COALESCE(SUM(oi.price_cents * oi.qty), 0)::int cents
         FROM order_items oi LEFT JOIN users u ON u.id = oi.voided_by
         WHERE oi.order_id = ANY($1::int[]) AND oi.voided_at IS NOT NULL
         GROUP BY u.name ORDER BY cents DESC`, [orderIds])
    : { rows: [] };

  // Refunds are scoped by refunds.shift_id — the shift that actually gave the
  // money back, same reasoning as payment_mix/cash above — not by the order's
  // closed_shift_id, which can be an earlier shift than the one issuing the refund.
  const refundMix = await pool.query(
    `SELECT p.method, COALESCE(SUM(r.amount_cents), 0) s FROM refunds r JOIN payments p ON p.id = r.payment_id
     WHERE r.shift_id = $1 GROUP BY p.method`, [shiftId]);
  const refunds_cents = refundMix.rows.reduce((s, r) => s + Number(r.s), 0);

  const staffRefunds = await pool.query(
    `SELECT COALESCE(u.name, 'Unknown') staff, COUNT(*)::int n, COALESCE(SUM(r.amount_cents), 0)::int cents
     FROM refunds r LEFT JOIN users u ON u.id = r.approved_by
     WHERE r.shift_id = $1 GROUP BY u.name ORDER BY cents DESC`, [shiftId]);

  let cash;
  if (shift.closed_at) {
    cash = { float_cents: shift.float_cents, expected_cents: shift.expected_cents, counted_cents: shift.counted_cents, variance_cents: shift.variance_cents };
  } else {
    cash = { float_cents: shift.float_cents, expected_cents: await expectedCashCents(shiftId, shift.float_cents), counted_cents: null, variance_cents: null };
  }
  const movementRows = await pool.query(
    'SELECT kind, COALESCE(SUM(amount_cents), 0) s FROM cash_movements WHERE shift_id = $1 GROUP BY kind', [shiftId]);
  let payins = 0, payouts = 0;
  movementRows.rows.forEach(m => { if (m.kind === 'payin') payins = Number(m.s); else payouts = Number(m.s); });
  const cashMixRow = paymentMix.rows.find(r => r.method === 'Cash');
  cash.cash_sales_cents = cashMixRow ? Number(cashMixRow.s) : 0;
  cash.payins_cents = payins;
  cash.payouts_cents = payouts;

  const settingsRows = (await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('restaurant_name', 'restaurant_address', 'sst_number')")).rows;
  const restaurant = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

  return {
    shift_id: shift.id, final: !!final, opened_at: shift.opened_at, closed_at: shift.closed_at, restaurant,
    gross_cents, discounts_cents, comps_cents, voids_count, voids_cents,
    net_sales_cents, service_charge_cents, tax_cents, rounding_cents,
    payment_mix: paymentMix.rows.map(r => ({ method: r.method, cents: Number(r.s) })),
    order_count, avg_check_cents,
    categories: categoryRows.rows.map(r => ({ category: r.category, cents: Number(r.cents) })),
    top_items: topItems.rows,
    cash,
    refunds_cents,
    refund_mix: refundMix.rows.map(r => ({ method: r.method, cents: Number(r.s) })),
    carried_forward: { count: carried.rows[0].n, cents: carried.rows[0].cents },
    staff_sales: staffSales.rows.map(r => ({ staff: r.staff, cents: Number(r.cents) })),
    staff_voids: staffVoids.rows.map(r => ({ staff: r.staff, count: r.n, cents: Number(r.cents) })),
    staff_refunds: staffRefunds.rows.map(r => ({ staff: r.staff, count: r.n, cents: Number(r.cents) })),
  };
}

module.exports = { current, open, addMovement, close, report, expectedCashCents };
