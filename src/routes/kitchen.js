const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { writeAudit } = require('../services/orders');
const { publish } = require('../lib/events');
const printing = require('../services/printing');
const rounds = require('../services/rounds');
const { recomputeOrderBill } = require('../services/billing');

const router = express.Router();

/* The kitchen and drinks displays work station tickets, not dining orders: one
   ticket is "what this station has to make for this round of this table". */

router.get('/api/kitchen/stations', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  res.json((await rounds.listStations()).filter(s => s.active));
}));

router.get('/api/kitchen/tickets', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const stations = (await rounds.listStations()).filter(s => s.active).map(s => s.code);
  const station = stations.includes(req.query.station) ? req.query.station : stations[0];
  if (!station) return res.json({ station: null, tickets: [] });
  const tickets = await rounds.listStationTickets(station);
  // Recently-served is context, not work: keep the last dozen so a cook can
  // undo a mis-tap, and drop the rest.
  const served = tickets.filter(t => t.status === 'served').slice(-12);
  res.json({
    station,
    tickets: tickets.filter(t => t.status !== 'served').concat(served),
  });
}));

router.patch('/api/kitchen/tickets/:id', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
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

router.get('/api/kitchen/pending', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  res.json(await rounds.listPendingSends());
}));

router.post('/api/kitchen/sends/:id/approve', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const s = (await pool.query('SELECT * FROM order_sends WHERE id = $1', [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: 'round not found' });
  if (s.approval_state !== 'pending') return res.status(400).json({ error: `round is already ${s.approval_state}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE order_sends SET approval_state = 'approved', decided_at = now(), decided_by = $1 WHERE id = $2",
      [req.user.id, s.id]);
    const stationRows = (await client.query(
      'SELECT DISTINCT station_code FROM order_items WHERE send_id = $1', [s.id])).rows;
    await rounds.openTickets(client, s.id, stationRows.map(x => x.station_code));
    await rounds.deriveOrderStatus(client, s.order_id);
    await writeAudit(client, {
      userId: req.user.id, action: 'round.approve', entityType: 'order_send', entityId: s.id,
      detail: { order_id: s.order_id, round: s.seq_no, source: s.source },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  await recomputeOrderBill(s.order_id);
  await printing.enqueueRoundChits(s.id);
  const o = await pool.query('SELECT table_id FROM orders WHERE id = $1', [s.order_id]);
  publish('order.updated', { order_id: s.order_id, table_id: o.rows[0]?.table_id || null });
  res.json({ ok: true });
}));

/* Rejecting voids the round's lines rather than deleting them: the customer
   did ask for these, and a bill that silently loses lines is unauditable. */
router.post('/api/kitchen/sends/:id/reject', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const reason = String(req.body?.reason || '').trim() || 'rejected by staff';
  const s = (await pool.query('SELECT * FROM order_sends WHERE id = $1', [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: 'round not found' });
  if (s.approval_state !== 'pending') return res.status(400).json({ error: `round is already ${s.approval_state}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  await recomputeOrderBill(s.order_id);

  // If rejecting emptied the bill entirely — a customer's first and only round
  // turned away — the order is over. Leaving it open would hold the table
  // hostage to a zero-value bill nobody can pay or void.
  const remaining = await pool.query(
    'SELECT count(*)::int n FROM order_items WHERE order_id = $1 AND voided_at IS NULL', [s.order_id]);
  if (remaining.rows[0].n === 0) {
    await pool.query(
      "UPDATE orders SET status = 'cancelled', closed_by = $1, updated_at = now() WHERE id = $2 AND status NOT IN ('paid','cancelled','refunded')",
      [req.user.id, s.order_id]);
    await writeAudit(pool, {
      userId: req.user.id, action: 'order.cancel', entityType: 'order', entityId: s.order_id,
      detail: { reason: 'every item on this order was rejected' },
    });
  }

  const o = await pool.query('SELECT table_id FROM orders WHERE id = $1', [s.order_id]);
  publish('order.updated', { order_id: s.order_id, table_id: o.rows[0]?.table_id || null });
  res.json({ ok: true });
}));

module.exports = router;
