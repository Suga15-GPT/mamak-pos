const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const { splitEvenly } = require('../../src/services/billing');

const SRC_DIR = path.join(__dirname, '..', '..', 'src') + path.sep;
const DB_MODULE = require.resolve('../../src/db');
const SERVER_MODULE = require.resolve('../../src/server');

function randomPort() { return 20000 + Math.floor(Math.random() * 30000); }

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
  const port = randomPort();
  process.env.PORT = String(port);
  process.env.ADMIN_PIN = '1234';
  clearSrcCache();
  require(SERVER_MODULE);
  const base = `http://localhost:${port}`;
  await waitReady(base);
  return base;
}

async function json(res) { return res.json(); }
async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  return (await json(r)).token;
}
function auth(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }

async function setup(base) {
  const adminToken = await login(base, 'Admin', '1234');
  const adminAuth = auth(adminToken);
  const staffId = (await json(await fetch(`${base}/api/admin/users`, {
    method: 'POST', headers: adminAuth, body: JSON.stringify({ name: 'Staffer', role: 'staff', pin: '1111' }),
  }))).id;
  const staffToken = await login(base, 'Staffer', '1111');
  const menu = await json(await fetch(`${base}/api/menu`, { headers: adminAuth }));
  const tables = await json(await fetch(`${base}/api/tables`, { headers: adminAuth }));
  return {
    adminAuth, staffAuth: auth(staffToken), staffId,
    tableId: tables[0].id, tableId2: tables[1].id, tableId3: tables[2].id,
    itemA: menu.items.find(i => i.name === 'Roti Canai'),
  };
}

async function createOrder(base, s, tableId, itemId, qty = 1) {
  const r = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: s.staffAuth,
    body: JSON.stringify({ table_id: tableId, items: [{ item_id: itemId, qty }] }),
  });
  return { status: r.status, body: await json(r) };
}

/* ===== splitEvenly: pure function ===== */

test('splitEvenly divides, floors, and distributes the remainder — never loses or invents a sen', () => {
  const s3 = splitEvenly(1000, 3);
  assert.deepEqual(s3, [334, 333, 333]);
  assert.equal(s3.reduce((a, b) => a + b, 0), 1000);

  const s7 = splitEvenly(1000, 7);
  assert.deepEqual(s7, [143, 143, 143, 143, 143, 143, 142]);
  assert.equal(s7.reduce((a, b) => a + b, 0), 1000);

  const s6 = splitEvenly(1000, 6);
  assert.deepEqual(s6, [167, 167, 167, 167, 166, 166]);
  assert.equal(s6.reduce((a, b) => a + b, 0), 1000);
});

/* ===== integration ===== */

test('two partial payments settling exactly -> order becomes paid, amountDue 0', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 3); // subtotal 600, tax 600bp -> 36, total 636

    const total = (await db.query('SELECT total_cents FROM orders WHERE id = $1', [orderId])).rows[0].total_cents;
    const half1 = Math.floor(total / 2);
    const half2 = total - half1;

    const r1 = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: half1 / 100 }),
    });
    assert.equal(r1.status, 200);
    const b1 = await json(r1);
    assert.equal(b1.settled, false);
    assert.equal(b1.remaining, half2 / 100);

    const r2 = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: half2 / 100 }),
    });
    assert.equal(r2.status, 200);
    const b2 = await json(r2);
    assert.equal(b2.settled, true);
    assert.equal(b2.remaining, 0);

    const row = (await db.query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'paid');
  });
});

test('payment exceeding due by cash -> change due correct; by card -> 400', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    // Cash: tender RM20 against a RM6.36 (unrounded) / RM6.35 (cash-rounded) due.
    const { body: { id: cashOrder } } = await createOrder(base, s, s.tableId, s.itemA.id, 3);
    const rCash = await fetch(`${base}/api/orders/${cashOrder}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Cash', tendered: 20 }),
    });
    assert.equal(rCash.status, 200);
    const bCash = await json(rCash);
    assert.equal(bCash.settled, true);
    assert.equal(bCash.bill.total, 6.35);
    assert.equal(bCash.change, 13.65);

    // Card: requesting to apply more than the due amount is rejected outright — a
    // card terminal can't "overpay" the way handing over cash notes can.
    const { body: { id: cardOrder } } = await createOrder(base, s, s.tableId2, s.itemA.id, 1); // total 2.12
    const rCard = await fetch(`${base}/api/orders/${cardOrder}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: 10 }),
    });
    assert.equal(rCard.status, 400);
  });
});

test('adding a line to an order with a payment -> 409', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 1);

    const partial = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: 1 }),
    });
    assert.equal(partial.status, 200);
    assert.equal((await json(partial)).settled, false);

    const append = await fetch(`${base}/api/orders/${orderId}/items`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ items: [{ item_id: s.itemA.id, qty: 1 }] }),
    });
    assert.equal(append.status, 409);
  });
});

test('percent discount 10% on RM 20.00 -> 200 cents off; tax still computed per §3', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 10); // subtotal 2000

    const r = await fetch(`${base}/api/orders/${orderId}/discounts`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'percent', value: 10, reason: 'loyalty promo' }),
    });
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.amount, 2.00); // 10% of RM20.00 subtotal

    const row = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.subtotal_cents, 2000);
    assert.equal(row.tax_cents, 120); // 6% of the undiscounted 2000, not of 1800
    assert.equal(row.discount_cents, 200);
    assert.equal(row.subtotal_cents + row.service_charge_cents + row.tax_cents - row.discount_cents, row.total_cents);
  });
});

test('comp -> total 0, order closes with no payment row required, audit row written', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 1);

    const r = await fetch(`${base}/api/orders/${orderId}/discounts`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'comp', value: 0, reason: 'burnt order, manager comp' }),
    });
    assert.equal(r.status, 200);

    const row = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'paid');
    assert.equal(row.total_cents, 0);

    // payments.amount_cents has a CHECK (amount_cents > 0), so a comp that zeroes
    // the balance closes the order without ever needing a payment row.
    const payments = await db.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    assert.equal(payments.rows.length, 0);

    const audit = await db.query("SELECT * FROM audit_log WHERE action = 'discount.apply' AND entity_id = $1", [orderId]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].detail.kind, 'comp');
  });
});
