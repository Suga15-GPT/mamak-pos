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
  const tables = await json(await fetch(`${base}/api/tables`, { headers: adminAuth }));
  const byName = n => menu.items.find(i => i.name === n);
  return {
    adminAuth,
    tableId: tables[0].id, tableId2: tables[1].id, table2Name: tables[1].name,
    roti: byName('Roti Canai'),        // kitchen station
    telur: byName('Roti Telur'),       // kitchen station
    murtabak: byName('Murtabak Ayam'), // kitchen station
    mee: byName('Mee Goreng Mamak'),   // kitchen station
    teh: byName('Teh Tarik'),          // drinks station (seed + migration 012)
  };
}

const getOrder = async (base, s, id) =>
  (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.adminAuth }))).find(o => o.id === id);

async function tickets(base, s, station) {
  const r = await json(await fetch(`${base}/api/kitchen/tickets?station=${station}`, { headers: s.adminAuth }));
  return r.tickets;
}

async function advance(base, s, ticketId, status) {
  const r = await fetch(`${base}/api/kitchen/tickets/${ticketId}`, {
    method: 'PATCH', headers: s.adminAuth, body: JSON.stringify({ status }),
  });
  assert.equal(r.status, 200, `advancing ticket ${ticketId} to ${status}`);
}

/* ===== THE regression test (master spec §53) =====
   This is the bug the whole redesign exists to fix: an add-on used to inherit
   the dining order's 'served' status and appear already served. */
test('add-on opens a new kitchen round: round 2 is SENT while round 1 stays SERVED, one bill', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    // Round 1: two items, sent together.
    const created = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.roti.id, qty: 1 }, { item_id: s.telur.id, qty: 1 }] }),
    });
    assert.equal(created.status, 201);
    const { id: orderId } = await json(created);

    let order = await getOrder(base, s, orderId);
    assert.equal(order.sends.length, 1);
    assert.equal(order.sends[0].seq_no, 1);
    assert.equal(order.sends[0].tickets.length, 1, 'both items are kitchen items -> one ticket');

    // Kitchen works round 1 all the way to served.
    const t1 = (await tickets(base, s, 'kitchen')).find(t => t.order_id === orderId);
    for (const st of ['preparing', 'ready', 'served']) await advance(base, s, t1.id, st);

    order = await getOrder(base, s, orderId);
    assert.equal(order.status, 'served');

    // Later, the same table orders one more thing.
    const appended = await fetch(`${base}/api/orders/${orderId}/items`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ items: [{ item_id: s.murtabak.id, qty: 1 }] }),
    });
    assert.equal(appended.status, 200);
    assert.equal((await json(appended)).round, 2);

    order = await getOrder(base, s, orderId);
    assert.equal(order.sends.length, 2, 'same dining order, two rounds');
    const [round1, round2] = order.sends;
    assert.equal(round1.tickets[0].status, 'served', 'round 1 is still served');
    assert.equal(round2.tickets[0].status, 'sent', 'round 2 starts at SENT — it does NOT inherit round 1');
    assert.equal(order.status, 'sent', 'the table reads as a new order again');

    const addOnLine = order.items.find(i => i.name === s.murtabak.name);
    assert.equal(addOnLine.round, 2);
    assert.equal(addOnLine.round_status, 'sent', 'the add-on is NOT served');
    assert.equal(order.items.find(i => i.name === s.roti.name).round_status, 'served');

    // Round 2 goes through its own lifecycle.
    const t2 = (await tickets(base, s, 'kitchen')).find(t => t.order_id === orderId && t.round === 2);
    assert.ok(t2, 'round 2 is a separate kitchen ticket');
    assert.equal(t2.is_addon, true);
    for (const st of ['preparing', 'ready', 'served']) await advance(base, s, t2.id, st);

    order = await getOrder(base, s, orderId);
    assert.equal(order.status, 'served');

    // One bill, paid once, carrying all three items.
    const paid = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ method: 'Card' }),
    });
    assert.equal(paid.status, 200);
    assert.equal((await json(paid)).settled, true);

    order = await getOrder(base, s, orderId);
    assert.equal(order.status, 'paid');
    assert.deepEqual(order.items.map(i => i.name).sort(),
      [s.murtabak.name, s.roti.name, s.telur.name].sort());
    assert.equal(order.subtotal, s.roti.price + s.telur.price + s.murtabak.price);
  });
});

/* Master spec §55 */
test('one round spanning two stations makes two tickets and one bill', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    const { id: orderId } = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.mee.id, qty: 1 }, { item_id: s.teh.id, qty: 1 }] }),
    }));

    const order = await getOrder(base, s, orderId);
    assert.equal(order.sends.length, 1, 'one dining round');
    assert.deepEqual(order.sends[0].tickets.map(t => t.station).sort(), ['drinks', 'kitchen']);

    const kitchenTicket = (await tickets(base, s, 'kitchen')).find(t => t.order_id === orderId);
    const drinksTicket = (await tickets(base, s, 'drinks')).find(t => t.order_id === orderId);
    assert.deepEqual(kitchenTicket.items.map(i => i.name), [s.mee.name]);
    assert.deepEqual(drinksTicket.items.map(i => i.name), [s.teh.name]);
    assert.equal(kitchenTicket.round, drinksTicket.round, 'same dining round');

    // Drinks finish first; the order still reads by the slowest station.
    for (const st of ['preparing', 'ready', 'served']) await advance(base, s, drinksTicket.id, st);
    assert.equal((await getOrder(base, s, orderId)).status, 'sent', 'food has not been started yet');

    await advance(base, s, kitchenTicket.id, 'preparing');
    assert.equal((await getOrder(base, s, orderId)).status, 'preparing');
    await advance(base, s, kitchenTicket.id, 'ready');
    assert.equal((await getOrder(base, s, orderId)).status, 'ready');
    await advance(base, s, kitchenTicket.id, 'served');
    assert.equal((await getOrder(base, s, orderId)).status, 'served');

    // The customer bill is one bill covering both stations.
    const done = await getOrder(base, s, orderId);
    assert.equal(done.subtotal, s.mee.price + s.teh.price);
  });
});

test('a still-sent add-on can be voided by staff even after round 1 was served', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const staffId = (await json(await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ name: 'Devi', role: 'staff', pin: '6284' }),
    }))).id;
    assert.ok(staffId);
    const staffSession = await login(base, 'Devi', '6284');
    await fetch(`${base}/api/me/pin`, {
      method: 'POST', headers: auth(staffSession), body: JSON.stringify({ current_pin: '6284', new_pin: '4816' }),
    });
    const staffAuth = auth(staffSession);

    const { id: orderId } = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.roti.id, qty: 1 }] }),
    }));
    const t1 = (await tickets(base, s, 'kitchen')).find(t => t.order_id === orderId);
    for (const st of ['preparing', 'ready', 'served']) await advance(base, s, t1.id, st);

    await fetch(`${base}/api/orders/${orderId}/items`, {
      method: 'POST', headers: staffAuth, body: JSON.stringify({ items: [{ item_id: s.telur.id, qty: 1 }] }),
    });
    const order = await getOrder(base, s, orderId);
    const addOn = order.items.find(i => i.name === s.telur.name);
    const served = order.items.find(i => i.name === s.roti.name);

    // The add-on's own ticket is still 'sent', so staff may void it...
    const okVoid = await fetch(`${base}/api/orders/${orderId}/items/${addOn.id}/void`, {
      method: 'POST', headers: staffAuth, body: JSON.stringify({ reason: 'customer changed mind' }),
    });
    assert.equal(okVoid.status, 200);

    // ...but the already-served round 1 line is admin-only.
    const refused = await fetch(`${base}/api/orders/${orderId}/items/${served.id}/void`, {
      method: 'POST', headers: staffAuth, body: JSON.stringify({ reason: 'too late now' }),
    });
    assert.equal(refused.status, 403);
  });
});

test('every send records who sent it', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const { id: orderId } = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.roti.id, qty: 1 }] }),
    }));
    const order = await getOrder(base, s, orderId);
    assert.equal(order.sends[0].sent_by_name, 'Admin');
    assert.ok(order.sends[0].sent_at);

    const t1 = (await tickets(base, s, 'kitchen')).find(t => t.order_id === orderId);
    await advance(base, s, t1.id, 'preparing');
    await advance(base, s, t1.id, 'ready');
    const after = await getOrder(base, s, orderId);
    assert.equal(after.sends[0].tickets[0].preparing_by_name, 'Admin');
    assert.equal(after.sends[0].tickets[0].ready_by_name, 'Admin');
  });
});

/* Master spec §50 */
test('moving an order to another table keeps the bill, the rounds and the audit trail', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    const { id: orderId } = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.roti.id, qty: 2 }] }),
    }));
    const before = await getOrder(base, s, orderId);

    const moved = await fetch(`${base}/api/orders/${orderId}/move`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ table_id: s.tableId2 }),
    });
    assert.equal(moved.status, 200);

    const after = await getOrder(base, s, orderId);
    assert.equal(after.id, orderId, 'same dining order');
    assert.equal(after.table_id, s.tableId2);
    assert.equal(after.table, s.table2Name);
    assert.equal(after.subtotal, before.subtotal, 'bill unchanged');
    assert.equal(after.sends.length, before.sends.length, 'rounds unchanged');
    assert.equal(after.sends[0].id, before.sends[0].id);

    const audit = await db.query("SELECT * FROM audit_log WHERE action = 'order.move' AND entity_id = $1", [orderId]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].detail.to_table_id, s.tableId2);

    // Moving onto a table that already has its own open order is refused.
    await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.roti.id, qty: 1 }] }),
    });
    const clash = await fetch(`${base}/api/orders/${orderId}/move`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ table_id: s.tableId }),
    });
    assert.equal(clash.status, 409);
  });
});

/* Two tablets sending to the same table in the same instant both read the same
   max(seq_no). The unique index decides which is round 2; the loser must open
   round 3, not fail — its items are real and the kitchen still needs them. */
test('concurrent sends to one table produce distinct rounds, never a lost batch', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    const { id: orderId } = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.adminAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.roti.id, qty: 1 }] }),
    }));

    const append = item => fetch(`${base}/api/orders/${orderId}/items`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ items: [{ item_id: item.id, qty: 1 }] }),
    });
    const results = await Promise.all([append(s.telur), append(s.murtabak), append(s.mee)]);
    assert.deepEqual(results.map(r => r.status), [200, 200, 200]);

    const order = await getOrder(base, s, orderId);
    assert.equal(order.sends.length, 4, 'one round per send, none lost');
    assert.deepEqual(order.sends.map(x => x.seq_no).sort((a, b) => a - b), [1, 2, 3, 4]);
    assert.equal(order.items.length, 4, 'every item is on the one bill');

    // Every round that just arrived is new; none inherited anything.
    order.sends.slice(1).forEach(round => assert.equal(round.tickets[0].status, 'sent'));
  });
});
