const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');

/* Regression tests for the card-mode follow-ups (reviewer's items after
   PR #16 re-check 3). Races fire the conflicting requests concurrently, 40
   iterations each. */

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


const auditId = async (db, action, orderId) => (await db.query(
  'SELECT max(id)::int AS id FROM audit_log WHERE action = $1 AND entity_id = $2', [action, orderId])).rows[0].id;

/* ===== R1: a cash refund racing shift close ===== */

test('R1 a cash refund racing shift close never lands in the closed shift after its expected cash froze: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, (i % 50) + 1, one(s.roti));
      assert.equal((await post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' })).status, 200);
      const paymentId = (await db.query('SELECT id FROM payments WHERE order_id = $1', [id])).rows[0].id;
      const shift = await get(base, s, '/api/shift/current');
      const [refunded, closed] = await Promise.all([
        post(base, s, `/api/orders/${id}/refunds`, { payment_id: paymentId, amount: 2.10, reason: 'customer returned it' }),
        post(base, s, '/api/shift/close', { counted: 0, note: 'race test' }),
      ]);
      assert.ok(refunded.status < 500 && closed.status < 500, `run ${i}: ${refunded.status}/${closed.status}`);
      const row = (await db.query('SELECT * FROM shifts WHERE id = $1', [shift.id])).rows[0];
      const cashIn = (await db.query(
        "SELECT COALESCE(SUM(amount_cents), 0)::int s FROM payments WHERE shift_id = $1 AND method = 'Cash'", [shift.id])).rows[0].s;
      const cashOut = (await db.query(
        `SELECT COALESCE(SUM(r.amount_cents), 0)::int s FROM refunds r JOIN payments p ON p.id = r.payment_id
          WHERE r.shift_id = $1 AND p.method = 'Cash'`, [shift.id])).rows[0].s;
      assert.equal(row.expected_cents, row.float_cents + cashIn - cashOut,
        `run ${i}: a cash refund landed in shift ${shift.id} after its expected cash was frozen`);
      await post(base, s, '/api/shift/open', { float: 0 });
    }
  });
});

/* ===== M1/M2: a move racing a payment ===== */

// A move that succeeded must have happened while the bill was open: its audit
// row (written in the move's own transaction) comes before the payment's.
async function assertMoveNotAfterPay(db, id, moved, label, cardBefore) {
  if (moved.status !== 200) {
    // 400 when the bill was already closed before the move looked at it,
    // 409 when it closed while the move waited for the lock.
    assert.ok([400, 409].includes(moved.status), `${label}: a move on a closed bill is refused (got ${moved.status})`);
    assert.equal((await orderRow(db, id)).card_id, cardBefore, `${label}: the refused move left the card alone`);
    return;
  }
  const moveId = await auditId(db, 'order.move', id);
  const payId = await auditId(db, 'order.pay', id);
  assert.ok(moveId < payId, `${label}: the move rewrote a bill that was already paid`);
}

test('M1 moving a card order racing its payment never relabels the paid bill: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, i + 1, one(s.roti));
      const [paid, moved] = await Promise.all([
        post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }),
        post(base, s, `/api/orders/${id}/move`, { card_id: s.card(i + 61).id }),
      ]);
      assert.equal(paid.status, 200, `run ${i}: pay`);
      await assertMoveNotAfterPay(db, id, moved, `run ${i}`, s.card(i + 1).id);
    }
  });
});

test('M2 moving a takeaway onto a card racing its payment never turns the paid takeaway dine-in: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 40; i++) {
      const id = (await json(await post(base, s, '/api/orders', { order_type: 'takeaway', items: one(s.roti) }))).id;
      const [paid, moved] = await Promise.all([
        post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }),
        post(base, s, `/api/orders/${id}/move`, { card_id: s.card((i % 50) + 1).id }),
      ]);
      assert.equal(paid.status, 200, `run ${i}: pay`);
      await assertMoveNotAfterPay(db, id, moved, `run ${i}`, null);
      if (moved.status !== 200) assert.equal((await orderRow(db, id)).order_type, 'takeaway', `run ${i}: still a takeaway`);
    }
  });
});

test('the database refuses to change a closed order\'s location or money; paid -> refunded still works', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, one(s.roti));
    await post(base, s, `/api/orders/${a}/pay`, { method: 'Card' });
    for (const [sql, args] of [
      ['UPDATE orders SET card_id = $2 WHERE id = $1', [a, s.card(9).id]],
      ["UPDATE orders SET order_type = 'takeaway', card_id = NULL WHERE id = $1", [a]],
      ['UPDATE orders SET table_id = 1 WHERE id = $1', [a]],
      ['UPDATE orders SET total_cents = 0 WHERE id = $1', [a]],
      ['UPDATE orders SET subtotal_cents = subtotal_cents + 1 WHERE id = $1', [a]],
      ['UPDATE orders SET rounding_cents = 5 WHERE id = $1', [a]],
      ['UPDATE orders SET tax_rate_bp = 0 WHERE id = $1', [a]],
    ]) {
      await assert.rejects(db.query(sql, args), /cannot/, sql);
    }
    const row = await orderRow(db, a);
    assert.equal(row.card_id, s.card(1).id);
    assert.equal(row.total_cents, 212);

    // paid -> refunded, through the real route, still works and changes no money.
    const paymentId = (await db.query('SELECT id FROM payments WHERE order_id = $1', [a])).rows[0].id;
    assert.equal((await post(base, s, `/api/orders/${a}/refunds`, { payment_id: paymentId, amount: 2.12, reason: 'returned it' })).status, 200);
    const after = await orderRow(db, a);
    assert.equal(after.status, 'refunded');
    assert.equal(after.total_cents, 212);
    await assert.rejects(db.query('UPDATE orders SET card_id = NULL WHERE id = $1', [a]), /cannot/);
  });
});

/* ===== Nits: net paid, not "any payment row" ===== */

test('a card whose part-payment was refunded in full can take more items again', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const id = await openCard(base, s, 3, [{ item_id: s.roti.id, qty: 3 }]);
    await post(base, s, `/api/orders/${id}/pay`, { method: 'Card', amount: 2 });
    const paymentId = (await db.query('SELECT id FROM payments WHERE order_id = $1', [id])).rows[0].id;
    await post(base, s, `/api/orders/${id}/refunds`, { payment_id: paymentId, amount: 2, reason: 'wrong card' });
    const r = await post(base, s, `/api/orders/${id}/items`, { items: one(s.teh) });
    assert.equal(r.status, 200, 'nothing is paid net of refunds, so items can be added');
    await assertOrderBalances(db, id, 'after adding');
  });
});

test('a combined bill whose only payment was refunded in full can be un-combined', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, [{ item_id: s.roti.id, qty: 3 }]);
    const b = await openCard(base, s, 2, one(s.roti));
    await post(base, s, `/api/orders/${a}/pay`, { method: 'Card', amount: 2 });
    const paymentId = (await db.query('SELECT id FROM payments WHERE order_id = $1', [a])).rows[0].id;
    await post(base, s, `/api/orders/${a}/refunds`, { payment_id: paymentId, amount: 2, reason: 'wrong card' });
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));
    const r = await del(base, s, `/api/bill-groups/${g.id}`);
    assert.equal(r.status, 200, 'a refunded payment is not a payment on the combined bill');
    assert.equal((await orderRow(db, a)).bill_group_id, null);
  });
});

test('non-numeric bill-group ids are 404, not 500', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, one(s.roti));
    const b = await openCard(base, s, 2, one(s.roti));
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));
    const statuses = [
      (await fetch(`${base}/api/bill-groups/abc`, { headers: s.h })).status,
      (await del(base, s, '/api/bill-groups/abc')).status,
      (await del(base, s, `/api/bill-groups/${g.id}/orders/abc`)).status,
      (await del(base, s, '/api/bill-groups/abc/orders/1')).status,
      (await post(base, s, '/api/bill-groups/abc/pay', { legs: [{ method: 'Cash' }] })).status,
      (await fetch(`${base}/api/bill-groups/1.5`, { headers: s.h })).status,
    ];
    assert.deepEqual(statuses, [404, 404, 404, 404, 404, 404]);
  });
});
