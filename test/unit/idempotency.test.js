const path = require('path');
const crypto = require('crypto');
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
async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  return (await json(r)).token;
}
function headers(token, idemKey) {
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (idemKey) h['idempotency-key'] = idemKey;
  return h;
}

// Common fixture: the seeded admin (allowed to create orders directly, so no
// separate staff user is needed for these tests), two tables, two menu items.
async function setup(base) {
  const adminToken = await login(base, 'Admin', '1234');
  const menu = await json(await fetch(`${base}/api/menu`, { headers: headers(adminToken) }));
  const tables = await json(await fetch(`${base}/api/tables`, { headers: headers(adminToken) }));
  return {
    adminToken,
    tableId: tables[0].id, tableId2: tables[1].id,
    itemA: menu.items.find(i => i.name === 'Roti Canai'),
    itemB: menu.items.find(i => i.name === 'Teh Tarik'),
  };
}

test('same Idempotency-Key on POST /api/orders twice -> one order row, both responses carry the same id', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const key = crypto.randomUUID();
    const body = JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.itemA.id, qty: 1 }] });

    const r1 = await fetch(`${base}/api/orders`, { method: 'POST', headers: headers(s.adminToken, key), body });
    const b1 = await json(r1);
    assert.equal(r1.status, 201);

    const r2 = await fetch(`${base}/api/orders`, { method: 'POST', headers: headers(s.adminToken, key), body });
    const b2 = await json(r2);
    assert.equal(r2.status, 200);
    assert.deepEqual(b2, b1);

    const rows = await db.query('SELECT id FROM orders WHERE idempotency_key = $1', [key]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].id, b1.id);
  });
});

test('concurrent POST /api/orders with the same Idempotency-Key -> one row, no 500', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const key = crypto.randomUUID();
    const body = JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.itemA.id, qty: 1 }] });

    const [r1, r2] = await Promise.all([
      fetch(`${base}/api/orders`, { method: 'POST', headers: headers(s.adminToken, key), body }),
      fetch(`${base}/api/orders`, { method: 'POST', headers: headers(s.adminToken, key), body }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 201]);

    const [b1, b2] = await Promise.all([json(r1), json(r2)]);
    assert.equal(b1.id, b2.id);

    const rows = await db.query('SELECT id FROM orders WHERE idempotency_key = $1', [key]);
    assert.equal(rows.rows.length, 1);
  });
});

test('POST /api/orders/:id/items with a repeated Idempotency-Key does not duplicate lines', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const created = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: headers(s.adminToken),
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.itemA.id, qty: 1 }] }),
    }));

    const key = crypto.randomUUID();
    const appendBody = JSON.stringify({ items: [{ item_id: s.itemB.id, qty: 2 }] });

    const r1 = await fetch(`${base}/api/orders/${created.id}/items`, { method: 'POST', headers: headers(s.adminToken, key), body: appendBody });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${base}/api/orders/${created.id}/items`, { method: 'POST', headers: headers(s.adminToken, key), body: appendBody });
    assert.equal(r2.status, 200);

    const rows = await db.query('SELECT * FROM order_items WHERE order_id = $1 AND item_id = $2', [created.id, s.itemB.id]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].qty, 2);
  });
});

test('an Idempotency-Key is scoped to its route: reusing a create key on an unrelated append is not confused', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const key = crypto.randomUUID();

    await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: headers(s.adminToken, key),
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.itemA.id, qty: 1 }] }),
    }));
    const other = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: headers(s.adminToken),
      body: JSON.stringify({ table_id: s.tableId2, items: [{ item_id: s.itemA.id, qty: 1 }] }),
    }));

    // Reusing the CREATE key as the APPEND key on a different order must not
    // be mistaken for the earlier create — order_items.idempotency_key is a
    // separate namespace (a separate table + unique index) from orders'.
    const r = await fetch(`${base}/api/orders/${other.id}/items`, {
      method: 'POST', headers: headers(s.adminToken, key),
      body: JSON.stringify({ items: [{ item_id: s.itemB.id, qty: 1 }] }),
    });
    assert.equal(r.status, 200);

    const rows = await db.query('SELECT * FROM order_items WHERE order_id = $1 AND item_id = $2', [other.id, s.itemB.id]);
    assert.equal(rows.rows.length, 1);
  });
});
