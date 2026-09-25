const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { withDb, getFreePort, TEST_DATABASE_URL } = require('../helper');

const SRC_DIR = path.join(__dirname, '..', '..', 'src') + path.sep;
const DB_MODULE = require.resolve('../../src/db');
const SERVER_MODULE = require.resolve('../../src/server');
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

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

// An admin with a shift open (payment needs one), the cards, and the menu.
async function setup(base, { openShift = true } = {}) {
  const h = auth(await login(base, 'Admin', '1234'));
  if (openShift) await fetch(`${base}/api/shift/open`, { method: 'POST', headers: h, body: JSON.stringify({ float: 0 }) });
  const menu = await json(await fetch(`${base}/api/menu`, { headers: h }));
  const cards = await json(await fetch(`${base}/api/admin/cards`, { headers: h }));
  const byName = n => menu.items.find(i => i.name === n);
  const card = n => cards.find(c => c.number === n);
  return { h, cards, card, roti: byName('Roti Canai'), milo: byName('Milo Panas'), mee: byName('Mee Goreng Mamak') };
}

const post = (base, s, url, body) => fetch(`${base}${url}`, { method: 'POST', headers: s.h, body: JSON.stringify(body || {}) });
const del = (base, s, url) => fetch(`${base}${url}`, { method: 'DELETE', headers: s.h });
const get = async (base, s, url) => json(await fetch(`${base}${url}`, { headers: s.h }));

async function openCard(base, s, number, item, qty = 1) {
  const r = await post(base, s, '/api/orders', { card_id: s.card(number).id, items: [{ item_id: item.id, qty }] });
  assert.equal(r.status, 201, `opening Card ${number}`);
  return (await json(r)).id;
}

const orderRow = (db, id) => db.query('SELECT * FROM orders WHERE id = $1', [id]).then(r => r.rows[0]);

test('two concurrent opens on one free card -> one 201, one 409, one open order', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const body = { card_id: s.card(7).id, items: [{ item_id: s.roti.id, qty: 1 }] };
    const results = await Promise.all([post(base, s, '/api/orders', body), post(base, s, '/api/orders', body)]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    const conflict = await json(results.find(r => r.status === 409));
    const open = await db.query(
      "SELECT id FROM orders WHERE card_id = $1 AND status NOT IN ('paid','cancelled','refunded')", [s.card(7).id]);
    assert.equal(open.rows.length, 1);
    assert.equal(conflict.order_id, open.rows[0].id, 'the loser is told which order holds the card');

    // A new dine-in order can no longer name a table.
    const noCard = await post(base, s, '/api/orders', { table_id: 1, items: [{ item_id: s.roti.id, qty: 1 }] });
    assert.equal(noCard.status, 400);
  });
});

test('a card frees itself when its order is paid and is reusable immediately', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const id = await openCard(base, s, 3, s.roti, 2);

    let floor = await get(base, s, '/api/cards');
    const three = floor.find(c => c.number === 3);
    assert.equal(three.in_use, true);
    assert.equal(three.order.id, id);
    assert.equal(three.order.item_count, 2);
    assert.equal(three.order.total, 4.24);
    assert.equal(floor.length, 50, 'cards 1..50 are seeded');

    const paid = await post(base, s, `/api/orders/${id}/pay`, { method: 'Card' });
    assert.equal((await json(paid)).settled, true);

    floor = await get(base, s, '/api/cards');
    assert.equal(floor.find(c => c.number === 3).in_use, false, 'no manual release');
    const again = await openCard(base, s, 3, s.roti);
    assert.notEqual(again, id, 'a fresh order on the same card');

    const orders = await get(base, s, '/api/orders');
    assert.equal(orders.find(o => o.id === again).label, 'Card 3');
  });
});

test('lowering the card count below an in-use number -> 409; raising it brings cards back', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await openCard(base, s, 12, s.roti);

    const patch = count => fetch(`${base}/api/admin/cards/count`, { method: 'PATCH', headers: s.h, body: JSON.stringify({ count }) });
    const refused = await patch(10);
    assert.equal(refused.status, 409);
    assert.match((await json(refused)).error, /Card 12/);
    assert.equal((await db.query('SELECT count(*)::int n FROM cards WHERE active')).rows[0].n, 50, 'nothing changed');

    assert.equal((await patch(20)).status, 200, 'lowering above the in-use card is fine');
    assert.equal((await get(base, s, '/api/cards')).length, 20);
    assert.equal((await patch(60)).status, 200);
    const floor = await get(base, s, '/api/cards');
    assert.deepEqual(floor.map(c => c.number), Array.from({ length: 60 }, (_, i) => i + 1));
  });
});

test('combine Card 1 + Card 4, add items to Card 4, pay the group in cash once', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    // Milo Panas RM3.20, SST 6%: Card 1 = 3.20 + 0.19 (19.2 sen) = 3.39.
    const o1 = await openCard(base, s, 1, s.milo);
    const o4 = await openCard(base, s, 4, s.milo);

    const combined = await post(base, s, '/api/bill-groups', { order_ids: [o4, o1] });
    assert.equal(combined.status, 201);
    const group = await json(combined);
    assert.deepEqual(group.members.map(m => m.label), ['Card 1', 'Card 4'], 'members come back in card order');

    // Staff keep adding to a grouped card: Card 4 = 6.40 + 0.38 (38.4 sen) = 6.78.
    const more = await post(base, s, `/api/orders/${o4}/items`, { items: [{ item_id: s.milo.id, qty: 1 }] });
    assert.equal(more.status, 200);

    const before = await get(base, s, `/api/bill-groups/${group.id}`);
    assert.equal(before.members.length, 2);
    assert.equal(before.members[1].items.length, 2, "Card 4's own lines, both rounds");
    assert.equal(before.members[1].sends.length, 2, 'Card 4 keeps its own rounds');
    assert.equal(before.members[0].sends.length, 1, 'nothing moved onto Card 1');
    // Tax is each order's own: 0.19 + 0.38 = 0.57, never 6% of the combined
    // 9.60 (which would be 0.58).
    assert.equal(before.tax, 0.57);
    assert.equal(before.subtotal, 9.60);
    assert.equal(before.total, 10.17);
    assert.equal(before.amount_due, 10.17);

    // A grouped card is paid and split with its group, not on its own.
    assert.equal((await post(base, s, `/api/orders/${o1}/pay`, { method: 'Cash' })).status, 409);
    assert.equal((await fetch(`${base}/api/orders/${o1}/split?ways=2`, { headers: s.h })).status, 409);

    const pay = await post(base, s, `/api/bill-groups/${group.id}/pay`, { method: 'Cash', tendered: 20 });
    assert.equal(pay.status, 200);
    const paid = await json(pay);
    assert.equal(paid.settled, true);
    assert.equal(paid.paid, 10.15, 'rounded once, on the group: 10.17 -> 10.15');
    assert.equal(paid.change, 9.85);
    assert.equal(paid.remaining, 0);

    const rows = (await db.query(
      'SELECT order_id, method, amount_cents, tendered_cents, taken_by, shift_id FROM payments WHERE order_id = ANY($1::int[]) ORDER BY order_id',
      [[o1, o4]])).rows;
    assert.equal(rows.length, 2, 'one payments row per member order');
    assert.equal(rows.reduce((t, r) => t + r.amount_cents, 0), 1015, 'rows sum exactly to the cash taken');
    assert.deepEqual(rows.map(r => r.amount_cents), [339, 676], 'Card 1 covered first; the rounding lands on the last member');
    assert.ok(rows.every(r => r.method === 'Cash' && r.taken_by === rows[0].taken_by && r.shift_id === rows[0].shift_id));
    assert.equal(rows.reduce((t, r) => t + r.tendered_cents - r.amount_cents, 0), 985, 'the change is the group change, recorded once');

    const [a, b] = [await orderRow(db, o1), await orderRow(db, o4)];
    assert.equal(a.status, 'paid');
    assert.equal(b.status, 'paid');
    assert.equal(a.rounding_cents, 0);
    assert.equal(b.rounding_cents, -2, 'rounding applied once, on one order');
    assert.equal(a.tax_cents + b.tax_cents, 57);
    assert.equal(a.total_cents + b.total_cents, 1015);

    const g = (await db.query('SELECT closed_at FROM bill_groups WHERE id = $1', [group.id])).rows[0];
    assert.ok(g.closed_at, 'the group is closed');
    const floor = await get(base, s, '/api/cards');
    assert.equal(floor.find(c => c.number === 1).in_use, false);
    assert.equal(floor.find(c => c.number === 4).in_use, false);

    const audit = (await db.query(
      "SELECT action FROM audit_log WHERE entity_type = 'bill_group' AND entity_id = $1 ORDER BY id", [group.id])).rows;
    assert.deepEqual(audit.map(r => r.action), ['bill_group.combine', 'bill_group.pay']);
    // The shift sees two ordinary cash payments, nothing new to reconcile.
    const report = await get(base, s, `/api/shift/${rows[0].shift_id}/report`);
    assert.equal(report.cash.cash_sales_cents, 1015);
  });
});

test('a partial group payment blocks un-combining; with no payment un-combining leaves both cards as they were', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const o2 = await openCard(base, s, 2, s.roti);   // 2.12
    const o5 = await openCard(base, s, 5, s.mee);    // 8.50 + 0.51 = 9.01
    const o6 = await openCard(base, s, 6, s.roti);
    const o7 = await openCard(base, s, 7, s.mee);

    // Un-combine with no payment: both independent again, totals unchanged.
    const g1 = await json(await post(base, s, '/api/bill-groups', { order_ids: [o6, o7] }));
    const totalsBefore = [(await orderRow(db, o6)).total_cents, (await orderRow(db, o7)).total_cents];
    const dissolved = await del(base, s, `/api/bill-groups/${g1.id}`);
    assert.equal(dissolved.status, 200);
    const [r6, r7] = [await orderRow(db, o6), await orderRow(db, o7)];
    assert.equal(r6.bill_group_id, null);
    assert.equal(r7.bill_group_id, null);
    assert.deepEqual([r6.total_cents, r7.total_cents], totalsBefore);
    assert.equal((await post(base, s, `/api/orders/${o6}/pay`, { method: 'Card' })).status, 200, 'Card 6 pays on its own again');
    assert.equal((await fetch(`${base}/api/orders/${o7}/split?ways=2`, { headers: s.h })).status, 200, 'and splits on its own');

    // Partial payment, then un-combine -> 409.
    const g2 = await json(await post(base, s, '/api/bill-groups', { order_ids: [o2, o5] }));
    const part = await json(await post(base, s, `/api/bill-groups/${g2.id}/pay`, { method: 'Card', amount: 5 }));
    assert.equal(part.settled, false);
    assert.equal(part.remaining, 6.13);
    assert.deepEqual(part.allocations.map(x => [x.card_number, x.amount]), [[2, 2.12], [5, 2.88]], 'lowest card first');

    for (const r of [await del(base, s, `/api/bill-groups/${g2.id}`), await del(base, s, `/api/bill-groups/${g2.id}/orders/${o5}`)]) {
      assert.equal(r.status, 409);
      assert.equal((await json(r)).error, "This combined bill has a payment on it and can't be split apart.");
    }
    assert.equal((await orderRow(db, o2)).status !== 'paid', true, 'a covered member stays open until the group is settled');

    const rest = await json(await post(base, s, `/api/bill-groups/${g2.id}/pay`, { method: 'Card' }));
    assert.equal(rest.settled, true);
    assert.equal((await db.query('SELECT COALESCE(SUM(amount_cents),0)::int s FROM payments WHERE order_id = ANY($1::int[])', [[o2, o5]])).rows[0].s, 1113);
    assert.equal((await orderRow(db, o2)).status, 'paid');
    assert.equal((await orderRow(db, o5)).status, 'paid');

    const audit = (await db.query(
      "SELECT action FROM audit_log WHERE entity_type = 'bill_group' ORDER BY id")).rows.map(r => r.action);
    assert.deepEqual(audit, ['bill_group.combine', 'bill_group.dissolve', 'bill_group.combine', 'bill_group.pay', 'bill_group.pay']);
  });
});

test('combining a closed order or a takeaway -> 409; merging two groups makes one group', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const o1 = await openCard(base, s, 1, s.roti);
    const o2 = await openCard(base, s, 2, s.roti);
    const o3 = await openCard(base, s, 3, s.roti);
    const o4 = await openCard(base, s, 4, s.roti);
    const o8 = await openCard(base, s, 8, s.roti);

    const closed = await openCard(base, s, 9, s.roti);
    await post(base, s, `/api/orders/${closed}/pay`, { method: 'Card' });
    assert.equal((await post(base, s, '/api/bill-groups', { order_ids: [o1, closed] })).status, 409);

    const tk = await json(await post(base, s, '/api/orders', { order_type: 'takeaway', items: [{ item_id: s.roti.id, qty: 1 }] }));
    assert.equal((await post(base, s, '/api/bill-groups', { order_ids: [o1, tk.id] })).status, 409);
    assert.equal((await post(base, s, '/api/bill-groups', { order_ids: [o1] })).status, 400, 'one card is not a combination');

    const ga = await json(await post(base, s, '/api/bill-groups', { order_ids: [o1, o2] }));
    const gb = await json(await post(base, s, '/api/bill-groups', { order_ids: [o3, o4] }));
    // Adding a card to a grouped card joins that group.
    const joined = await json(await post(base, s, '/api/bill-groups', { order_ids: [o8, o2] }));
    assert.equal(joined.id, ga.id);
    // Combining a card from each group merges the groups.
    const merged = await json(await post(base, s, '/api/bill-groups', { order_ids: [o4, o1] }));
    assert.deepEqual(merged.members.map(m => m.card_number), [1, 2, 3, 4, 8]);
    const ids = (await db.query('SELECT DISTINCT bill_group_id FROM orders WHERE id = ANY($1::int[])', [[o1, o2, o3, o4, o8]])).rows;
    assert.equal(ids.length, 1, 'one group');
    assert.equal(ids[0].bill_group_id, merged.id);
    assert.ok((await db.query('SELECT closed_at FROM bill_groups WHERE id = $1', [gb.id])).rows[0].closed_at, 'the absorbed group is closed');
    assert.equal(merged.total, 10.60);

    // Removing one card takes just that card out.
    const removed = await del(base, s, `/api/bill-groups/${merged.id}/orders/${o8}`);
    assert.equal(removed.status, 200);
    assert.equal((await orderRow(db, o8)).bill_group_id, null);
    assert.equal((await get(base, s, `/api/bill-groups/${merged.id}`)).members.length, 4);
  });
});

test('shop mode forces approval even with qr_require_approval off; off mode -> 404', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const setSetting = body => fetch(`${base}/api/settings`, { method: 'PATCH', headers: s.h, body: JSON.stringify(body) });
    assert.equal((await setSetting({ qr_mode: 'shop', qr_require_approval: false })).status, 200);
    const shop = await get(base, s, '/api/admin/qr-shop');
    const token = shop.url.split('/t/')[1];

    const page = await json(await fetch(`${base}/api/t/${token}`));
    assert.equal(page.mode, 'shop');
    assert.equal(page.needs_card_number, true);
    assert.equal(page.ordering.approval_required, true);

    const order = body => fetch(`${base}/api/public/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await order({ table_token: token, items: [{ item_id: s.roti.id, qty: 1 }] })).status, 400, 'a card number is required');
    assert.equal((await order({ table_token: token, card_number: 999, items: [{ item_id: s.roti.id, qty: 1 }] })).status, 400);
    // A per-card token is not the shop token.
    assert.equal((await order({ table_token: s.card(3).qr_token, card_number: 3, items: [{ item_id: s.roti.id, qty: 1 }] })).status, 400);

    const r = await order({ table_token: token, card_number: 11, items: [{ item_id: s.roti.id, qty: 1 }] });
    assert.equal(r.status, 201);
    const placed = await json(r);
    assert.equal(placed.status, 'pending', 'held for a person to look at');
    assert.equal(placed.card, 11);
    const send = (await db.query('SELECT s.approval_state, o.card_id FROM order_sends s JOIN orders o ON o.id = s.order_id WHERE s.public_ref = $1', [placed.ref])).rows[0];
    assert.equal(send.approval_state, 'pending');
    assert.equal(send.card_id, s.card(11).id, 'ordered onto the card that was typed in');
    const kitchen = await get(base, s, '/api/kitchen/tickets?station=kitchen');
    assert.equal(kitchen.tickets.length, 0, 'nothing reaches a station unapproved');

    // per_card: the card's own token, approval as configured.
    await setSetting({ qr_mode: 'per_card' });
    const own = await json(await order({ table_token: s.card(12).qr_token, items: [{ item_id: s.roti.id, qty: 1 }] }));
    assert.equal(own.status, 'sent');
    assert.equal((await json(await fetch(`${base}/api/t/${s.card(12).qr_token}`))).card.number, 12);

    // off: every public QR and voice endpoint is a 404.
    await setSetting({ qr_mode: 'off' });
    const off = await fetch(`${base}/api/t/${s.card(12).qr_token}`);
    assert.equal(off.status, 404);
    assert.match((await json(off)).error, /order at the counter/i);
    assert.equal((await order({ table_token: s.card(12).qr_token, items: [{ item_id: s.roti.id, qty: 1 }] })).status, 404);
    assert.equal((await fetch(`${base}/api/public/sends/${own.ref}`)).status, 404);
    const voice = await fetch(`${base}/api/public/voice/interpret`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table_token: s.card(12).qr_token, mime_type: 'audio/webm', audio_base64: 'AAAA' }),
    });
    assert.equal(voice.status, 404);
  });
});

/* Runs every migration before 014 against a fresh schema, lets the test put
   rows in place as they were before card mode, then applies 014 on top — the
   same thing a deploy does to a restaurant that is open. */
async function withPreCardModeDb(before, fn) {
  const schema = `test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const prevUrl = process.env.DATABASE_URL;
  const prevOptions = process.env.PGOPTIONS;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  delete require.cache[DB_MODULE];
  const db = require(DB_MODULE);
  try {
    await db.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
      if (file >= '014') break;
      await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    }
    await before(db);
    await db.migrate();
    return await fn(db);
  } finally {
    await db.pool.end();
    delete require.cache[DB_MODULE];
    if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl;
    if (prevOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = prevOptions;
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

test('a table order already open before the migration stays visible and payable after it', async () => {
  let orderId;
  await withPreCardModeDb(async db => {
    const t = (await db.query("INSERT INTO tables (name, qr_token) VALUES ('T5', 'legacytoken') RETURNING id")).rows[0];
    orderId = (await db.query(
      `INSERT INTO orders (table_id, status, source, order_type, subtotal_cents, service_charge_cents, tax_cents,
                           discount_cents, rounding_cents, total_cents, tax_rate_bp, svc_rate_bp)
       VALUES ($1, 'served', 'staff', 'dine_in', 200, 0, 12, 0, 0, 212, 600, 0) RETURNING id`, [t.id])).rows[0].id;
    const send = (await db.query("INSERT INTO order_sends (order_id, seq_no) VALUES ($1, 1) RETURNING id", [orderId])).rows[0];
    await db.query(
      "INSERT INTO order_items (order_id, name, price_cents, qty, send_id) VALUES ($1, 'Roti Canai', 200, 1, $2)", [orderId, send.id]);
    await db.query("INSERT INTO order_send_tickets (send_id, station_code, status) VALUES ($1, 'kitchen', 'served')", [send.id]);
    await db.query("INSERT INTO settings (key, value) VALUES ('qr_ordering_enabled', '0') ON CONFLICT (key) DO UPDATE SET value = '0'");
  }, async db => {
    // qr_ordering_enabled was off, so card mode starts with QR off.
    assert.equal((await db.query("SELECT value FROM settings WHERE key = 'qr_mode'")).rows[0].value, 'off');

    const base = await startApp();
    const s = await setup(base);
    const open = await get(base, s, '/api/orders');
    const legacy = open.find(o => o.id === orderId);
    assert.ok(legacy, 'still on the open list');
    assert.equal(legacy.label, 'T5', 'it keeps showing its table name');
    assert.equal(legacy.card_id, null);

    const r = await post(base, s, `/api/orders/${orderId}/pay`, { method: 'Cash' });
    assert.equal(r.status, 200);
    assert.equal((await json(r)).settled, true);
    const row = await orderRow(db, orderId);
    assert.equal(row.status, 'paid');
    assert.equal(row.table_id != null, true, 'history keeps its table');
    assert.equal((await db.query('SELECT count(*)::int n FROM tables')).rows[0].n, 1, 'tables are never dropped');
  });
});
