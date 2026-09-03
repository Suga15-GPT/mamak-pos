const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm } = require('../lib/money');

const router = express.Router();

const KL = 'Asia/Kuala_Lumpur';

router.get('/api/summary', requireRole('admin', 'staff'), awaitH(async (req, res) => {
  const s = await pool.query(`
    WITH p AS (SELECT pay_total_cents, paid_at AT TIME ZONE '${KL}' AS lt FROM orders WHERE status = 'paid'),
    today AS (SELECT (now() AT TIME ZONE '${KL}')::date AS d)
    SELECT
      COALESCE(SUM(CASE WHEN lt::date = (SELECT d FROM today) THEN pay_total_cents END), 0)  today_cents,
      COUNT(CASE WHEN lt::date = (SELECT d FROM today) THEN 1 END)                           today_orders,
      COALESCE(SUM(CASE WHEN date_trunc('month', lt) = date_trunc('month', (SELECT d FROM today)::timestamptz) THEN pay_total_cents END), 0) month_cents,
      COUNT(CASE WHEN date_trunc('month', lt) = date_trunc('month', (SELECT d FROM today)::timestamptz) THEN 1 END) month_orders,
      COALESCE(SUM(CASE WHEN date_trunc('year', lt) = date_trunc('year', (SELECT d FROM today)::timestamptz) THEN pay_total_cents END), 0)  year_cents,
      COUNT(CASE WHEN date_trunc('year', lt) = date_trunc('year', (SELECT d FROM today)::timestamptz) THEN 1 END)  year_orders
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
  const r = await pool.query("SELECT value FROM settings WHERE key = 'sst_on'");
  res.json({ sst_on: r.rows[0]?.value === 'true' });
}));
router.patch('/api/settings', requireRole('admin'), awaitH(async (req, res) => {
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('sst_on', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [req.body?.sst_on ? 'true' : 'false']);
  res.json({ ok: true });
}));

module.exports = router;
