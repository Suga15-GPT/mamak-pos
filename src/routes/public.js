const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { publicH } = require('../lib/errors');
const { cents2rm } = require('../lib/money');
const { rateLimit } = require('../lib/auth');
const { buildOrderItems, insertOrder, appendSend, ORDERABLE_SQL } = require('../services/orders');
const { recomputeOrderBill, hasPayments } = require('../services/billing');
const { publish } = require('../lib/events');
const printing = require('../services/printing');

const router = express.Router();

const PAUSED_MESSAGE = 'Online ordering is temporarily paused. Please order with our staff.';

async function qrSettings() {
  const r = await pool.query("SELECT key, value FROM settings WHERE key IN ('qr_ordering_enabled','qr_require_approval')");
  const v = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
  return {
    // Absent means "not configured yet", and the shipped default is on — a QR
    // that silently does nothing is worse than one that works.
    enabled: v.qr_ordering_enabled !== '0',
    approval_required: v.qr_require_approval === '1',
  };
}

router.get('/api/menu', publicH(async (req, res) => {
  const cats = await pool.query('SELECT id, name FROM categories ORDER BY sort, id');
  const items = await pool.query(
    `SELECT id, category_id, name, price_cents, kandar, station_code FROM items WHERE ${ORDERABLE_SQL} ORDER BY sort, id`);
  const groups = await pool.query('SELECT id, name, mode, min_select, max_select FROM modifier_groups ORDER BY sort, id');
  const opts = await pool.query('SELECT id, group_id, name, price_cents FROM modifier_options WHERE available = true ORDER BY sort, id');
  const itemIds = items.rows.map(i => i.id);
  const attach = itemIds.length
    ? await pool.query('SELECT item_id, group_id FROM item_modifier_groups WHERE item_id = ANY($1::int[]) ORDER BY sort, group_id', [itemIds])
    : { rows: [] };
  const groupIdsByItem = {};
  attach.rows.forEach(a => { (groupIdsByItem[a.item_id] ||= []).push(a.group_id); });

  // Station names are not sensitive and the till shows them on an item button
  // ("Drinks"), so they ride along rather than needing a second request.
  const stations = await pool.query('SELECT code, name, sort FROM prep_stations WHERE active ORDER BY sort, code');

  res.json({
    categories: cats.rows,
    items: items.rows.map(i => ({ ...i, price: cents2rm(i.price_cents), modifier_group_ids: groupIdsByItem[i.id] || [] })),
    modifier_groups: groups.rows,
    modifier_options: opts.rows.map(o => ({ ...o, price: cents2rm(o.price_cents) })),
    stations: stations.rows,
  });
}));

/* What a scanned QR resolves to. Also carries the ordering switches so the
   customer page can show the "paused" message instead of a menu it cannot
   submit, and says whether this table already has a bill running so the page
   can say "adding to your table" rather than "new order". */
router.get('/api/t/:token', publicH(async (req, res) => {
  const r = await pool.query('SELECT id, name FROM tables WHERE qr_token = $1 AND active', [req.params.token]);
  if (!r.rows[0]) return res.status(404).json({ error: 'unknown table QR' });
  const ordering = await qrSettings();
  const open = await pool.query(
    "SELECT id FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled','refunded') LIMIT 1", [r.rows[0].id]);
  res.json({
    table: r.rows[0],
    ordering,
    paused_message: ordering.enabled ? null : PAUSED_MESSAGE,
    has_open_order: !!open.rows[0],
  });
}));

/* Customer QR order (public, rate-limited).

   A second scan at the same table appends a NEW kitchen round to the bill the
   table already has — the old behaviour, 409 "ask a staff member", was the
   single biggest reason QR ordering went unused. Nothing here touches an
   authenticated route: the table's own qr_token is the entire identity, and the
   response never carries an order id, only an opaque round reference the
   customer can poll for their own food. */
router.post('/api/public/orders', publicH(async (req, res) => {
  const ordering = await qrSettings();
  if (!ordering.enabled) return res.status(503).json({ error: 'ordering_paused', message: PAUSED_MESSAGE });

  if (!rateLimit(req.ip, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many orders, please ask staff' });
  const { table_token, items, note } = req.body || {};
  // Per-IP alone under-protects a busy table: one phone hotspot is one IP for
  // a whole group of diners, so also cap by the table itself.
  if (!rateLimit('table:' + table_token, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many orders, please ask staff' });

  const t = await pool.query('SELECT id FROM tables WHERE qr_token = $1 AND active', [table_token]);
  if (!t.rows[0]) return res.status(400).json({ error: 'invalid table' });
  const tableId = t.rows[0].id;

  const parsed = await buildOrderItems(pool, items);
  const approvalState = ordering.approval_required ? 'pending' : 'approved';
  const publicRef = crypto.randomBytes(12).toString('hex');

  const open = await pool.query(
    "SELECT id FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled','refunded') ORDER BY id DESC LIMIT 1",
    [tableId]);

  let orderId, sendId, seqNo;
  if (open.rows[0]) {
    // The bill is mid-settlement: adding to it would make what was just paid
    // for wrong. Staff have to take over from here.
    if (await hasPayments(open.rows[0].id)) {
      return res.status(409).json({ error: 'bill_being_paid', message: 'Your bill is being settled. Please order with our staff.' });
    }
    orderId = open.rows[0].id;
    ({ sendId, seqNo } = await appendSend(orderId, parsed, 'qr', null, null, { approvalState, publicRef }));
  } else {
    try {
      ({ orderId, sendId, seqNo } = await insertOrder(
        tableId, parsed, String(note || '').slice(0, 300), 'qr', null, null, { approvalState, publicRef }));
    } catch (e) {
      // Two phones at the same table submitting their first order at the same
      // instant: one of them loses the one_open_order_per_table race. Append to
      // the winner instead of failing the customer (phase 03 could only 409).
      if (e.code === '23505' && e.constraint === 'one_open_order_per_table') {
        const winner = await pool.query(
          "SELECT id FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled','refunded') ORDER BY id DESC LIMIT 1",
          [tableId]);
        if (!winner.rows[0]) throw e;
        orderId = winner.rows[0].id;
        ({ sendId, seqNo } = await appendSend(orderId, parsed, 'qr', null, null, { approvalState, publicRef }));
      } else throw e;
    }
  }

  await recomputeOrderBill(orderId);
  publish(open.rows[0] ? 'order.updated' : 'order.created', { order_id: orderId, table_id: tableId });
  // A round awaiting staff approval reaches no printer and no station display
  // until someone accepts it.
  if (approvalState === 'approved') await printing.enqueueRoundChits(sendId);

  res.status(201).json({
    ref: publicRef,
    round: seqNo,
    status: approvalState === 'pending' ? 'pending' : 'sent',
  });
}));

/* A customer following their own round. `ref` is an opaque per-round token
   handed out at submit time — never an order id, and it exposes only what that
   customer already knows they ordered. */
router.get('/api/public/sends/:ref', publicH(async (req, res) => {
  if (!rateLimit('sendref:' + req.ip, 240, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many requests' });
  const s = await pool.query(
    `SELECT s.id, s.seq_no, s.sent_at, s.approval_state, t.name AS table_name
       FROM order_sends s
       JOIN orders o ON o.id = s.order_id
       LEFT JOIN tables t ON t.id = o.table_id
      WHERE s.public_ref = $1`, [req.params.ref]);
  if (!s.rows[0]) return res.status(404).json({ error: 'not found' });
  const send = s.rows[0];

  const items = (await pool.query(
    'SELECT name, qty, voided_at FROM order_items WHERE send_id = $1 ORDER BY id', [send.id])).rows;

  let status = 'pending';
  if (send.approval_state === 'rejected') status = 'rejected';
  else if (send.approval_state === 'approved') {
    const ts = (await pool.query('SELECT status FROM order_send_tickets WHERE send_id = $1', [send.id])).rows.map(r => r.status);
    // Same operational priority the floor sees: the slowest station is what the
    // customer is actually still waiting on.
    status = ['sent', 'preparing', 'ready', 'served'].find(st => ts.includes(st)) || 'sent';
  }

  res.json({
    round: send.seq_no, table: send.table_name, sent_at: send.sent_at, status,
    items: items.filter(i => !i.voided_at).map(i => ({ name: i.name, qty: i.qty })),
  });
}));

module.exports = router;
