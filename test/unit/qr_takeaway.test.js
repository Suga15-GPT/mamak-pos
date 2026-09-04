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
  const adminAuth = auth(await login(base, 'Admin', '1234'));
  await fetch(`${base}/api/shift/open`, { method: 'POST', headers: adminAuth, body: JSON.stringify({ float: 0 }) });
  const menu = await json(await fetch(`${base}/api/menu`, { headers: adminAuth }));
  const tables = await json(await fetch(`${base}/api/admin/tables`, { headers: adminAuth }));
  const byName = n => menu.items.find(i => i.name === n);
  return {
    adminAuth, tables,
    token: tables[0].qr_token, tableId: tables[0].id, tableName: tables[0].name,
    mee: byName('Mee Goreng Mamak'), teh: byName('Teh Tarik'), roti: byName('Roti Canai'),
  };
}

const publicOrder = (base, token, items) => fetch(`${base}/api/public/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ table_token: token, items }),
});

const openOrders = async (base, s) => json(await fetch(`${base}/api/orders`, { headers: s.adminAuth }));

const setSetting = (base, s, body) => fetch(`${base}/api/settings`, {
  method: 'PATCH', headers: s.adminAuth, body: JSON.stringify(body),
});

/* Master spec §54 */
test('a QR customer can order more: same bill, two rounds, round 2 SENT', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    const first = await publicOrder(base, s.token, [{ item_id: s.mee.id, qty: 1 }]);
    assert.equal(first.status, 201);
    const firstBody = await json(first);
    assert.equal(firstBody.round, 1);
    assert.equal(firstBody.status, 'sent');
    assert.ok(firstBody.ref, 'the customer gets an opaque round reference, never an order id');
    assert.equal(firstBody.order_id, undefined, 'no internal order id is leaked');

    // "Order more" — a second scan at the same table.
    const second = await publicOrder(base, s.token, [{ item_id: s.teh.id, qty: 1 }]);
    assert.equal(second.status, 201, 'a second QR order is appended, not rejected');
    const secondBody = await json(second);
    assert.equal(secondBody.round, 2);
    assert.equal(secondBody.status, 'sent');

    const orders = await openOrders(base, s);
    const forTable = orders.filter(o => o.table_id === s.tableId);
    assert.equal(forTable.length, 1, 'one dining order');
    const order = forTable[0];
    assert.equal(order.sends.length, 2, 'two rounds');
    assert.equal(order.sends[1].tickets[0].status, 'sent');
    assert.deepEqual(order.items.map(i => i.name).sort(), [s.mee.name, s.teh.name].sort(), 'both items billed');
    assert.equal(order.subtotal, s.mee.price + s.teh.price);

    // The customer can follow their own round without any login.
    const status = await json(await fetch(`${base}/api/public/sends/${secondBody.ref}`));
    assert.equal(status.round, 2);
    assert.equal(status.status, 'sent');
    assert.equal(status.table, s.tableName);
    assert.deepEqual(status.items, [{ name: s.teh.name, qty: 1 }]);
  });
});

/* Master spec §57 */
test('QR ordering can be paused, and pausing gives customers a friendly message', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    assert.equal((await setSetting(base, s, { qr_ordering_enabled: false })).status, 200);

    const info = await json(await fetch(`${base}/api/t/${s.token}`));
    assert.equal(info.ordering.enabled, false);
    assert.match(info.paused_message, /temporarily paused/i);

    const r = await publicOrder(base, s.token, [{ item_id: s.mee.id, qty: 1 }]);
    assert.equal(r.status, 503);
    const body = await json(r);
    assert.equal(body.error, 'ordering_paused');
    assert.match(body.message, /order with our staff/i);
    assert.equal((await openOrders(base, s)).length, 0, 'nothing reached the kitchen');

    // Turning it back on restores ordering.
    await setSetting(base, s, { qr_ordering_enabled: true });
    assert.equal((await publicOrder(base, s.token, [{ item_id: s.mee.id, qty: 1 }])).status, 201);
  });
});

/* Master spec §21 / §57 */
test('approval mode holds a QR round out of the kitchen until staff accept it', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    await setSetting(base, s, { qr_require_approval: true });

    const r = await publicOrder(base, s.token, [{ item_id: s.mee.id, qty: 1 }]);
    assert.equal(r.status, 201);
    const { ref } = await json(r);

    const customerView = await json(await fetch(`${base}/api/public/sends/${ref}`));
    assert.equal(customerView.status, 'pending');

    // Nothing is on a station display yet.
    const kitchen = await json(await fetch(`${base}/api/kitchen/tickets?station=kitchen`, { headers: s.adminAuth }));
    assert.equal(kitchen.tickets.length, 0, 'a pending round reaches no station');

    const pending = await json(await fetch(`${base}/api/kitchen/pending`, { headers: s.adminAuth }));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].table, s.tableName);
    assert.deepEqual(pending[0].items.map(i => i.name), [s.mee.name]);

    const accepted = await fetch(`${base}/api/kitchen/sends/${pending[0].id}/approve`, {
      method: 'POST', headers: s.adminAuth, body: '{}',
    });
    assert.equal(accepted.status, 200);

    const after = await json(await fetch(`${base}/api/kitchen/tickets?station=kitchen`, { headers: s.adminAuth }));
    assert.equal(after.tickets.length, 1, 'accepting sends it to the kitchen');
    assert.equal(after.tickets[0].status, 'sent');
    assert.equal((await json(await fetch(`${base}/api/public/sends/${ref}`))).status, 'sent');
  });
});

test('rejecting a QR round voids its lines instead of deleting them', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    await setSetting(base, s, { qr_require_approval: true });

    const { ref } = await json(await publicOrder(base, s.token, [{ item_id: s.mee.id, qty: 1 }]));
    const pending = await json(await fetch(`${base}/api/kitchen/pending`, { headers: s.adminAuth }));
    const rejected = await fetch(`${base}/api/kitchen/sends/${pending[0].id}/reject`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ reason: 'kitchen closed for the item' }),
    });
    assert.equal(rejected.status, 200);

    assert.equal((await json(await fetch(`${base}/api/public/sends/${ref}`))).status, 'rejected');

    // Rejecting the only round on the bill closes the order too — otherwise the
    // table would sit occupied by a zero-value bill nobody can pay or void.
    assert.equal((await openOrders(base, s)).some(o => o.table_id === s.tableId), false);

    const order = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.adminAuth })))
      .find(o => o.table_id === s.tableId);
    assert.equal(order.status, 'cancelled');
    assert.equal(order.items.length, 1, 'the line is kept for the record');
    assert.equal(order.items[0].voided, true);
    assert.equal(order.subtotal, 0, 'a voided line is not billed');

    // …and the table is free to take a new order straight away.
    assert.equal((await publicOrder(base, s.token, [{ item_id: s.mee.id, qty: 1 }])).status, 201);
  });
});

test('QR ordering is refused once the bill is being settled', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    assert.equal((await publicOrder(base, s.token, [{ item_id: s.mee.id, qty: 1 }])).status, 201);
    const order = (await openOrders(base, s)).find(o => o.table_id === s.tableId);

    await fetch(`${base}/api/orders/${order.id}/pay`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ method: 'Cash', amount: 1 }),
    });

    const r = await publicOrder(base, s.token, [{ item_id: s.teh.id, qty: 1 }]);
    assert.equal(r.status, 409);
    assert.match((await json(r)).message, /staff/i);
  });
});

/* Master spec §56 */
test('takeaway is a real order type: no table, own kitchen flow, reported apart', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    assert.equal(s.tables.some(t => t.name === 'Takeaway'), false, 'takeaway is no longer a fake table');

    const made = await Promise.all([1, 2].map(() => fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ order_type: 'takeaway', items: [{ item_id: s.roti.id, qty: 1 }] }),
    })));
    assert.deepEqual(made.map(r => r.status), [201, 201], 'several takeaway orders can be open at once');
    const ids = await Promise.all(made.map(json));

    const orders = await openOrders(base, s);
    const takeaway = orders.filter(o => o.order_type === 'takeaway');
    assert.equal(takeaway.length, 2);
    assert.equal(takeaway[0].table_id, null, 'no fake table dependency');
    assert.equal(takeaway[0].label, `Takeaway #${takeaway[0].id}`);

    // Normal kitchen flow.
    const ticket = (await json(await fetch(`${base}/api/kitchen/tickets?station=kitchen`, { headers: s.adminAuth })))
      .tickets.find(t => t.order_id === ids[0].id);
    assert.equal(ticket.order_type, 'takeaway');
    assert.equal(ticket.table, null);
    for (const st of ['preparing', 'ready', 'served']) {
      const r = await fetch(`${base}/api/kitchen/tickets/${ticket.id}`, {
        method: 'PATCH', headers: s.adminAuth, body: JSON.stringify({ status: st }),
      });
      assert.equal(r.status, 200);
    }

    // Normal payment.
    const paid = await fetch(`${base}/api/orders/${ids[0].id}/pay`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ method: 'Cash' }),
    });
    assert.equal(paid.status, 200);
    assert.equal((await json(paid)).settled, true);

    // A dine-in order without a table is refused, and reporting can tell them apart.
    const bad = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ items: [{ item_id: s.roti.id, qty: 1 }] }),
    });
    assert.equal(bad.status, 400);
  });
});

test('a retired table stops taking QR orders but keeps its history', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const spare = s.tables[3];

    const retire = await fetch(`${base}/api/admin/tables/${spare.id}`, {
      method: 'PATCH', headers: s.adminAuth, body: JSON.stringify({ active: false }),
    });
    assert.equal(retire.status, 200);

    assert.equal((await fetch(`${base}/api/t/${spare.qr_token}`)).status, 404);
    assert.equal((await publicOrder(base, spare.qr_token, [{ item_id: s.mee.id, qty: 1 }])).status, 400);

    const floor = await json(await fetch(`${base}/api/tables`, { headers: s.adminAuth }));
    assert.equal(floor.some(t => t.id === spare.id), false, 'hidden from the floor');
    const admin = await json(await fetch(`${base}/api/admin/tables`, { headers: s.adminAuth }));
    assert.equal(admin.some(t => t.id === spare.id), true, 'still in Admin');
  });
});

test('a table with an open order cannot be retired', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.roti.id, qty: 1 }] }),
    });
    const r = await fetch(`${base}/api/admin/tables/${s.tableId}`, {
      method: 'PATCH', headers: s.adminAuth, body: JSON.stringify({ active: false }),
    });
    assert.equal(r.status, 409);
  });
});

test('QR health reports a misconfigured public URL instead of claiming it works', async () => {
  await withDb(async () => {
    const prev = process.env.BASE_URL;
    process.env.BASE_URL = 'http://localhost:3000';
    try {
      const base = await startApp();
      const s = await setup(base);
      const health = await json(await fetch(`${base}/api/admin/qr-health`, { headers: s.adminAuth }));
      assert.equal(health.ok, false);
      assert.match(health.problems.join(' '), /only resolves on the POS machine/i);

      process.env.BASE_URL = 'https://mamak.example.com';
      const good = await json(await fetch(`${base}/api/admin/qr-health`, { headers: s.adminAuth }));
      assert.equal(good.ok, true);
      assert.equal(good.base_url, 'https://mamak.example.com');

      const tables = await json(await fetch(`${base}/api/admin/tables`, { headers: s.adminAuth }));
      assert.match(tables[0].url, /^https:\/\/mamak\.example\.com\/t\//);
    } finally {
      if (prev === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prev;
    }
  });
});
