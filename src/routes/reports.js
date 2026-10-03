const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH } = require('../lib/errors');
const { cents2rm, rm2cents } = require('../lib/money');
const shifts = require('../services/shifts');
const printing = require('../services/printing');
const rounds = require('../services/rounds');
const { requireFeature, isOn } = require('../services/features');
const analytics = require('../services/analytics');

const router = express.Router();

const KL = 'Asia/Kuala_Lumpur';

/* Net sales the way the Z report and the Sales explorer count them (review
   F4): a bill counts when it was settled, at its total, whether or not it was
   refunded later; money given back counts when it was given back, as a minus.
   Each row of `money` is one of those: c is the cents (+ sale, − refund), bill
   is 1 for a settled bill, lt the shop-time moment. A tile that read
   status = 'paid' only dropped a refunded bill's sale and missed partial
   refunds, so it disagreed with the explorer right below it. */
const MONEY_CTE = `
  t AS (SELECT (now() AT TIME ZONE '${KL}')::date AS d),
  money AS (
    SELECT o.total_cents AS c, 1 AS bill, o.order_type AS ty, (o.paid_at AT TIME ZONE '${KL}') AS lt
      FROM orders o WHERE o.status IN ('paid', 'refunded')
    UNION ALL
    SELECT -r.amount_cents, 0, o.order_type, (r.at AT TIME ZONE '${KL}')
      FROM refunds r JOIN orders o ON o.id = r.order_id
  )`;
const IN_DAY = (off = 0) => `lt::date = (SELECT d FROM t) - ${off}`;
const IN_MONTH = `date_trunc('month', lt) = date_trunc('month', (SELECT d FROM t)::timestamp)`;
const IN_YEAR = `date_trunc('year', lt) = date_trunc('year', (SELECT d FROM t)::timestamp)`;
const net = (cond, extra = '') => `COALESCE(SUM(c) FILTER (WHERE ${cond}${extra}), 0)::bigint`;
const bills = (cond, extra = '') => `COUNT(*) FILTER (WHERE bill = 1 AND ${cond}${extra})::int`;
const gross = (cond, extra = '') => `COALESCE(SUM(c) FILTER (WHERE bill = 1 AND ${cond}${extra}), 0)::bigint`;

// Sales figures belong to the dashboard module: with it off, 404 like every
// other route of a switched-off module, and the 💰 Sales tab is not shown.
router.get('/api/summary', requireRole('admin', 'staff'), requireFeature('dashboard'), awaitH(async (req, res) => {
  // `lt` is a local (tz-naive) timestamp. Bucket boundaries must stay plain
  // timestamps too — comparing against a `::timestamptz` cast re-introduces a
  // timezone (the session's, not KL) and can land a payment in the wrong
  // month/year bucket (audit #22). Report off `total_cents`, not the retired
  // `pay_total_cents` (phase 09 drops that column now that phase 05 backfilled
  // `payments`).
  const s = await pool.query(`
    WITH ${MONEY_CTE}
    SELECT ${net(IN_DAY())} today_cents, ${bills(IN_DAY())} today_orders,
           ${net(IN_MONTH)} month_cents, ${bills(IN_MONTH)} month_orders,
           ${net(IN_YEAR)} year_cents, ${bills(IN_YEAR)} year_orders
      FROM money`);
  const open = await pool.query(
    "SELECT count(*)::int n FROM orders WHERE status IN ('sent','preparing','ready','served')");
  const top = await pool.query(`
    SELECT oi.name, SUM(oi.qty)::int sold
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status IN ('paid', 'refunded') AND oi.voided_at IS NULL
      AND (o.paid_at AT TIME ZONE '${KL}')::date = (now() AT TIME ZONE '${KL}')::date
    GROUP BY oi.name ORDER BY sold DESC LIMIT 5`);
  const r = s.rows[0];
  res.json({
    today: { sales: cents2rm(Number(r.today_cents)), orders: Number(r.today_orders) },
    month: { sales: cents2rm(Number(r.month_cents)), orders: Number(r.month_orders) },
    year:  { sales: cents2rm(Number(r.year_cents)),  orders: Number(r.year_orders) },
    open_orders: open.rows[0].n,
    top_items: top.rows,
  });
}));

/* ===== dashboard =====
   One round trip for the whole owner view. Everything here is aggregated in
   Postgres off rows that already exist — no metric is invented, and anything
   the data cannot support honestly is simply absent rather than zero-filled.
   All money stays integer cents until the JSON boundary. */
router.get('/api/dashboard', requireRole('admin', 'staff'), requireFeature('dashboard'), awaitH(async (req, res) => {
  const today = `(now() AT TIME ZONE '${KL}')::date`;
  const paidLocal = `(o.paid_at AT TIME ZONE '${KL}')`;

  const [sales, mix, hourly, top, kitchen, adjustments, floor] = await Promise.all([
    // Net sales and bills for today and yesterday (for the comparison), the
    // running month and year, and today by order type — the Z report's way
    // (MONEY_CTE above). This is a calendar view, not a till reconciliation.
    pool.query(`
      WITH ${MONEY_CTE}
      SELECT ${net(IN_DAY())} today_cents, ${bills(IN_DAY())} today_orders, ${gross(IN_DAY())} today_gross_cents,
             ${net(IN_DAY(1))} yesterday_cents, ${bills(IN_DAY(1))} yesterday_orders,
             (-${net(IN_DAY(1), ' AND bill = 0')}) yesterday_refunds_cents,
             ${net(IN_MONTH)} month_cents, ${net(IN_YEAR)} year_cents,
             ${net(IN_DAY(), " AND ty = 'dine_in'")} dine_in_cents, ${bills(IN_DAY(), " AND ty = 'dine_in'")} dine_in_orders,
             ${net(IN_DAY(), " AND ty = 'takeaway'")} takeaway_cents, ${bills(IN_DAY(), " AND ty = 'takeaway'")} takeaway_orders
        FROM money`),

    pool.query(`
      SELECT p.method, SUM(p.amount_cents)::int cents, COUNT(*)::int n
        FROM payments p
       WHERE (p.at AT TIME ZONE '${KL}')::date = ${today}
       GROUP BY p.method ORDER BY cents DESC`),

    pool.query(`
      SELECT EXTRACT(hour FROM ${paidLocal})::int AS hour, SUM(o.total_cents)::int cents, COUNT(*)::int orders
        FROM orders o
       WHERE o.status IN ('paid', 'refunded') AND ${paidLocal}::date = ${today}
       GROUP BY 1 ORDER BY 1`),

    pool.query(`
      SELECT oi.name, SUM(oi.qty)::int sold, SUM(oi.price_cents * oi.qty)::int cents
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status IN ('paid', 'refunded') AND ${paidLocal}::date = ${today} AND oi.voided_at IS NULL
       GROUP BY oi.name ORDER BY sold DESC, cents DESC LIMIT 8`),

    // Kitchen health, measured off the round tickets that actually record it.
    // Preparation time is sent -> ready; a ticket that never reached 'ready'
    // contributes nothing rather than a guess. Active and late count exactly
    // the kitchen board's New and Cooking columns (rounds.ON_BOARD_SQL), a
    // paid bill's tickets included, so a ticket no screen shows is never
    // counted as waiting.
    pool.query(`
      WITH prep AS (
        SELECT tk.*, s.sent_at FROM order_send_tickets tk JOIN order_sends s ON s.id = tk.send_id
         WHERE s.approval_state = 'approved' AND tk.status <> 'cancelled'
      ),
      active AS (
        SELECT s.sent_at FROM order_send_tickets t JOIN order_sends s ON s.id = t.send_id JOIN orders o ON o.id = s.order_id
         WHERE ${rounds.ON_BOARD_SQL} AND t.status IN ('sent','preparing')
      )
      SELECT
        (SELECT COALESCE(ROUND(AVG(EXTRACT(epoch FROM (ready_at - sent_at)) / 60))::int, 0)
           FROM prep WHERE ready_at IS NOT NULL AND (sent_at AT TIME ZONE '${KL}')::date = ${today}) AS avg_prep_minutes,
        (SELECT COUNT(*)::int FROM active)                                                        AS active_tickets,
        (SELECT COALESCE(MAX(FLOOR(EXTRACT(epoch FROM (now() - sent_at)) / 60))::int, 0)
           FROM active)                                                                          AS longest_active_minutes,
        (SELECT COUNT(*)::int FROM active WHERE sent_at < now() - interval '10 minutes')          AS late_tickets,
        (SELECT COUNT(*)::int FROM order_sends s2 WHERE s2.approval_state = 'pending')            AS pending_approval`),

    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM order_items oi
          WHERE (oi.voided_at AT TIME ZONE '${KL}')::date = ${today})                             AS voids_count,
        (SELECT COALESCE(SUM(oi.price_cents * oi.qty), 0)::int FROM order_items oi
          WHERE (oi.voided_at AT TIME ZONE '${KL}')::date = ${today})                             AS voids_cents,
        (SELECT COALESCE(SUM(d.amount_cents), 0)::int FROM discounts d
          WHERE (d.at AT TIME ZONE '${KL}')::date = ${today})                                     AS discounts_cents,
        (SELECT COALESCE(SUM(r.amount_cents), 0)::int FROM refunds r
          WHERE (r.at AT TIME ZONE '${KL}')::date = ${today})                                     AS refunds_cents`),

    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE order_type = 'dine_in')::int  AS open_cards,
        COUNT(*) FILTER (WHERE order_type = 'takeaway')::int  AS open_takeaway,
        COUNT(*) FILTER (WHERE status = 'served')::int        AS ready_to_pay,
        COALESCE(SUM(total_cents), 0)::int                    AS open_cents
      FROM orders WHERE status IN ('sent','preparing','ready','served')`),
  ]);

  const s = Object.fromEntries(Object.entries(sales.rows[0]).map(([key, v]) => [key, Number(v)]));
  const k = kitchen.rows[0], a = adjustments.rows[0], f = floor.rows[0];
  // As the Z report's average check: settled bills' totals over their count.
  const avgOrder = s.today_orders ? Math.round(s.today_gross_cents / s.today_orders) : 0;

  res.json({
    today: {
      sales: cents2rm(s.today_cents), orders: s.today_orders, average_order: cents2rm(avgOrder),
      dine_in: { sales: cents2rm(s.dine_in_cents), orders: s.dine_in_orders },
      takeaway: { sales: cents2rm(s.takeaway_cents), orders: s.takeaway_orders },
    },
    yesterday: { sales: cents2rm(s.yesterday_cents), orders: s.yesterday_orders, refunds: cents2rm(s.yesterday_refunds_cents) },
    month: { sales: cents2rm(s.month_cents) },
    year: { sales: cents2rm(s.year_cents) },
    floor: {
      open_cards: f.open_cards, open_takeaway: f.open_takeaway,
      ready_to_pay: f.ready_to_pay, open_value: cents2rm(f.open_cents),
    },
    kitchen: {
      avg_prep_minutes: k.avg_prep_minutes,
      active_tickets: k.active_tickets,
      longest_active_minutes: k.longest_active_minutes,
      late_tickets: k.late_tickets,
      pending_approval: k.pending_approval,
    },
    adjustments: {
      voids_count: a.voids_count, voids: cents2rm(a.voids_cents),
      discounts: cents2rm(a.discounts_cents), refunds: cents2rm(a.refunds_cents),
    },
    hourly: hourly.rows.map(r => ({ hour: r.hour, sales: cents2rm(r.cents), orders: r.orders })),
    payment_mix: mix.rows.map(r => ({ method: r.method, sales: cents2rm(r.cents), count: r.n })),
    top_items: top.rows.map(r => ({ name: r.name, sold: r.sold, sales: cents2rm(r.cents) })),
  });
}));

/* The Sales explorer: any date range (KL dates, inclusive), by hour, day or
   month, filtered, with the previous period of the same length. See
   services/analytics.js for what each figure means. */
router.get('/api/analytics', requireRole('admin', 'staff'), requireFeature('dashboard'), awaitH(async (req, res) => {
  const withExpenses = req.user.role === 'admin' && await isOn('expenses');
  res.json(await analytics.explore(req.query, { withExpenses }));
}));

const SETTING_KEYS = [
  'tax_rate_bp', 'svc_rate_bp', 'restaurant_name', 'restaurant_address', 'sst_number',
  'qr_mode', 'qr_require_approval',
];

router.get('/api/settings', requireRole('admin', 'staff', 'kitchen'), awaitH(async (req, res) => {
  const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [SETTING_KEYS]);
  const v = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
  res.json({
    tax_rate_bp: Number(v.tax_rate_bp) || 0, svc_rate_bp: Number(v.svc_rate_bp) || 0,
    restaurant_name: v.restaurant_name || '', restaurant_address: v.restaurant_address || '', sst_number: v.sst_number || '',
    // Card mode (migration 014): per_card | shop | off. Shipped default is
    // per_card — a QR that silently does nothing is worse than one that works.
    qr_mode: ['per_card', 'shop', 'off'].includes(v.qr_mode) ? v.qr_mode : 'per_card',
    qr_require_approval: v.qr_require_approval === '1',
  });
}));

/* Every field is optional — Admin is now several small forms (Payments & Tax,
   Restaurant, QR ordering) that each save only what they own, instead of one
   giant form that had to resubmit the tax rate to change the shop's address. */
router.patch('/api/settings', requireRole('admin'), awaitH(async (req, res) => {
  const b = req.body || {};
  const rows = [];

  for (const key of ['tax_rate_bp', 'svc_rate_bp']) {
    if (b[key] === undefined) continue;
    const n = Number(b[key]);
    if (!Number.isInteger(n) || n < 0 || n > 10000) return res.status(400).json({ error: `bad ${key}` });
    rows.push([key, String(n)]);
  }
  // Receipts print "Mamak POS" with no address/SST number until these are set
  // (services/printing.js's buildReceipt already reads them) — an SST-registered
  // business can't legally issue receipts without the registration number.
  const text = { restaurant_name: 200, restaurant_address: 300, sst_number: 50 };
  for (const [key, max] of Object.entries(text)) {
    if (b[key] == null) continue;
    rows.push([key, String(b[key]).slice(0, max)]);
  }
  if (b.qr_mode !== undefined) {
    if (!['per_card', 'shop', 'off'].includes(b.qr_mode)) return res.status(400).json({ error: 'bad qr_mode' });
    rows.push(['qr_mode', b.qr_mode]);
  }
  if (b.qr_require_approval !== undefined) rows.push(['qr_require_approval', b.qr_require_approval ? '1' : '0']);

  if (!rows.length) return res.status(400).json({ error: 'nothing to update' });
  for (const [key, value] of rows) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }
  res.json({ ok: true });
}));

/* ===== Shifts, cash drawer, X/Z reports (phase 09) ===== */

router.get('/api/shift/current', requireRole('admin', 'staff'), requireFeature('shifts'), awaitH(async (req, res) => {
  res.json(await shifts.current());
}));

router.post('/api/shift/open', requireRole('admin', 'staff'), requireFeature('shifts'), awaitH(async (req, res) => {
  const floatCents = rm2cents(req.body?.float || 0);
  res.status(201).json(await shifts.open({ userId: req.user.id, floatCents }));
}));

router.post('/api/shift/movements', requireRole('admin', 'staff'), requireFeature('shifts'), awaitH(async (req, res) => {
  const { kind, amount, reason } = req.body || {};
  res.status(201).json(await shifts.addMovement({ kind, amountCents: rm2cents(amount), reason, userId: req.user.id }));
}));

router.post('/api/shift/close', requireRole('admin', 'staff'), requireFeature('shifts'), awaitH(async (req, res) => {
  const countedCents = rm2cents(req.body?.counted || 0);
  const note = req.body?.note;
  res.json(await shifts.close({ userId: req.user.id, countedCents, note }));
}));

router.get('/api/shift/:id/report', requireRole('admin', 'staff'), requireFeature('shifts'), awaitH(async (req, res) => {
  res.json(await shifts.report(Number(req.params.id), { final: req.query.final === '1' || req.query.final === 'true' }));
}));

router.post('/api/shift/:id/print-report', requireRole('admin'), requireFeature('shifts', 'printing'), awaitH(async (req, res) => {
  const final = req.query.final === '1' || req.query.final === 'true';
  const data = await shifts.report(Number(req.params.id), { final });
  await printing.printShiftReport(Number(req.params.id), data);
  res.json({ ok: true });
}));

module.exports = router;
