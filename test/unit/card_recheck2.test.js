const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');

/* Regression tests for the PR #16 re-check 2 (at 8a70b80). Each reproduces the
   finding through the real routes; the races fire the conflicting requests
   concurrently, 40 iterations each. */

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

const json = res => res.json();

async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  const body = await json(r);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrfToken: body.csrf_token };
}
const auth = s => ({ cookie: s.cookie, 'x-csrf-token': s.csrfToken, 'content-type': 'application/json' });

async function setup(base) {
  const h = auth(await login(base, 'Admin', '1234'));
  await fetch(`${base}/api/shift/open`, { method: 'POST', headers: h, body: JSON.stringify({ float: 0 }) });
  const menu = await json(await fetch(`${base}/api/menu`, { headers: h }));
  const cards = await json(await fetch(`${base}/api/admin/cards`, { headers: h }));
  const byName = n => menu.items.find(i => i.name === n);
  const card = n => cards.find(c => c.number === n);
  return { h, cards, card, roti: byName('Roti Canai'), teh: byName('Teh Tarik'), mee: byName('Mee Goreng Mamak') };
}

const post = (base, s, url, body) => fetch(`${base}${url}`, { method: 'POST', headers: s.h, body: JSON.stringify(body || {}) });
const patch = (base, s, url, body) => fetch(`${base}${url}`, { method: 'PATCH', headers: s.h, body: JSON.stringify(body || {}) });
const del = (base, s, url) => fetch(`${base}${url}`, { method: 'DELETE', headers: s.h });
const get = async (base, s, url) => json(await fetch(`${base}${url}`, { headers: s.h }));
const publicOrder = (base, body) => fetch(`${base}/api/public/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function openCard(base, s, number, items) {
  const r = await post(base, s, '/api/orders', { card_id: s.card(number).id, items });
  assert.equal(r.status, 201, `opening Card ${number}`);
  return (await json(r)).id;
}
const one = item => [{ item_id: item.id, qty: 1 }];
const orderRow = (db, id) => db.query('SELECT * FROM orders WHERE id = $1', [id]).then(r => r.rows[0]);
const lineIds = async (db, id) => (await db.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id', [id])).rows.map(r => r.id);
const groupAudit = async (db, groupId) => (await db.query(
  "SELECT action FROM audit_log WHERE entity_type = 'bill_group' AND entity_id = $1 ORDER BY id", [groupId])).rows.map(r => r.action);

/* The books balance on one order: the stored subtotal is exactly its live,
   accepted lines, and a paid order's payments (net of refunds) are exactly its
   total. Items that slipped onto a paid bill, or a bill recomputed after it was
   paid, break one of these. */
async function assertOrderBalances(db, id, label) {
  const o = await orderRow(db, id);
  const lines = (await db.query(
    `SELECT COALESCE(SUM(oi.price_cents * oi.qty), 0)::int s FROM order_items oi
       LEFT JOIN order_sends se ON se.id = oi.send_id
      WHERE oi.order_id = $1 AND oi.voided_at IS NULL AND (se.id IS NULL OR se.approval_state = 'approved')`, [id])).rows[0].s;
  assert.equal(o.subtotal_cents, lines, `${label}: the bill is exactly its lines`);
  if (o.status === 'paid') {
    const paid = (await db.query('SELECT COALESCE(SUM(amount_cents), 0)::int s FROM payments WHERE order_id = $1', [id])).rows[0].s;
    assert.equal(paid, o.total_cents, `${label}: a paid order's payments equal its total`);
  }
}


const HELD = 'A customer order is waiting for approval — approve or reject it first.';
const status = r => r.status;

// Enough cards for 40 iterations of three each.
async function manyCards(base, s) {
  assert.equal((await patch(base, s, '/api/admin/cards/count', { count: 130 })).status, 200);
  const cards = await json(await fetch(`${base}/api/admin/cards`, { headers: s.h }));
  s.card = n => cards.find(c => c.number === n);
}


async function ticketFor(base, s, orderId) {
  const all = await get(base, s, '/api/kitchen/tickets?station=kitchen');
  return all.tickets.find(t => t.order_id === orderId);
}

async function toReadyByTicket(base, s, orderId) {
  const t = await ticketFor(base, s, orderId);
  for (const st of ['preparing', 'ready']) {
    assert.equal((await patch(base, s, `/api/kitchen/tickets/${t.id}`, { status: st })).status, 200);
  }
  return t.id;
}

async function assertClosedAndFree(base, s, db, id, label) {
  const row = await orderRow(db, id);
  assert.equal(row.status, 'paid', `${label}: the paid bill was reopened as '${row.status}'`);
  const card = (await get(base, s, '/api/cards')).find(c => c.id === row.card_id);
  assert.equal(card.in_use, false, `${label}: the card is stuck in use`);
  await assertOrderBalances(db, id, label);
}

/* ===== K: a status tap racing a payment ===== */

test('K1 kitchen ticket tap racing a card payment never reopens the paid bill: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, (i % 50) + 1, one(s.roti));
      const ticketId = await toReadyByTicket(base, s, id);
      const [tap, paid] = await Promise.all([
        patch(base, s, `/api/kitchen/tickets/${ticketId}`, { status: 'served' }),
        post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }),
      ]);
      assert.ok(tap.status < 500 && paid.status === 200, `run ${i}: ${tap.status}/${paid.status}`);
      await assertClosedAndFree(base, s, db, id, `run ${i}`);
    }
  });
});

test('K2 order status tap racing a card payment never reopens the paid bill: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, (i % 50) + 1, one(s.roti));
      for (const st of ['preparing', 'ready']) assert.equal((await patch(base, s, `/api/orders/${id}`, { status: st })).status, 200);
      const [tap, paid] = await Promise.all([
        patch(base, s, `/api/orders/${id}`, { status: 'served' }),
        post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }),
      ]);
      assert.ok(tap.status < 500 && paid.status === 200, `run ${i}: ${tap.status}/${paid.status}`);
      await assertClosedAndFree(base, s, db, id, `run ${i}`);
    }
  });
});

test('K3 kitchen ticket tap racing a combined-bill payment never reopens a member: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    for (let i = 0; i < 40; i++) {
      const a = await openCard(base, s, 2 * i + 1, one(s.roti));
      const b = await openCard(base, s, 2 * i + 2, one(s.roti));
      const ticketId = await toReadyByTicket(base, s, a);
      const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));
      const [tap, paid] = await Promise.all([
        patch(base, s, `/api/kitchen/tickets/${ticketId}`, { status: 'served' }),
        post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: 4.24 }] }),
      ]);
      assert.ok(tap.status < 500 && paid.status === 200, `run ${i}: ${tap.status}/${paid.status}`);
      for (const id of [a, b]) await assertClosedAndFree(base, s, db, id, `run ${i} order ${id}`);
      assert.ok((await db.query('SELECT closed_at FROM bill_groups WHERE id = $1', [g.id])).rows[0].closed_at);
    }
  });
});

/* ===== S1: shift close racing a cash payment ===== */

test('S1 a cash payment racing shift close never lands outside the frozen expected cash: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);   // opens shift 1
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, (i % 50) + 1, one(s.roti));
      const shift = await get(base, s, '/api/shift/current');
      const [paid, closed] = await Promise.all([
        post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' }),
        post(base, s, '/api/shift/close', { counted: 0, note: 'race test' }),
      ]);
      assert.ok(paid.status < 500 && closed.status < 500, `run ${i}: ${paid.status}/${closed.status}`);
      const row = (await db.query('SELECT * FROM shifts WHERE id = $1', [shift.id])).rows[0];
      const cash = (await db.query(
        "SELECT COALESCE(SUM(amount_cents), 0)::int s FROM payments WHERE shift_id = $1 AND method = 'Cash'", [shift.id])).rows[0].s;
      assert.equal(row.expected_cents, row.float_cents + cash, `run ${i}: a cash payment landed in shift ${shift.id} after its expected cash was frozen`);
      await post(base, s, '/api/shift/open', { float: 0 });
      if ((await orderRow(db, id)).status !== 'paid') await post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' });
    }
  });
});

/* ===== X1: cancel racing a kitchen tap ===== */

test('X1 cancelling an order while the kitchen taps its ticket never deadlocks: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, (i % 50) + 1, one(s.roti));
      const t = await ticketFor(base, s, id);
      const [cancelled, tap] = await Promise.all([
        patch(base, s, `/api/orders/${id}`, { status: 'cancelled' }),
        patch(base, s, `/api/kitchen/tickets/${t.id}`, { status: 'preparing' }),
      ]);
      assert.ok(cancelled.status < 500 && tap.status < 500, `run ${i}: cancel ${cancelled.status} / tap ${tap.status}`);
      assert.equal((await orderRow(db, id)).status, 'cancelled', `run ${i}`);
    }
  });
});

/* ===== Safety net: closed bills stay closed ===== */

test('the database refuses to move a paid order back to a cooking status; paid -> refunded still works', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, one(s.roti));
    const b = await openCard(base, s, 2, one(s.roti));
    for (const id of [a, b]) await post(base, s, `/api/orders/${id}/pay`, { method: 'Card' });

    await assert.rejects(db.query("UPDATE orders SET status = 'served' WHERE id = $1", [a]), /cannot become served/);
    await assert.rejects(db.query("UPDATE orders SET status = 'sent' WHERE id = $1", [a]), /cannot become sent/);
    assert.equal((await orderRow(db, a)).status, 'paid');

    await db.query("UPDATE orders SET status = 'refunded' WHERE id = $1", [a]);
    assert.equal((await orderRow(db, a)).status, 'refunded');
    await assert.rejects(db.query("UPDATE orders SET status = 'paid' WHERE id = $1", [a]), /cannot become paid/);

    // And the real refund route still gets a paid order to 'refunded'.
    const paymentId = (await db.query('SELECT id FROM payments WHERE order_id = $1', [b])).rows[0].id;
    const r = await post(base, s, `/api/orders/${b}/refunds`, { payment_id: paymentId, amount: 2.12, reason: 'returned it' });
    assert.equal(r.status, 200);
    assert.equal((await orderRow(db, b)).status, 'refunded');
  });
});

/* ===== #3 nit: a fully refunded card can be combined ===== */

test('a card whose own payment was refunded in full can be combined', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, [{ item_id: s.roti.id, qty: 3 }]);
    const b = await openCard(base, s, 2, one(s.roti));
    await post(base, s, `/api/orders/${a}/pay`, { method: 'Card', amount: 2 });
    const paymentId = (await db.query('SELECT id FROM payments WHERE order_id = $1', [a])).rows[0].id;
    assert.equal((await post(base, s, `/api/orders/${a}/refunds`, { payment_id: paymentId, amount: 2, reason: 'wrong card' })).status, 200);
    const r = await post(base, s, '/api/bill-groups', { order_ids: [a, b] });
    assert.equal(r.status, 201, 'pay-or-refund means refunded is enough');
    const g = await json(r);
    assert.equal(g.amount_due, 8.48, '6.36 + 2.12: the refunded RM2 is owed again');
  });
});
