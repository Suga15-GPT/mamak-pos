const express = require('express');
const QRCode = require('qrcode');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, rm2cents } = require('../lib/money');
const { publicBaseUrl } = require('../lib/baseurl');
const { publish } = require('../lib/events');
const printing = require('../services/printing');
const cards = require('../services/cards');
const groups = require('../services/bill_groups');
const { requireFeature } = require('../services/features');

const router = express.Router();

/* ===== cards ===== */

// The floor: every active card, free or in use, with the open order's
// summary. No qr_token here — that stays admin-only, as a table's did.
router.get('/api/cards', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  res.json(await cards.listCards());
}));

router.patch('/api/admin/cards/count', requireRole('admin'), awaitH(async (req, res) => {
  const result = await cards.setCardCount(req.body?.count, req.user.id);
  publish('cards.updated', {});
  res.json({ ok: true, ...result });
}));

// Admin QR sheet: each active card's customer-page URL, for printing card faces.
router.get('/api/admin/cards', requireRole('admin'), awaitH(async (req, res) => {
  const base = publicBaseUrl(req);
  const r = await pool.query('SELECT id, number, active, qr_token FROM cards WHERE active ORDER BY number');
  res.json(r.rows.map(c => ({ ...c, url: `${base}/t/${c.qr_token}` })));
}));

router.get('/api/admin/cards/:id/qr.png', requireRole('admin'), requireFeature('qr'), awaitH(async (req, res) => {
  const r = await pool.query('SELECT qr_token FROM cards WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  const buf = await QRCode.toBuffer(`${publicBaseUrl(req)}/t/${r.rows[0].qr_token}`, { width: 512, margin: 1 });
  res.type('image/png').send(buf);
}));

// Shop mode's one poster.
router.get('/api/admin/qr-shop', requireRole('admin'), requireFeature('qr'), awaitH(async (req, res) => {
  const { shop_token: token } = await cards.qrSettings();
  res.json({ url: token ? `${publicBaseUrl(req)}/t/${token}` : null });
}));

router.get('/api/admin/qr-shop.png', requireRole('admin'), requireFeature('qr'), awaitH(async (req, res) => {
  const { shop_token: token } = await cards.qrSettings();
  if (!token) return res.status(404).json({ error: 'not found' });
  const buf = await QRCode.toBuffer(`${publicBaseUrl(req)}/t/${token}`, { width: 768, margin: 1 });
  res.type('image/png').send(buf);
}));

/* ===== combined bills ===== */

const staff = [requireRole('admin', 'staff'), requireFeature('split_combine')];
const touched = ids => ids.forEach(id => publish('order.updated', { order_id: id }));

router.post('/api/bill-groups', staff, awaitH(async (req, res) => {
  const ids = req.body?.order_ids;
  const g = await groups.combine(ids, req.user.id);
  touched((ids || []).map(Number));
  res.status(201).json(await groups.getGroup(g.id));
}));

router.get('/api/bill-groups/:id', staff, awaitH(async (req, res) => {
  res.json(await groups.getGroup(Number(req.params.id)));
}));

router.delete('/api/bill-groups/:id/orders/:orderId', staff, awaitH(async (req, res) => {
  const r = await groups.uncombine(Number(req.params.id), { orderId: Number(req.params.orderId), userId: req.user.id });
  touched(r.order_ids);
  res.json({ ok: true, ...r });
}));

router.delete('/api/bill-groups/:id', staff, awaitH(async (req, res) => {
  const r = await groups.uncombine(Number(req.params.id), { userId: req.user.id });
  touched(r.order_ids);
  res.json({ ok: true, ...r });
}));

/* Body: { method, amount?, tendered? } — the same shape as paying one order;
   amount (RM) defaults to the group's whole remaining balance. */
router.post('/api/bill-groups/:id/pay', staff, awaitH(async (req, res) => {
  const { method, amount, tendered } = req.body || {};
  const result = await groups.payGroup(Number(req.params.id), {
    method,
    amountCents: amount != null ? rm2cents(amount) : null,
    tenderedCents: tendered != null ? rm2cents(tendered) : null,
    userId: req.user.id,
  });
  result.order_ids.forEach(id => publish('order.paid', { order_id: id }));
  // One receipt for the whole group: printing builds the grouped layout for
  // any order that belongs to a bill group.
  if (result.settled && result.order_ids.length) await printing.enqueue('receipt', result.order_ids[0]);
  res.json({
    ok: true,
    paid: cents2rm(result.amount_cents),
    change: cents2rm(result.change_cents),
    remaining: cents2rm(result.remaining_cents),
    settled: result.settled,
    allocations: result.allocations.map(a => ({ order_id: a.order_id, card_number: a.card_number, amount: cents2rm(a.amount_cents) })),
  });
}));

module.exports = router;
