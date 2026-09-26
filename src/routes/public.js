const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { publicH } = require('../lib/errors');
const { cents2rm } = require('../lib/money');
const { rateLimit } = require('../lib/auth');
const { buildOrderItems, insertOrder, appendSend, ORDERABLE_SQL } = require('../services/orders');
const { hasPayments } = require('../services/billing');
const { publish } = require('../lib/events');
const printing = require('../services/printing');
const voice = require('../services/voice');
const { qrSettings, resolveQr, locationSql } = require('../services/cards');
const { requireFeature, isOn } = require('../services/features');

const router = express.Router();


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

/* What a scanned QR resolves to (card mode, migration 014). per_card: the
   token is one card's own, and the page says whether that card already has a
   bill running ("adding to your order" rather than "new order"). shop: the one
   poster token; the page must ask for a card number first, and passes it back
   as ?card=N to check it before showing the menu. off: 404, and the page says
   "Please order at the counter". */
router.get('/api/t/:token', requireFeature('qr'), publicH(async (req, res) => {
  const { settings, card } = await resolveQr(req.params.token, req.query.card, { requireCard: false });
  const open = card ? await pool.query(
    "SELECT id FROM orders WHERE card_id = $1 AND status NOT IN ('paid','cancelled','refunded') LIMIT 1", [card.id]) : { rows: [] };
  res.json({
    mode: settings.mode,
    card: card ? { number: card.number } : null,
    needs_card_number: !card,
    ordering: { enabled: settings.enabled, approval_required: settings.approval_required },
    has_open_order: !!open.rows[0],
    // A half-configured deployment shows the menu and no microphone, rather
    // than a Speak to Order button that fails when somebody taps it.
    voice: { enabled: voice.isEnabled() && (await isOn('voice')) },
  });
}));

/* Customer QR order (public, rate-limited).

   A second scan on the same card appends a NEW kitchen round to the bill the
   card already has; a free card opens one. Nothing here touches an
   authenticated route: the card's own qr_token (or, in shop mode, the shop
   token plus the card number typed in) is the entire identity, and the
   response never carries an order id, only an opaque round reference the
   customer can poll for their own food. */
router.post('/api/public/orders', requireFeature('qr'), publicH(async (req, res) => {
  const { table_token, card_number, items, note } = req.body || {};
  const { settings: ordering, card } = await resolveQr(table_token, card_number);

  if (!rateLimit(req.ip, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many orders, please ask staff' });
  // Per-IP alone under-protects a busy card: one phone hotspot is one IP for
  // a whole group of diners, so also cap by the card itself (in shop mode the
  // token is shared by every customer, so the card is the only fair key).
  if (!rateLimit('card:' + card.id, 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many orders, please ask staff' });
  const cardId = card.id;

  const parsed = await buildOrderItems(pool, items);
  const approvalState = ordering.approval_required ? 'pending' : 'approved';
  const publicRef = crypto.randomBytes(12).toString('hex');

  const open = await pool.query(
    "SELECT id, bill_group_id FROM orders WHERE card_id = $1 AND status NOT IN ('paid','cancelled','refunded') ORDER BY id DESC LIMIT 1",
    [cardId]);

  let orderId, sendId, seqNo;
  if (open.rows[0]) {
    // The bill is mid-settlement: adding to it would make what was just paid
    // for wrong. Staff have to take over from here.
    if (await hasPayments(open.rows[0].id)) {
      return res.status(409).json({ error: 'bill_being_paid', message: 'Your bill is being settled. Please order with our staff.' });
    }
    orderId = open.rows[0].id;
    try {
      ({ sendId, seqNo } = await appendSend(orderId, parsed, 'qr', null, null, { approvalState, publicRef }));
    } catch (e) {
      // Settled or closed in the instant between looking the bill up and
      // locking it: the same answer as the check above.
      if (e.code === 'has_payment' || e.code === 'order_closed') {
        return res.status(409).json({ error: 'bill_being_paid', message: 'Your bill is being settled. Please order with our staff.' });
      }
      throw e;
    }
  } else {
    try {
      ({ orderId, sendId, seqNo } = await insertOrder(
        cardId, parsed, String(note || '').slice(0, 300), 'qr', null, null, { approvalState, publicRef }));
    } catch (e) {
      // Two phones on the same card submitting their first order at the same
      // instant: one of them loses the one_open_order_per_card race. Append to
      // the winner instead of failing the customer.
      if (e.code === '23505' && e.constraint === 'one_open_order_per_card') {
        const winner = await pool.query(
          "SELECT id FROM orders WHERE card_id = $1 AND status NOT IN ('paid','cancelled','refunded') ORDER BY id DESC LIMIT 1",
          [cardId]);
        if (!winner.rows[0]) throw e;
        orderId = winner.rows[0].id;
        ({ sendId, seqNo } = await appendSend(orderId, parsed, 'qr', null, null, { approvalState, publicRef }));
      } else throw e;
    }
  }

  publish(open.rows[0] ? 'order.updated' : 'order.created', { order_id: orderId, card_id: cardId });
  // A round awaiting staff approval reaches no printer and no station display
  // until someone accepts it.
  if (approvalState === 'approved') await printing.enqueueRoundChits(sendId);

  res.status(201).json({
    ref: publicRef,
    round: seqNo,
    card: card.number,
    status: approvalState === 'pending' ? 'pending' : 'sent',
  });
}));

/* A customer following their own round. `ref` is an opaque per-round token
   handed out at submit time — never an order id, and it exposes only what that
   customer already knows they ordered. */
router.get('/api/public/sends/:ref', requireFeature('qr'), publicH(async (req, res) => {
  if (!(await qrSettings()).enabled) return res.status(404).json({ error: 'Please order at the counter' });
  if (!rateLimit('sendref:' + req.ip, 240, 10 * 60 * 1000)) return res.status(429).json({ error: 'too many requests' });
  const s = await pool.query(
    `SELECT s.id, s.seq_no, s.sent_at, s.approval_state, ${locationSql('cd', 't')} AS table_name
       FROM order_sends s
       JOIN orders o ON o.id = s.order_id
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN cards cd ON cd.id = o.card_id
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
