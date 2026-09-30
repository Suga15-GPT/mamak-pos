const { pool } = require('../db');
const { AppError } = require('../lib/errors');

/* ===== Sales explorer =====
   One query shape for any date range, bucketed by hour, day or month, with
   the previous period of the same length alongside for comparison.

   What "sales" means is the Z report's meaning, so the two always agree: a
   bill counts on the moment it was settled (paid_at), at its total (SST,
   service charge, discounts and cash rounding included), whether it was later
   refunded or not; money given back is its own figure (refunds.at), and net =
   sales - refunds. Every figure is computed in Postgres in shop time (KL) and
   stays integer cents.

   Filters narrow what is counted, and two of them change what is measured,
   because there is no honest way to split a bill's total by them:
     - order_type (dine_in | takeaway): which bills.
     - category (a category id): item sales of that category — the lines'
       own value, before SST and bill discounts — on bills settled in range.
     - method (Cash | Card | DuitNow/eWallet): money taken that way, by when
       it was taken, less refunds given back that way.
   A category and a method together would be neither, so it is refused. */

const KL = 'Asia/Kuala_Lumpur';
const BUCKETS = { hour: '1 hour', day: '1 day', month: '1 month' };
const METHODS = ['Cash', 'Card', 'DuitNow/eWallet'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 3600 * 1000;
const toDate = s => new Date(`${s}T00:00:00Z`);
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(toDate(s).getTime() + n * DAY_MS));
const daysIn = (from, to) => Math.round((toDate(to) - toDate(from)) / DAY_MS) + 1;

// The finest view that stays readable: hours for a day or two, days up to two
// months, months beyond. Hours are allowed up to a week, days up to a year.
function autoBucket(days) { return days <= 2 ? 'hour' : days <= 62 ? 'day' : 'month'; }
const MAX_DAYS = { hour: 7, day: 366, month: 3 * 366 };

function parseQuery(q) {
  const from = String(q.from || ''), to = String(q.to || '');
  if (!DATE.test(from) || !DATE.test(to) || isNaN(toDate(from)) || isNaN(toDate(to))) {
    throw AppError('from and to must be dates (YYYY-MM-DD)', 400);
  }
  if (to < from) throw AppError('the end date is before the start date', 400);
  const days = daysIn(from, to);
  const bucket = q.bucket ? String(q.bucket) : autoBucket(days);
  if (!BUCKETS[bucket]) throw AppError('view by hour, day or month', 400);
  if (days > MAX_DAYS[bucket]) {
    throw AppError(bucket === 'month'
      ? 'Pick at most three years.'
      : `That range is too long to show by ${bucket} — pick at most ${MAX_DAYS[bucket]} days, or view by ${bucket === 'hour' ? 'day' : 'month'}.`, 400);
  }
  const orderType = ['dine_in', 'takeaway'].includes(q.order_type) ? q.order_type : null;
  const method = q.method && q.method !== 'all' ? String(q.method) : null;
  if (method && !METHODS.includes(method)) throw AppError('unknown payment method', 400);
  const category = q.category && q.category !== 'all' ? Number(q.category) : null;
  if (category != null && !(Number.isInteger(category) && category > 0)) throw AppError('unknown category', 400);
  if (method && category) throw AppError('Filter by a category or by a payment method, not both.', 400);
  return { from, to, days, bucket, orderType, method, category };
}

// Line value: price plus options, times quantity, of a live, accepted line.
const LINE_VALUE = `(oi.price_cents + COALESCE((SELECT SUM(m.price_cents) FROM order_item_mods m WHERE m.order_item_id = oi.id), 0)) * oi.qty`;
const LIVE_LINE = `oi.voided_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM order_sends se WHERE se.id = oi.send_id AND se.approval_state <> 'approved')`;

/* One period's buckets: [{ key, bills, sales_cents, refunds_cents, net_cents }].
   Every bucket in range is present, zero-filled, so the chart's gaps are real. */
async function series(client, { from, to, bucket, orderType, method, category }) {
  const params = [from, addDays(to, 1), BUCKETS[bucket], bucket];
  const p = v => { params.push(v); return `$${params.length}`; };
  const typeSql = orderType ? `AND o.order_type = ${p(orderType)}` : '';
  const local = col => `(${col} AT TIME ZONE '${KL}')`;
  const inRange = col => `${local(col)} >= $1::date AND ${local(col)} < $2::date`;
  const key = col => `date_trunc($4, ${local(col)})`;

  let salesSql, refundsSql;
  if (method) {
    const m = p(method);
    salesSql = `SELECT ${key('pm.at')} k, COUNT(DISTINCT pm.order_id)::int bills, SUM(pm.amount_cents)::bigint cents
                  FROM payments pm JOIN orders o ON o.id = pm.order_id
                 WHERE pm.method = ${m} AND ${inRange('pm.at')} ${typeSql} GROUP BY 1`;
    refundsSql = `SELECT ${key('r.at')} k, SUM(r.amount_cents)::bigint cents
                    FROM refunds r JOIN payments pm ON pm.id = r.payment_id JOIN orders o ON o.id = r.order_id
                   WHERE pm.method = ${m} AND ${inRange('r.at')} ${typeSql} GROUP BY 1`;
  } else if (category) {
    const c = p(category);
    salesSql = `SELECT ${key('o.paid_at')} k, COUNT(DISTINCT o.id)::int bills, SUM(${LINE_VALUE})::bigint cents
                  FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN items i ON i.id = oi.item_id
                 WHERE o.status IN ('paid','refunded') AND ${inRange('o.paid_at')} ${typeSql}
                   AND i.category_id = ${c} AND ${LIVE_LINE} GROUP BY 1`;
    refundsSql = null; // a refund is money back on a bill, not on a category
  } else {
    salesSql = `SELECT ${key('o.paid_at')} k, COUNT(*)::int bills, SUM(o.total_cents)::bigint cents
                  FROM orders o
                 WHERE o.status IN ('paid','refunded') AND ${inRange('o.paid_at')} ${typeSql} GROUP BY 1`;
    refundsSql = `SELECT ${key('r.at')} k, SUM(r.amount_cents)::bigint cents
                    FROM refunds r JOIN orders o ON o.id = r.order_id
                   WHERE ${inRange('r.at')} ${typeSql} GROUP BY 1`;
  }

  const rows = (await client.query(`
    WITH b AS (
      SELECT generate_series(date_trunc($4, $1::date::timestamp), $2::date::timestamp - interval '1 second', $3::interval) AS k
    ),
    s AS (${salesSql}),
    r AS (${refundsSql || 'SELECT NULL::timestamp k, 0::bigint cents WHERE false'})
    SELECT to_char(b.k, 'YYYY-MM-DD"T"HH24:00') AS key,
           COALESCE(s.bills, 0)::int AS bills,
           COALESCE(s.cents, 0)::bigint AS sales_cents,
           COALESCE(r.cents, 0)::bigint AS refunds_cents
      FROM b LEFT JOIN s ON s.k = b.k LEFT JOIN r ON r.k = b.k
     ORDER BY b.k`, params)).rows;
  return rows.map(r => {
    const sales = Number(r.sales_cents), refunds = Number(r.refunds_cents);
    return { key: r.key, bills: r.bills, sales_cents: sales, refunds_cents: refunds, net_cents: sales - refunds };
  });
}

const sum = (rows, f) => rows.reduce((t, r) => t + r[f], 0);
function totals(rows) {
  const bills = sum(rows, 'bills'), sales = sum(rows, 'sales_cents'), refunds = sum(rows, 'refunds_cents');
  return { bills, sales_cents: sales, refunds_cents: refunds, net_cents: sales - refunds, average_cents: bills ? Math.round(sales / bills) : 0 };
}

/* withExpenses: the owner, with the Expenses module on, and no filter chosen
   (a cost belongs to no order type, payment method or menu category) — each
   bucket then carries what was spent too, and the summary sales − expenses. */
async function explore(query, { withExpenses = false } = {}) {
  const q = parseQuery(query);
  const prevTo = addDays(q.from, -1);
  const prevFrom = addDays(q.from, -q.days);
  const client = await pool.connect();
  try {
    // One snapshot for every figure on the screen.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = await series(client, q);
    const previous = await series(client, { ...q, from: prevFrom, to: prevTo });

    const typeSql = q.orderType ? 'AND o.order_type = $3' : '';
    const base = [q.from, addDays(q.to, 1), ...(q.orderType ? [q.orderType] : [])];
    const settled = `o.status IN ('paid','refunded')
      AND (o.paid_at AT TIME ZONE '${KL}') >= $1::date AND (o.paid_at AT TIME ZONE '${KL}') < $2::date ${typeSql}`;
    const catSql = q.category ? `AND i.category_id = $${base.length + 1}` : '';
    const top = (await client.query(`
      SELECT oi.name, SUM(oi.qty)::int sold, SUM(${LINE_VALUE})::bigint cents
        FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN items i ON i.id = oi.item_id
       WHERE ${settled} AND ${LIVE_LINE} ${catSql}
       GROUP BY oi.name ORDER BY sold DESC, cents DESC LIMIT 10`,
    q.category ? [...base, q.category] : base)).rows;
    const categories = (await client.query(`
      SELECT COALESCE(c.name, 'Uncategorised') AS name, SUM(${LINE_VALUE})::bigint cents
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN items i ON i.id = oi.item_id LEFT JOIN categories c ON c.id = i.category_id
       WHERE ${settled} AND ${LIVE_LINE}
       GROUP BY 1 ORDER BY cents DESC`, base)).rows;
    const mix = (await client.query(`
      SELECT pm.method, SUM(pm.amount_cents)::bigint cents, COUNT(*)::int n
        FROM payments pm JOIN orders o ON o.id = pm.order_id
       WHERE (pm.at AT TIME ZONE '${KL}') >= $1::date AND (pm.at AT TIME ZONE '${KL}') < $2::date ${typeSql}
       GROUP BY 1 ORDER BY cents DESC`, base)).rows;
    let expenses = null;
    if (withExpenses && !q.orderType && !q.method && !q.category) {
      const e = await require('./expenses').byBucket(client, q.from, q.to, q.bucket);
      expenses = { total_cents: e.total_cents, by_bucket: !!e.rows };
      if (e.rows) rows.forEach(r => { r.expenses_cents = e.rows[r.key] || 0; });
    }
    await client.query('COMMIT');

    return {
      expenses,
      from: q.from, to: q.to, bucket: q.bucket,
      measure: q.method ? 'method' : q.category ? 'category' : 'sales',
      filters: { order_type: q.orderType, method: q.method, category: q.category },
      previous_range: { from: prevFrom, to: prevTo },
      rows, previous: previous.map(r => ({ key: r.key, net_cents: r.net_cents, sales_cents: r.sales_cents, bills: r.bills })),
      totals: totals(rows), previous_totals: totals(previous),
      top_items: top.map(r => ({ name: r.name, sold: r.sold, cents: Number(r.cents) })),
      categories: categories.map(r => ({ name: r.name, cents: Number(r.cents) })),
      payment_mix: mix.map(r => ({ method: r.method, cents: Number(r.cents), count: r.n })),
    };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

module.exports = { explore, parseQuery, autoBucket };
