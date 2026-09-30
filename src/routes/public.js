const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { publicH } = require('../lib/errors');
const { cents2rm } = require('../lib/money');
const { rateLimit } = require('../lib/auth');
const { buildOrderItems, insertOrder, appendSend, ordersWithItems, ORDERABLE_SQL } = require('../services/orders');
const { hasPayments, paidCentsFor, itemIdsPaid } = require('../services/billing');
const { publish } = require('../lib/events');
const printing = require('../services/printing');
const voice = require('../services/voice');
const { qrSettings, resolveQr } = require('../services/cards');
const { roundLocationSql } = require('../services/rounds');
const { openSql } = require('../lib/status');
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
    `SELECT id FROM orders WHERE card_id = $1 AND ${openSql()} LIMIT 1`, [card.id]) : { rows: [] };
  res.json({
    mode: settings.mode,
    card: card ? { number: card.number } : null,
    needs_card_number: !card,
    ordering: { enabled: settings.enabled, approval_required: settings.approval_required },
    has_open_order: !!open.rows[0],
    // What is on this card's bill right now. After Combine, the card that took
    // the other card's bill shows everything on it, the other card's items
    // marked with its number; the card that was combined away shows a fresh
    // card. Only a card's own QR: with the shop poster anyone can type any
    // card number, so it never shows a bill.
    bill: open.rows[0] && settings.mode === 'per_card' ? await customerBill(open.rows[0].id) : null,
    // A half-configured deployment shows the menu and no microphone, rather
    // than a Speak to Order button that fails when somebody taps it.
    voice: { enabled: voice.isEnabled() && (await isOn('voice')) },
  });
}));

// The bill as a customer may see it: what they are having, not staff notes
// or who rang it up. A round waiting for staff shows, marked, and counts in
// no total (the same rule as the till).
//
// Prices and the bill's breakdown are there so the customer can check the
// bill and split it among friends on their own phone (the split never comes
// back here: names stay on the phone). A line a "Split by items" share has
// already paid for says so, and what is left to pay is the bill less what has
// been paid.
async function customerBill(orderId) {
  const [o] = await ordersWithItems('WHERE o.id = $1', [orderId]);
  if (!o) return null;
  const [paidCents, paidLines] = await Promise.all([paidCentsFor(orderId), itemIdsPaid(orderId)]);
  const total = o.grand_total ?? o.total;
  return {
    total,
    subtotal: o.subtotal ?? o.total,
    service_charge: o.service_charge || 0,
    tax: o.tax || 0,
    discount: o.discount || 0,
    paid: cents2rm(paidCents),
    due: cents2rm(Math.max(0, Math.round(total * 100) - paidCents)),
    lines: o.items.filter(i => !i.voided).map(i => {
      const unit = Math.round((i.price + i.mods.reduce((t, m) => t + m.price, 0)) * 100);
      return {
        id: i.id, name: i.name, qty: i.qty, from_card: i.from_card ?? null,
        options: i.mods.map(m => m.name),
        amount: i.held ? 0 : cents2rm(unit * i.qty),
        paid: paidLines.has(i.id),
        status: i.held ? 'pending' : (i.round_status || 'sent'),
      };
    }),
  };
}

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
  const BEING_PAID = { error: 'bill_being_paid', message: 'Your bill is being settled. Please order with our staff.' };

  // Onto the card's open bill, or a new one if it has none. Looked up again
  // when the answer changed underneath: a second phone opened the card's
  // first bill at the same instant (one_open_order_per_card — join it), or
  // the bill was combined into another card's (Combine frees the card, so the
  // order opens a fresh bill on it, as a new scan of the card would).
  let placed = null;
  for (let attempt = 0; attempt < 3 && !placed; attempt++) {
    const open = (await pool.query(
      `SELECT id FROM orders WHERE card_id = $1 AND ${openSql()} ORDER BY id DESC LIMIT 1`, [cardId])).rows[0];
    if (open) {
      // The bill is mid-settlement: adding to it would make what was just paid
      // for wrong. Staff have to take over from here.
      if (await hasPayments(open.id)) return res.status(409).json(BEING_PAID);
      try {
        const r = await appendSend(open.id, parsed, 'qr', null, null, { approvalState, publicRef });
        placed = { orderId: open.id, sendId: r.sendId, seqNo: r.seqNo, created: false };
      } catch (e) {
        if (e.code === 'order_closed' && e.order_status === 'merged') continue;
        // Settled or closed in the instant between looking the bill up and
        // locking it: the same answer as the check above.
        if (e.code === 'has_payment' || e.code === 'order_closed') return res.status(409).json(BEING_PAID);
        throw e;
      }
    } else {
      try {
        const r = await insertOrder(cardId, parsed, String(note || '').slice(0, 300), 'qr', null, null, { approvalState, publicRef });
        placed = { orderId: r.orderId, sendId: r.sendId, seqNo: r.seqNo, created: true };
      } catch (e) {
        if (e.code === '23505' && e.constraint === 'one_open_order_per_card') continue;
        throw e;
      }
    }
  }
  if (!placed) return res.status(409).json({ error: 'busy', message: 'Your card is busy right now. Please try again, or order with our staff.' });
  const { orderId, sendId, seqNo } = placed;

  publish(placed.created ? 'order.created' : 'order.updated', { order_id: orderId, card_id: cardId });
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
  // A round Combine moved onto another card's bill says so: "Card 1 (from 4)".
  const s = await pool.query(
    `SELECT s.id, COALESCE(s.merged_from_seq_no, s.seq_no) AS seq_no, s.sent_at, s.approval_state,
            ${roundLocationSql('cd', 't', 'fc')} AS table_name
       FROM order_sends s
       JOIN orders o ON o.id = s.order_id
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN cards cd ON cd.id = o.card_id
       LEFT JOIN cards fc ON fc.id = s.merged_from_card_id
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
