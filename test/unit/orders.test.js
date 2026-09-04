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

async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  const body = await json(r);
  return body.token;
}

function auth(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }; }

// Common fixture: an admin (seeded), a staff and a kitchen user, one table, two menu items.
async function setup(base) {
  const adminToken = await login(base, 'Admin', '1234');
  const adminAuth = auth(adminToken);
  // Phase 09: a payment is refused unless a shift is open.
  await fetch(`${base}/api/shift/open`, { method: 'POST', headers: adminAuth, body: JSON.stringify({ float: 0 }) });

  const adminId = (await json(await fetch(`${base}/api/admin/users`, { headers: adminAuth }))).find(u => u.name === 'Admin').id;
  const staffId = (await json(await fetch(`${base}/api/admin/users`, {
    method: 'POST', headers: adminAuth, body: JSON.stringify({ name: 'Staffer', role: 'staff', pin: '1111' }),
  }))).id;
  const kitchenId = (await json(await fetch(`${base}/api/admin/users`, {
    method: 'POST', headers: adminAuth, body: JSON.stringify({ name: 'Cook', role: 'kitchen', pin: '2222' }),
  }))).id;

  const staffToken = await login(base, 'Staffer', '1111');
  const kitchenToken = await login(base, 'Cook', '2222');

  const menu = await json(await fetch(`${base}/api/menu`, { headers: adminAuth }));
  const tables = await json(await fetch(`${base}/api/tables`, { headers: adminAuth }));

  return {
    adminToken, staffToken, kitchenToken, adminId, staffId, kitchenId,
    adminAuth, staffAuth: auth(staffToken), kitchenAuth: auth(kitchenToken),
    tableId: tables[0].id, tableId2: tables[1].id,
    itemA: menu.items.find(i => i.name === 'Roti Canai'),
    itemB: menu.items.find(i => i.name === 'Teh Tarik'),
  };
}

async function createOrder(base, s, tableId, itemId, qty = 1) {
  const r = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: s.staffAuth,
    body: JSON.stringify({ table_id: tableId, items: [{ item_id: itemId, qty }] }),
  });
  return { status: r.status, body: await json(r) };
}

test('two concurrent POST /api/orders for one table -> one 201, one 409, one row', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    const [a, b] = await Promise.all([
      createOrder(base, s, s.tableId, s.itemA.id),
      createOrder(base, s, s.tableId, s.itemA.id),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    assert.equal(loser.body.order_id, winner.body.id);

    const rows = await db.query(
      "SELECT id FROM orders WHERE table_id = $1 AND status NOT IN ('paid','cancelled')", [s.tableId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].id, winner.body.id);
  });
});

test('voided line is excluded from the total but still returned by the API', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    const created = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.staffAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.itemA.id, qty: 1 }, { item_id: s.itemB.id, qty: 1 }] }),
    });
    const { id: orderId } = await json(created);

    const before = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === orderId);
    assert.equal(before.items.length, 2);
    const lineA = before.items.find(i => i.name === s.itemA.name);

    const voided = await fetch(`${base}/api/orders/${orderId}/items/${lineA.id}/void`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ reason: 'customer changed mind' }),
    });
    assert.equal(voided.status, 200);

    const after = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === orderId);
    assert.equal(after.items.length, 2, 'voided line is still returned by the API');
    const stillA = after.items.find(i => i.name === s.itemA.name);
    assert.equal(stillA.voided, true);
    assert.equal(stillA.void_reason, 'customer changed mind');
    // total drops to just item B's price
    assert.equal(after.total, s.itemB.price);
  });
});

test('void without a reason -> 400; void by kitchen role -> 403', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id);
    const items = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === orderId).items;
    const lineId = items[0].id;

    const noReason = await fetch(`${base}/api/orders/${orderId}/items/${lineId}/void`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({}),
    });
    assert.equal(noReason.status, 400);

    const byKitchen = await fetch(`${base}/api/orders/${orderId}/items/${lineId}/void`, {
      method: 'POST', headers: s.kitchenAuth, body: JSON.stringify({ reason: 'wrong order' }),
    });
    assert.equal(byKitchen.status, 403);
  });
});

test('staff voids a sent line (200); staff voids a preparing line (403); admin voids it (200)', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    // staff voids a still-'sent' line -> 200
    const { body: { id: order1 } } = await createOrder(base, s, s.tableId, s.itemA.id);
    const line1 = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === order1).items[0].id;
    const r1 = await fetch(`${base}/api/orders/${order1}/items/${line1}/void`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ reason: 'made a mistake' }),
    });
    assert.equal(r1.status, 200);

    // move a second order past 'sent', then staff may no longer void it
    const { body: { id: order2 } } = await createOrder(base, s, s.tableId2, s.itemA.id);
    const line2 = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === order2).items[0].id;
    const advanced = await fetch(`${base}/api/orders/${order2}`, {
      method: 'PATCH', headers: s.kitchenAuth, body: JSON.stringify({ status: 'preparing' }),
    });
    assert.equal(advanced.status, 200);

    const r2 = await fetch(`${base}/api/orders/${order2}/items/${line2}/void`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ reason: 'too late now' }),
    });
    assert.equal(r2.status, 403);

    const r3 = await fetch(`${base}/api/orders/${order2}/items/${line2}/void`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ reason: 'admin override' }),
    });
    assert.equal(r3.status, 200);
  });
});

test('every mutation writes exactly one audit_log row with the right user_id', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id);
    let rows = await db.query("SELECT * FROM audit_log WHERE action = 'order.create' AND entity_id = $1", [orderId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].user_id, s.staffId);

    await fetch(`${base}/api/orders/${orderId}/items`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ items: [{ item_id: s.itemB.id, qty: 1 }] }),
    });
    rows = await db.query("SELECT * FROM audit_log WHERE action = 'order.append' AND entity_id = $1", [orderId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].user_id, s.staffId);

    const lineId = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth })))
      .find(o => o.id === orderId).items.find(i => i.name === s.itemA.name).id;
    await fetch(`${base}/api/orders/${orderId}/items/${lineId}/void`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ reason: 'audit check' }),
    });
    rows = await db.query("SELECT * FROM audit_log WHERE action = 'order.void_line' AND entity_id = $1", [lineId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].user_id, s.staffId);

    await fetch(`${base}/api/orders/${orderId}`, {
      method: 'PATCH', headers: s.staffAuth, body: JSON.stringify({ status: 'preparing' }),
    });
    rows = await db.query("SELECT * FROM audit_log WHERE action = 'order.status' AND entity_id = $1", [orderId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].user_id, s.staffId);

    const paid = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ method: 'Card' }),
    });
    assert.equal(paid.status, 200);
    rows = await db.query("SELECT * FROM audit_log WHERE action = 'order.pay' AND entity_id = $1", [orderId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].user_id, s.adminId);

    const { body: { id: order2 } } = await createOrder(base, s, s.tableId2, s.itemA.id);
    const cancelled = await fetch(`${base}/api/orders/${order2}`, {
      method: 'PATCH', headers: s.adminAuth, body: JSON.stringify({ status: 'cancelled' }),
    });
    assert.equal(cancelled.status, 200);
    rows = await db.query("SELECT * FROM audit_log WHERE action = 'order.cancel' AND entity_id = $1", [order2]);
    assert.equal(rows.rows.length, 1);
  });
});

test('backward transition by kitchen -> 403; by staff -> 200', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id);
    const toPreparing = await fetch(`${base}/api/orders/${orderId}`, {
      method: 'PATCH', headers: s.staffAuth, body: JSON.stringify({ status: 'preparing' }),
    });
    assert.equal(toPreparing.status, 200);

    const byKitchen = await fetch(`${base}/api/orders/${orderId}`, {
      method: 'PATCH', headers: s.kitchenAuth, body: JSON.stringify({ status: 'sent' }),
    });
    assert.equal(byKitchen.status, 403);

    const byStaff = await fetch(`${base}/api/orders/${orderId}`, {
      method: 'PATCH', headers: s.staffAuth, body: JSON.stringify({ status: 'sent' }),
    });
    assert.equal(byStaff.status, 200);
  });
});
