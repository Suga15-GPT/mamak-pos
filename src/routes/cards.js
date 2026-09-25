const express = require('express');
const crypto = require('crypto');
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
const { writeAudit } = require('../services/orders');

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

router.get('/api/admin/cards/:id/qr.png', requireRole('admin'), awaitH(async (req, res) => {
  const r = await pool.query('SELECT qr_token FROM cards WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  const buf = await QRCode.toBuffer(`${publicBaseUrl(req)}/t/${r.rows[0].qr_token}`, { width: 512, margin: 1 });
  res.type('image/png').send(buf);
}));

/* Reissue a card's QR token: every printed copy of the old one stops working
   (a card photographed and abused, or simply lost). */
router.post('/api/admin/cards/:id/regenerate-qr', requireRole('admin'), awaitH(async (req, res) => {
  const token = crypto.randomBytes(8).toString('hex');
  const r = await pool.query('UPDATE cards SET qr_token = $1 WHERE id = $2 RETURNING id, number', [token, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  await writeAudit(pool, {
    userId: req.user.id, action: 'card.qr_regenerate', entityType: 'card', entityId: r.rows[0].id,
    detail: { card: `Card ${r.rows[0].number}` },
  });
  res.json({ ok: true, url: `${publicBaseUrl(req)}/t/${token}` });
}));

// Shop mode's one poster.
router.get('/api/admin/qr-shop', requireRole('admin'), awaitH(async (req, res) => {
  const { shop_token: token } = await cards.qrSettings();
  res.json({ url: token ? `${publicBaseUrl(req)}/t/${token}` : null });
}));

router.post('/api/admin/qr-shop/regenerate', requireRole('admin'), awaitH(async (req, res) => {
  const token = crypto.randomBytes(8).toString('hex');
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('qr_shop_token', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [token]);
  await writeAudit(pool, { userId: req.user.id, action: 'qr_shop.regenerate', entityType: 'settings', entityId: null, detail: {} });
  res.json({ ok: true, url: `${publicBaseUrl(req)}/t/${token}` });
}));

router.get('/api/admin/qr-shop.png', requireRole('admin'), awaitH(async (req, res) => {
  const { shop_token: token } = await cards.qrSettings();
  if (!token) return res.status(404).json({ error: 'not found' });
  const buf = await QRCode.toBuffer(`${publicBaseUrl(req)}/t/${token}`, { width: 768, margin: 1 });
  res.type('image/png').send(buf);
}));

/* ===== combined bills ===== */

const staff = requireRole('admin', 'staff');
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

/* Body: { legs: [{ method, amount?, tendered? }, ...] } — every way the
   customer is paying (RM), submitted together. The legs must settle the whole
   bill; nothing is written otherwise. */
router.post('/api/bill-groups/:id/pay', staff, awaitH(async (req, res) => {
  const raw = req.body?.legs;
  const legs = Array.isArray(raw) ? raw.map(l => ({
    method: l?.method,
    amountCents: l?.amount != null ? rm2cents(l.amount) : null,
    tenderedCents: l?.tendered != null ? rm2cents(l.tendered) : null,
  })) : raw;
  const result = await groups.payGroup(Number(req.params.id), { legs, userId: req.user.id });
  result.order_ids.forEach(id => publish('order.paid', { order_id: id }));
  // One receipt for the whole group: printing builds the grouped layout for
  // any order that belongs to a bill group.
  if (result.order_ids.length) await printing.enqueue('receipt', result.order_ids[0]);
  res.json({
    ok: true,
    paid: cents2rm(result.amount_cents),
    change: cents2rm(result.change_cents),
    rounding: cents2rm(result.rounding_cents),
    settled: result.settled,
    allocations: result.allocations.map(a => ({ order_id: a.order_id, card_number: a.card_number, method: a.method, amount: cents2rm(a.amount_cents) })),
  });
}));

module.exports = router;
