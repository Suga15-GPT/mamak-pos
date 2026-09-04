const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, rm2cents } = require('../lib/money');
const shifts = require('../services/shifts');
const printing = require('../services/printing');

const router = express.Router();

const KL = 'Asia/Kuala_Lumpur';

router.get('/api/summary', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  // `lt` is a local (tz-naive) timestamp. Bucket boundaries must stay plain
  // timestamps too — comparing against a `::timestamptz` cast re-introduces a
  // timezone (the session's, not KL) and can land a payment in the wrong
  // month/year bucket (audit #22). Report off `total_cents`, not the retired
  // `pay_total_cents` (phase 09 drops that column now that phase 05 backfilled
  // `payments`).
  const s = await pool.query(`
    WITH p AS (SELECT total_cents, paid_at AT TIME ZONE '${KL}' AS lt FROM orders WHERE status = 'paid'),
    today AS (SELECT (now() AT TIME ZONE '${KL}')::date AS d)
    SELECT
      COALESCE(SUM(CASE WHEN lt::date = (SELECT d FROM today) THEN total_cents END), 0)  today_cents,
      COUNT(CASE WHEN lt::date = (SELECT d FROM today) THEN 1 END)                       today_orders,
      COALESCE(SUM(CASE WHEN date_trunc('month', lt) = date_trunc('month', (SELECT d FROM today)::timestamp) THEN total_cents END), 0) month_cents,
      COUNT(CASE WHEN date_trunc('month', lt) = date_trunc('month', (SELECT d FROM today)::timestamp) THEN 1 END) month_orders,
      COALESCE(SUM(CASE WHEN date_trunc('year', lt) = date_trunc('year', (SELECT d FROM today)::timestamp) THEN total_cents END), 0)  year_cents,
      COUNT(CASE WHEN date_trunc('year', lt) = date_trunc('year', (SELECT d FROM today)::timestamp) THEN 1 END)  year_orders
    FROM p`);
  const open = await pool.query(
    "SELECT count(*)::int n FROM orders WHERE status IN ('sent','preparing','ready','served')");
  const top = await pool.query(`
    SELECT oi.name, SUM(oi.qty)::int sold
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status = 'paid' AND (o.paid_at AT TIME ZONE '${KL}')::date = (now() AT TIME ZONE '${KL}')::date
    GROUP BY oi.name ORDER BY sold DESC LIMIT 5`);
  const r = s.rows[0];
  res.json({
    today: { sales: cents2rm(r.today_cents), orders: Number(r.today_orders) },
    month: { sales: cents2rm(r.month_cents), orders: Number(r.month_orders) },
    year:  { sales: cents2rm(r.year_cents),  orders: Number(r.year_orders) },
    open_orders: open.rows[0].n,
    top_items: top.rows,
  });
}));

router.get('/api/settings', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const r = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('tax_rate_bp', 'svc_rate_bp', 'restaurant_name', 'restaurant_address', 'sst_number')");
  const v = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
  res.json({
    tax_rate_bp: Number(v.tax_rate_bp) || 0, svc_rate_bp: Number(v.svc_rate_bp) || 0,
    restaurant_name: v.restaurant_name || '', restaurant_address: v.restaurant_address || '', sst_number: v.sst_number || '',
  });
}));
router.patch('/api/settings', requireRole('admin'), awaitH(async (req, res) => {
  const taxRateBp = Number(req.body?.tax_rate_bp);
  const svcRateBp = Number(req.body?.svc_rate_bp);
  if (!Number.isInteger(taxRateBp) || taxRateBp < 0 || taxRateBp > 10000) return res.status(400).json({ error: 'bad tax_rate_bp' });
  if (!Number.isInteger(svcRateBp) || svcRateBp < 0 || svcRateBp > 10000) return res.status(400).json({ error: 'bad svc_rate_bp' });
  // Receipts print "Mamak POS" with no address/SST number until these are set
  // (services/printing.js's buildReceipt already reads them) — an SST-registered
  // business can't legally issue receipts without the registration number, so
  // this is required for real deployment even though it's optional here.
  const restaurantName = req.body?.restaurant_name == null ? null : String(req.body.restaurant_name).slice(0, 200);
  const restaurantAddress = req.body?.restaurant_address == null ? null : String(req.body.restaurant_address).slice(0, 300);
  const sstNumber = req.body?.sst_number == null ? null : String(req.body.sst_number).slice(0, 50);
  const rows = [['tax_rate_bp', String(taxRateBp)], ['svc_rate_bp', String(svcRateBp)]];
  if (restaurantName != null) rows.push(['restaurant_name', restaurantName]);
  if (restaurantAddress != null) rows.push(['restaurant_address', restaurantAddress]);
  if (sstNumber != null) rows.push(['sst_number', sstNumber]);
  for (const [key, value] of rows) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }
  res.json({ ok: true });
}));

/* ===== Shifts, cash drawer, X/Z reports (phase 09) ===== */

router.get('/api/shift/current', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  res.json(await shifts.current());
}));

router.post('/api/shift/open', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const floatCents = rm2cents(req.body?.float || 0);
  res.status(201).json(await shifts.open({ userId: req.user.id, floatCents }));
}));

router.post('/api/shift/movements', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const { kind, amount, reason } = req.body || {};
  res.status(201).json(await shifts.addMovement({ kind, amountCents: rm2cents(amount), reason, userId: req.user.id }));
}));

router.post('/api/shift/close', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const countedCents = rm2cents(req.body?.counted || 0);
  const note = req.body?.note;
  res.json(await shifts.close({ userId: req.user.id, countedCents, note }));
}));

router.get('/api/shift/:id/report', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  res.json(await shifts.report(Number(req.params.id), { final: req.query.final === '1' || req.query.final === 'true' }));
}));

router.post('/api/shift/:id/print-report', requireRole('admin'), awaitH(async (req, res) => {
  const final = req.query.final === '1' || req.query.final === 'true';
  const data = await shifts.report(Number(req.params.id), { final });
  await printing.printShiftReport(Number(req.params.id), data);
  res.json({ ok: true });
}));

module.exports = router;
