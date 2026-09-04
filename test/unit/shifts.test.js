const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');

const SRC_DIR = path.join(__dirname, '..', '..', 'src') + path.sep;
const DB_MODULE = require.resolve('../../src/db');
const SERVER_MODULE = require.resolve('../../src/server');

function clearSrcCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR) && key !== DB_MODULE) delete require.cache[key];
  }
}

async function waitReady(base, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try { await fetch(`${base}/api/menu`); return; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error(`server at ${base} never became ready`);
}

async function startApp() {
  const port = await getFreePort();
  process.env.PORT = String(port);
  process.env.ADMIN_PIN = '1234';
  clearSrcCache();
  require(SERVER_MODULE);
  const base = `http://localhost:${port}`;
  await waitReady(base);
  return base;
}

async function json(res) { return res.json(); }
// Phase 11: sessions are an httpOnly cookie, not a bearer token — node's
// fetch happily sends a manually-set Cookie header (it isn't a browser
// sandbox), so tests carry the session by hand instead of a cookie jar.
async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  const body = await json(r);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrfToken: body.csrf_token };
}
function auth(session) {
  return { cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
}

async function setup(base) {
  const adminToken = await login(base, 'Admin', '1234');
  const adminAuth = auth(adminToken);
  const menu = await json(await fetch(`${base}/api/menu`, { headers: adminAuth }));
  const tables = await json(await fetch(`${base}/api/tables`, { headers: adminAuth }));
  return {
    adminAuth,
    tableId: tables[0].id, tableId2: tables[1].id,
    itemA: menu.items.find(i => i.name === 'Roti Canai'),
  };
}

async function createOrder(base, s, tableId, itemId, qty = 1) {
  const r = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: s.adminAuth,
    body: JSON.stringify({ table_id: tableId, items: [{ item_id: itemId, qty }] }),
  });
  return json(r);
}

async function pay(base, s, orderId, body) {
  const r = await fetch(`${base}/api/orders/${orderId}/pay`, { method: 'POST', headers: s.adminAuth, body: JSON.stringify(body) });
  return { status: r.status, body: await json(r) };
}

async function openShift(base, s, floatRM = 0) {
  const r = await fetch(`${base}/api/shift/open`, { method: 'POST', headers: s.adminAuth, body: JSON.stringify({ float: floatRM }) });
  return { status: r.status, body: await json(r) };
}

async function report(base, s, shiftId, final = false) {
  const r = await fetch(`${base}/api/shift/${shiftId}/report${final ? '?final=1' : ''}`, { headers: s.adminAuth });
  return json(r);
}

test('opening a second shift while one is open -> 409 (the DB index enforces it)', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const first = await openShift(base, s, 100);
    assert.equal(first.status, 201);
    const second = await openShift(base, s, 50);
    assert.equal(second.status, 409);
  });
});

test('payment with no open shift -> 400', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const order = await createOrder(base, s, s.tableId, s.itemA.id, 1);
    const r = await pay(base, s, order.id, { method: 'Cash' });
    assert.equal(r.status, 400);
  });
});

test('expected cash = float + cash sales + payins - payouts; card sales excluded', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const opened = await openShift(base, s, 50); // RM 50.00 float
    const shiftId = opened.body.id;

    // Cash sale: 3x Roti Canai (200 each) -> subtotal 600, tax 6% -> 636, cash-rounded to 635.
    const cashOrder = await createOrder(base, s, s.tableId, s.itemA.id, 3);
    const cashPay = await pay(base, s, cashOrder.id, { method: 'Cash' });
    assert.equal(cashPay.status, 200);
    assert.equal(cashPay.body.bill.total, 6.35);

    // Card sale: 1x Roti Canai -> subtotal 200, tax 12, total 212. Must not count as cash.
    const cardOrder = await createOrder(base, s, s.tableId2, s.itemA.id, 1);
    const cardPay = await pay(base, s, cardOrder.id, { method: 'Card' });
    assert.equal(cardPay.status, 200);

    await fetch(`${base}/api/shift/movements`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'payin', amount: 20, reason: 'top up float' }),
    });
    await fetch(`${base}/api/shift/movements`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'payout', amount: 5, reason: 'bought ice' }),
    });

    const rep = await report(base, s, shiftId);
    // 5000 (float) + 635 (cash sale) + 2000 (payin) - 500 (payout) = 7135; the 212-cent
    // card sale must NOT appear here.
    assert.equal(rep.cash.expected_cents, 7135);
    assert.equal(rep.cash.cash_sales_cents, 635);
    assert.equal(rep.cash.payins_cents, 2000);
    assert.equal(rep.cash.payouts_cents, 500);
  });
});

test('variance sign: counted less than expected -> negative', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const opened = await openShift(base, s, 100); // RM 100 float, no sales -> expected = 10000 cents
    const shiftId = opened.body.id;

    const r = await fetch(`${base}/api/shift/close`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ counted: 95, note: 'counted RM5 short' }),
    });
    assert.equal(r.status, 200);
    const closed = await json(r);
    assert.equal(closed.expected_cents, 10000);
    assert.equal(closed.counted_cents, 9500);
    assert.equal(closed.variance_cents, -500);

    const rep = await report(base, s, shiftId, true);
    assert.equal(rep.cash.variance_cents, -500);
  });
});

test("a closed shift's stored figures do not change when later orders are added", async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const opened = await openShift(base, s, 0);
    const shiftId = opened.body.id;

    const order1 = await createOrder(base, s, s.tableId, s.itemA.id, 1);
    await pay(base, s, order1.id, { method: 'Cash' });

    const before = await report(base, s, shiftId);
    const closeR = await fetch(`${base}/api/shift/close`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ counted: before.cash.expected_cents / 100 }),
    });
    assert.equal(closeR.status, 200);

    const snapshot = await report(base, s, shiftId, true);

    // A second shift transacts more sales against the *same* table/item.
    const reopened = await openShift(base, s, 0);
    assert.equal(reopened.status, 201);
    const order2 = await createOrder(base, s, s.tableId2, s.itemA.id, 5);
    await pay(base, s, order2.id, { method: 'Cash' });

    const again = await report(base, s, shiftId, true);
    assert.deepEqual(again, snapshot);
  });
});

test('month-boundary: 23:30 KL on the last day of a month stays in that month; 00:30 KL on the first lands in the next', async () => {
  await withDb(async db => {
    // 2024-01-31 23:30 Asia/Kuala_Lumpur (UTC+8) == 2024-01-31 15:30 UTC.
    // 2024-02-01 00:30 Asia/Kuala_Lumpur == 2024-01-31 16:30 UTC — one hour later
    // in UTC, but across a month boundary in KL local time. This is exactly the
    // condition audit #22's bug got wrong: comparing a local (tz-naive) timestamp
    // against a value re-cast to ::timestamptz reintroduces a timezone (the
    // session's, not KL) and can shift a near-midnight payment into the wrong
    // month. The fixed query (routes/reports.js) never compares a local timestamp
    // against a ::timestamptz value — this exercises that exact pattern directly.
    const lastMinuteOfJan = '2024-01-31T15:30:00Z';
    const firstMinuteOfFeb = '2024-01-31T16:30:00Z';

    const r = await db.query(
      `SELECT
         date_trunc('month', $1::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur') = date_trunc('month', DATE '2024-01-01'::timestamp) AS jan_stays_in_jan,
         date_trunc('month', $2::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur') = date_trunc('month', DATE '2024-02-01'::timestamp) AS feb_lands_in_feb`,
      [lastMinuteOfJan, firstMinuteOfFeb]);

    assert.equal(r.rows[0].jan_stays_in_jan, true);
    assert.equal(r.rows[0].feb_lands_in_feb, true);
  });
});
