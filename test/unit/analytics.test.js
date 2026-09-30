const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const { startApp, setup, post, get, json, openCard, one } = require('../apphelper');

/* The Sales explorer (services/analytics.js): any range, by hour, day or
   month, with filters and the previous period — and the Z report's meaning of
   "sales", so the two agree to the sen. */

const todayOf = async db => (await db.query("SELECT to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') d")).rows[0].d;
const ok = async (pending, label) => {
  const res = await pending;
  assert.ok(res.status < 300, `${label}: ${res.status} ${await res.clone().text()}`);
  return res;
};
const explore = (base, s, q) => get(base, s, `/api/analytics?${new URLSearchParams(q)}`);

// Moves a bill (and its payments and refunds) back in time, as if settled then.
async function backdate(db, id, interval) {
  await db.query('ALTER TABLE orders DISABLE TRIGGER USER');
  try {
    await db.query(`UPDATE orders SET paid_at = paid_at - $2::interval, created_at = created_at - $2::interval WHERE id = $1`, [id, interval]);
  } finally { await db.query('ALTER TABLE orders ENABLE TRIGGER USER'); }
  await db.query('UPDATE payments SET at = at - $2::interval WHERE order_id = $1', [id, interval]);
  await db.query('UPDATE refunds SET at = at - $2::interval WHERE order_id = $1', [id, interval]);
}

test('one day\'s explorer figures are exactly that day\'s Z report: sales, refunds, bills, payment mix', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, [{ item_id: s.roti.id, qty: 2 }, { item_id: s.teh.id, qty: 1 }]);
    await ok(post(base, s, `/api/orders/${a}/pay`, { method: 'Cash', tendered: 20 }), 'cash');
    const b = await openCard(base, s, 2, one(s.mee));
    await ok(post(base, s, `/api/orders/${b}/pay`, { method: 'Card' }), 'card');
    const takeaway = await json(await ok(post(base, s, '/api/orders', { order_type: 'takeaway', items: one(s.telur) }), 'takeaway'));
    await ok(post(base, s, `/api/orders/${takeaway.id}/pay`, { method: 'DuitNow/eWallet' }), 'ewallet');
    // A refund on the card bill.
    const pay = (await db.query('SELECT id FROM payments WHERE order_id = $1', [b])).rows[0].id;
    await ok(post(base, s, `/api/orders/${b}/refunds`, { payment_id: pay, amount: 1, reason: 'cold' }), 'refund');

    const shift = await get(base, s, '/api/shift/current');
    const z = await get(base, s, `/api/shift/${shift.id}/report`);
    const day = await todayOf(db);
    const d = await explore(base, s, { from: day, to: day });
    assert.equal(d.bucket, 'hour');
    assert.equal(d.rows.length, 24, 'every hour of the day, zero-filled');
    assert.equal(d.totals.sales_cents, z.net_sales_cents, 'sales = the Z report\'s net sales');
    assert.equal(d.totals.refunds_cents, z.refunds_cents, 'refunds = the Z report\'s refunds');
    assert.equal(d.totals.bills, z.order_count);
    assert.equal(d.totals.net_cents, z.net_sales_cents - z.refunds_cents);
    const mix = Object.fromEntries(d.payment_mix.map(m => [m.method, m.cents]));
    assert.deepEqual(mix, Object.fromEntries(z.payment_mix.map(m => [m.method, m.cents])));

    // By day, the same totals in one bucket.
    const byDay = await explore(base, s, { from: day, to: day, bucket: 'day' });
    assert.equal(byDay.rows.length, 1);
    assert.equal(byDay.rows[0].net_cents, d.totals.net_cents);

    // Order type narrows the bills.
    const ta = await explore(base, s, { from: day, to: day, order_type: 'takeaway' });
    assert.equal(ta.totals.bills, 1);
    assert.equal(ta.totals.sales_cents, (await db.query('SELECT total_cents FROM orders WHERE id = $1', [takeaway.id])).rows[0].total_cents);

    // A payment method: what was taken that way, less what was given back that way.
    const card = await explore(base, s, { from: day, to: day, method: 'Card' });
    const cardPaid = (await db.query("SELECT SUM(amount_cents)::int s FROM payments WHERE method = 'Card'")).rows[0].s;
    assert.equal(card.measure, 'method');
    assert.equal(card.totals.sales_cents, cardPaid);
    assert.equal(card.totals.refunds_cents, 100);
    assert.equal(card.totals.net_cents, cardPaid - 100);

    // A category: its lines' own value, before SST.
    const roti = await explore(base, s, { from: day, to: day, category: s.roti.category_id, bucket: 'day' });
    const rotiCents = (await db.query(
      `SELECT SUM(oi.price_cents * oi.qty)::int s FROM order_items oi JOIN items i ON i.id = oi.item_id WHERE i.category_id = $1`,
      [s.roti.category_id])).rows[0].s;
    assert.equal(roti.measure, 'category');
    assert.equal(roti.totals.sales_cents, rotiCents);
    assert.equal(roti.totals.refunds_cents, 0);
  });
});

test('open bills are not sales; a bill counts on the day it was settled, and the previous period is the same length before', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const day = await todayOf(db);
    await openCard(base, s, 3, one(s.roti)); // open: not a sale
    const old = await openCard(base, s, 4, one(s.mee));
    await ok(post(base, s, `/api/orders/${old}/pay`, { method: 'Card' }), 'pay');
    await backdate(db, old, '1 day');
    const now = await openCard(base, s, 5, one(s.teh));
    await ok(post(base, s, `/api/orders/${now}/pay`, { method: 'Card' }), 'pay');

    const d = await explore(base, s, { from: day, to: day });
    assert.equal(d.totals.bills, 1, 'only today\'s settled bill');
    const yesterdayTotal = (await db.query('SELECT total_cents FROM orders WHERE id = $1', [old])).rows[0].total_cents;
    assert.equal(d.previous_totals.sales_cents, yesterdayTotal, 'yesterday is the previous period');
    assert.equal(d.previous.length, 24);

    const week = await explore(base, s, { from: '2026-01-05', to: '2026-01-11' });
    assert.equal(week.bucket, 'day');
    assert.deepEqual(week.previous_range, { from: '2025-12-29', to: '2026-01-04' });
    assert.equal(week.rows.length, 7);

    const year = await explore(base, s, { from: '2026-01-01', to: '2026-12-31' });
    assert.equal(year.bucket, 'month');
    assert.equal(year.rows.length, 12);
    assert.equal(year.rows[0].key, '2026-01-01T00:00');
  });
});

test('bad ranges and mixed filters are refused with a sentence', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const bad = async (q, re) => {
      const r = await fetch(`${base}/api/analytics?${new URLSearchParams(q)}`, { headers: s.h });
      assert.equal(r.status, 400, JSON.stringify(q));
      assert.match((await json(r)).error, re);
    };
    await bad({ from: '2026-02-01', to: '2026-01-01' }, /before the start/);
    await bad({ from: 'yesterday', to: '2026-01-01' }, /YYYY-MM-DD/);
    await bad({ from: '2026-01-01', to: '2026-03-01', bucket: 'hour' }, /too long to show by hour/);
    await bad({ from: '2026-01-01', to: '2026-01-02', method: 'Cash', category: '1' }, /not both/);
    await bad({ from: '2026-01-01', to: '2026-01-02', method: 'Bitcoin' }, /unknown payment method/);
  });
});
