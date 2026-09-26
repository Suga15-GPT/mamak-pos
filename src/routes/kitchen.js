const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { writeAudit } = require('../services/orders');
const { publish } = require('../lib/events');
const printing = require('../services/printing');
const rounds = require('../services/rounds');
const { recomputeOrderBill } = require('../services/billing');
const { leaveGroupIfClosedTx } = require('../services/bill_groups');
const { lockBills } = require('../lib/billlock');
const { requireFeature, isOn } = require('../services/features');

const router = express.Router();

/* The kitchen and drinks displays work station tickets, not dining orders: one
   ticket is "what this station has to make for this round of this table". */

// With one station (stations switched off) every line is snapshotted to
// 'kitchen', so that is the only display there is.
async function activeStations() {
  const all = (await rounds.listStations()).filter(s => s.active);
  return (await isOn('stations')) ? all : all.filter(s => s.code === 'kitchen');
}

router.get('/api/kitchen/stations', requireRole('admin', 'staff', 'kitchen'), requireFeature('kitchen'), awaitH(async (req, res) => {
  res.json(await activeStations());
}));

router.get('/api/kitchen/tickets', requireRole('admin', 'staff', 'kitchen'), requireFeature('kitchen'), awaitH(async (req, res) => {
  const stations = (await activeStations()).map(s => s.code);
  const station = stations.includes(req.query.station) ? req.query.station : stations[0];
  if (!station) return res.json({ station: null, tickets: [] });
  // The first screen also carries every station without one of its own —
  // drinks sent before stations were switched off — so nothing still to make
  // is left where no screen shows it.
  const codes = station === stations[0]
    ? [station, ...(await rounds.listStations()).map(s => s.code).filter(c => !stations.includes(c))]
    : [station];
  const tickets = await rounds.listStationTickets(codes);
  // Recently-served is context, not work: keep the last dozen so a cook can
  // undo a mis-tap, and drop the rest.
  const served = tickets.filter(t => t.status === 'served').slice(-12);
  res.json({
    station,
    tickets: tickets.filter(t => t.status !== 'served').concat(served),
  });
}));

router.patch('/api/kitchen/tickets/:id', requireRole('admin', 'staff', 'kitchen'), requireFeature('kitchen'), awaitH(async (req, res) => {
  const r = await rounds.advanceTicket(Number(req.params.id), req.body?.status, {
    userId: req.user.id, role: req.user.role,
  });
  const o = await pool.query('SELECT table_id FROM orders WHERE id = $1', [r.order_id]);
  await writeAudit(pool, {
    userId: req.user.id, action: 'round.status', entityType: 'order_send_ticket', entityId: Number(req.params.id),
    detail: { order_id: r.order_id, send_id: r.send_id, from: r.from, to: r.to },
  });
  publish('order.updated', { order_id: r.order_id, table_id: o.rows[0]?.table_id || null });
  res.json({ ok: true, ...r });
}));

/* ===== QR approval queue =====
   Only reachable when an admin has turned on "Require staff approval"; with the
   default "Send directly to kitchen" this list is simply always empty. */

router.get('/api/kitchen/pending', requireRole('admin', 'staff'), requireFeature('qr'), awaitH(async (req, res) => {
  res.json(await rounds.listPendingSends());
}));

const NOT_OPEN = 'This order is no longer open, so there is nothing to approve or reject.';

/* Locks the order, then the round, and checks both are still decidable. A
   round on a closed order is refused (409) rather than recomputing a bill
   that has already been settled or written off. */
async function lockDecidable(client, sendId) {
  // Approving or rejecting changes a bill's total: bill lock first.
  await lockBills(client);
  const s0 = (await client.query('SELECT order_id FROM order_sends WHERE id = $1', [sendId])).rows[0];
  if (!s0) throw Object.assign(new Error('round not found'), { status: 404 });
  const o = (await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [s0.order_id])).rows[0];
  const s = (await client.query('SELECT * FROM order_sends WHERE id = $1 FOR UPDATE', [sendId])).rows[0];
  if (rounds.TERMINAL_ORDER_STATUSES.includes(o.status)) throw Object.assign(new Error(NOT_OPEN), { status: 409 });
  if (s.approval_state !== 'pending') throw Object.assign(new Error(`round is already ${s.approval_state}`), { status: 400 });
  return s;
}

router.post('/api/kitchen/sends/:id/approve', requireRole('admin', 'staff'), requireFeature('qr'), awaitH(async (req, res) => {
  let s;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    s = await lockDecidable(client, req.params.id);
    await client.query(
      "UPDATE order_sends SET approval_state = 'approved', decided_at = now(), decided_by = $1 WHERE id = $2",
      [req.user.id, s.id]);
    const stationRows = (await client.query(
      'SELECT DISTINCT station_code FROM order_items WHERE send_id = $1', [s.id])).rows;
    await rounds.openTickets(client, s.id, stationRows.map(x => x.station_code));
    await rounds.deriveOrderStatus(client, s.order_id);
    // The accepted lines join the bill in the same transaction, so no payment
    // can be taken against the total from before they counted.
    await recomputeOrderBill(s.order_id, client);
    await writeAudit(client, {
      userId: req.user.id, action: 'round.approve', entityType: 'order_send', entityId: s.id,
      detail: { order_id: s.order_id, round: s.seq_no, source: s.source },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  await printing.enqueueRoundChits(s.id);
  const o = await pool.query('SELECT table_id FROM orders WHERE id = $1', [s.order_id]);
  publish('order.updated', { order_id: s.order_id, table_id: o.rows[0]?.table_id || null });
  res.json({ ok: true });
}));

/* Rejecting voids the round's lines rather than deleting them: the customer
   did ask for these, and a bill that silently loses lines is unauditable. */
router.post('/api/kitchen/sends/:id/reject', requireRole('admin', 'staff'), requireFeature('qr'), awaitH(async (req, res) => {
  const reason = String(req.body?.reason || '').trim() || 'rejected by staff';
  let s;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    s = await lockDecidable(client, req.params.id);
    await client.query(
      "UPDATE order_sends SET approval_state = 'rejected', decided_at = now(), decided_by = $1 WHERE id = $2",
      [req.user.id, s.id]);
    await client.query(
      'UPDATE order_items SET voided_at = now(), voided_by = $1, void_reason = $2 WHERE send_id = $3 AND voided_at IS NULL',
      [req.user.id, reason.slice(0, 200), s.id]);
    await writeAudit(client, {
      userId: req.user.id, action: 'round.reject', entityType: 'order_send', entityId: s.id,
      detail: { order_id: s.order_id, round: s.seq_no, reason },
    });
    await recomputeOrderBill(s.order_id, client);

    // If rejecting emptied the bill entirely — a customer's first and only round
    // turned away — the order is over. Leaving it open would hold the card
    // hostage to a zero-value bill nobody can pay or void.
    const remaining = await client.query(
      'SELECT count(*)::int n FROM order_items WHERE order_id = $1 AND voided_at IS NULL', [s.order_id]);
    if (remaining.rows[0].n === 0) {
      await client.query(
        "UPDATE orders SET status = 'cancelled', closed_by = $1, updated_at = now() WHERE id = $2",
        [req.user.id, s.order_id]);
      // An earlier round whose lines were all voided can still have a ticket
      // on the board: it goes with the bill, like any cancel.
      await rounds.cancelOpenTickets(client, s.order_id);
      await writeAudit(client, {
        userId: req.user.id, action: 'order.cancel', entityType: 'order', entityId: s.order_id,
        detail: { reason: 'every item on this order was rejected' },
      });
      // A cancelled card leaves its combined bill (and a group of one dissolves).
      await leaveGroupIfClosedTx(client, s.order_id, req.user.id, 'every item rejected');
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  const o = await pool.query('SELECT table_id FROM orders WHERE id = $1', [s.order_id]);
  publish('order.updated', { order_id: s.order_id, table_id: o.rows[0]?.table_id || null });
  res.json({ ok: true });
}));

module.exports = router;
