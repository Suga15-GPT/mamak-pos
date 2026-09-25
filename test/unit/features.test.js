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

const MODULES = ['kitchen', 'stations', 'printing', 'shifts', 'discounts', 'refunds', 'split_combine', 'qr', 'voice', 'dashboard'];

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

async function setup(base) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Admin', pin: '1234' }),
  });
  const body = await json(r);
  const h = { cookie: (r.headers.get('set-cookie') || '').split(';')[0], 'x-csrf-token': body.csrf_token, 'content-type': 'application/json' };
  const menu = await json(await fetch(`${base}/api/menu`, { headers: h }));
  const cards = await json(await fetch(`${base}/api/admin/cards`, { headers: h }));
  return {
    h, cards, card: n => cards.find(c => c.number === n),
    roti: menu.items.find(i => i.name === 'Roti Canai'), milo: menu.items.find(i => i.name === 'Milo Panas'),
  };
}

const call = (base, s, method, url, body) =>
  fetch(`${base}${url}`, { method, headers: s.h, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (base, s, url, body) => call(base, s, 'POST', url, body || {});
const get = async (base, s, url) => json(await fetch(`${base}${url}`, { headers: s.h }));

async function setFeatures(base, s, features) {
  const r = await call(base, s, 'PATCH', '/api/features', { features });
  assert.equal(r.status, 200, `PATCH /api/features ${JSON.stringify(features)}`);
  return json(r);
}
const allFlags = on => Object.fromEntries(MODULES.map(m => [m, on]));

async function openCard(base, s, number, item = s.roti, qty = 1) {
  const r = await post(base, s, '/api/orders', { card_id: s.card(number).id, items: [{ item_id: item.id, qty }] });
  assert.equal(r.status, 201, `opening Card ${number}`);
  return (await json(r)).id;
}

const orderRow = (db, id) => db.query('SELECT * FROM orders WHERE id = $1', [id]).then(r => r.rows[0]);

/* Every route each module owns, as [method, url, body]. Ids that exist are
   filled in per test; the point is only which answer comes back. */
function endpoints(ctx) {
  const o = ctx.orderId;
  return {
    kitchen: [['GET', '/api/kitchen/tickets'], ['GET', '/api/kitchen/stations'],
      ['PATCH', '/api/kitchen/tickets/999999', { status: 'preparing' }], ['PATCH', `/api/orders/${o}`, { status: 'preparing' }]],
    stations: [['GET', '/api/admin/stations']],
    printing: [['GET', '/api/admin/printers'], ['GET', '/api/admin/print-jobs'],
      ['POST', `/api/orders/${o}/reprint-receipt`], ['POST', '/api/admin/printers', { name: '' }]],
    shifts: [['GET', '/api/shift/current'], ['POST', '/api/shift/movements', { kind: 'payin', amount: 1, reason: 'x' }]],
    discounts: [['POST', `/api/orders/${o}/discounts`, { kind: 'amount', value: 0.5, reason: 'regular' }]],
    refunds: [['POST', `/api/orders/${o}/refunds`, { payment_id: 999999, amount: 1, reason: 'cold food' }]],
    split_combine: [['GET', `/api/orders/${o}/split?ways=2`], ['POST', '/api/bill-groups', { order_ids: [] }], ['GET', '/api/bill-groups/999999']],
    qr: [['GET', `/api/t/${ctx.token}`], ['POST', '/api/public/orders', { table_token: ctx.token, items: [{ item_id: ctx.itemId, qty: 1 }] }],
      ['GET', '/api/public/sends/nope'], ['GET', '/api/kitchen/pending'], ['GET', '/api/admin/qr-shop'], ['GET', '/api/admin/qr-health']],
    voice: [['POST', '/api/public/voice/interpret', { table_token: ctx.token, audio_base64: '' }]],
    dashboard: [['GET', '/api/dashboard']],
  };
}

async function isDisabled(base, s, [method, url, body]) {
  const r = await call(base, s, method, url, body);
  const b = await r.json().catch(() => ({}));
  return r.status === 404 && b.error === 'feature_disabled';
}

test('each switched-off module 404s feature_disabled on every route it owns; the others keep working', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const ctx = { orderId: await openCard(base, s, 1), token: s.card(2).qr_token, itemId: s.roti.id };
    const eps = endpoints(ctx);

    // Advanced (the default): nothing is refused as disabled.
    for (const [mod, list] of Object.entries(eps)) {
      for (const ep of list) assert.equal(await isDisabled(base, s, ep), false, `${mod} ${ep[0]} ${ep[1]} with everything on`);
    }

    for (const mod of MODULES) {
      const res = await setFeatures(base, s, { ...allFlags(true), [mod]: false });
      const off = new Set([mod, ...res.switched_off]);
      for (const [m, list] of Object.entries(eps)) {
        for (const ep of list) {
          assert.equal(await isDisabled(base, s, ep), off.has(m), `${m} ${ep[0]} ${ep[1]} with only ${mod} off`);
        }
      }
    }
    // The core is never a module: taking an order and the menu still work with everything off.
    await setFeatures(base, s, allFlags(false));
    assert.equal((await fetch(`${base}/api/menu`)).status, 200);
    assert.equal((await post(base, s, '/api/orders', { order_type: 'takeaway', items: [{ item_id: s.roti.id, qty: 1 }] })).status, 201);
    assert.equal((await fetch(`${base}/api/summary`, { headers: s.h })).status, 200, "the simple Today's sales card still has its figures");
  });
});

test('kitchen off: a sent order and its add-on derive served at once, print no chit, and never reach the kitchen board', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await setFeatures(base, s, { kitchen: false }); // printing stays on
    const id = await openCard(base, s, 3);
    assert.equal((await orderRow(db, id)).status, 'served', 'derived served in the same request');
    const tickets = (await db.query(
      'SELECT t.status FROM order_send_tickets t JOIN order_sends x ON x.id = t.send_id WHERE x.order_id = $1', [id])).rows;
    assert.ok(tickets.length && tickets.every(t => t.status === 'served'));

    assert.equal((await post(base, s, `/api/orders/${id}/items`, { items: [{ item_id: s.milo.id, qty: 1 }] })).status, 200);
    assert.equal((await orderRow(db, id)).status, 'served', 'an add-on does not drag it back to sent');
    const listed = (await get(base, s, '/api/orders')).find(o => o.id === id);
    assert.equal(listed.status, 'served');

    const chits = (await db.query("SELECT count(*)::int n FROM print_jobs WHERE kind IN ('chit','void')")).rows[0].n;
    assert.equal(chits, 0, 'no kitchen chit, not even a failed one');

    // Switching the screen back on does not put yesterday's non-work on it.
    await setFeatures(base, s, { kitchen: true });
    for (const st of await get(base, s, '/api/kitchen/stations')) {
      const board = await get(base, s, `/api/kitchen/tickets?station=${st.code}`);
      assert.equal(board.tickets.some(t => t.order_id === id), false, `not on the ${st.code} board`);
    }
    // And a new order after that goes to the kitchen as it always did.
    const id2 = await openCard(base, s, 4);
    assert.equal((await orderRow(db, id2)).status, 'sent');
  });
});

test('stations off: every line goes to the one kitchen station; the item keeps its own station', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await setFeatures(base, s, { stations: false });
    const id = await openCard(base, s, 5, s.milo);
    const line = (await db.query('SELECT station_code FROM order_items WHERE order_id = $1', [id])).rows[0];
    assert.equal(line.station_code, 'kitchen');
    assert.equal((await db.query('SELECT station_code FROM items WHERE id = $1', [s.milo.id])).rows[0].station_code, 'drinks');
    assert.deepEqual((await get(base, s, '/api/kitchen/stations')).map(x => x.code), ['kitchen']);
  });
});

test('shifts off: payment and refund succeed with no shift open and record shift_id NULL; shifts on refuses, as today', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    const a = await openCard(base, s, 6);
    const refused = await post(base, s, `/api/orders/${a}/pay`, { method: 'Card' });
    assert.equal(refused.status, 400, 'shifts on and none open: refused');
    assert.match((await json(refused)).error, /no shift is open/);

    await setFeatures(base, s, { shifts: false });
    const b = await openCard(base, s, 7);
    const paid = await post(base, s, `/api/orders/${b}/pay`, { method: 'Card' });
    assert.equal(paid.status, 200);
    assert.equal((await json(paid)).settled, true);
    const pay = (await db.query('SELECT id, shift_id FROM payments WHERE order_id = $1', [b])).rows[0];
    assert.equal(pay.shift_id, null);
    const row = await orderRow(db, b);
    assert.equal(row.status, 'paid');
    assert.equal(row.shift_id, null);
    assert.equal(row.closed_shift_id, null);

    const ref = await post(base, s, `/api/orders/${b}/refunds`, { payment_id: pay.id, amount: 0.5, reason: 'cold roti' });
    assert.equal(ref.status, 200);
    assert.equal((await db.query('SELECT shift_id FROM refunds WHERE order_id = $1', [b])).rows[0].shift_id, null);

    // Back on: only later payments are affected, and nothing is back-filled.
    await setFeatures(base, s, { shifts: true });
    assert.equal((await post(base, s, `/api/orders/${a}/pay`, { method: 'Card' })).status, 400);
    assert.equal((await post(base, s, '/api/shift/open', { float: 0 })).status, 201);
    assert.equal((await post(base, s, `/api/orders/${a}/pay`, { method: 'Card' })).status, 200);
    assert.notEqual((await db.query('SELECT shift_id FROM payments WHERE order_id = $1', [a])).rows[0].shift_id, null);
    assert.equal((await db.query('SELECT shift_id FROM payments WHERE order_id = $1', [b])).rows[0].shift_id, null, 'never back-filled');
  });
});

test('a parent switched off takes its child with it; switched back on it does not', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    let r = await setFeatures(base, s, { kitchen: false });
    assert.deepEqual(r.switched_off, ['stations']);
    assert.equal(r.features.stations, false);
    r = await setFeatures(base, s, { kitchen: true });
    assert.equal(r.features.kitchen, true);
    assert.equal(r.features.stations, false, 'turning the parent on leaves the child off');

    r = await setFeatures(base, s, { qr: false });
    assert.deepEqual(r.switched_off, ['voice']);
    assert.equal(r.features.voice, false);
    r = await setFeatures(base, s, { qr: true });
    assert.equal(r.features.voice, false);

    // A child can't be asked on under a parent that is off.
    r = await setFeatures(base, s, { qr: false, voice: true });
    assert.equal(r.features.voice, false);
    assert.deepEqual(r.switched_off, ['voice']);

    const f = await get(base, s, '/api/features');
    assert.equal(f.features.stations, false);
    assert.equal(f.features.voice, false);
  });
});

test('discounts off then on: an existing discount stays on the bill and applied throughout', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const id = await openCard(base, s, 8, s.roti, 5);
    const before = await orderRow(db, id);
    assert.equal((await post(base, s, `/api/orders/${id}/discounts`, { kind: 'amount', value: 1, reason: 'regular' })).status, 200);
    const discounted = await orderRow(db, id);
    assert.equal(discounted.discount_cents, 100);
    assert.equal(discounted.total_cents, before.total_cents - 100);

    await setFeatures(base, s, { discounts: false });
    assert.equal((await post(base, s, `/api/orders/${id}/discounts`, { kind: 'amount', value: 1, reason: 'again' })).status, 404);
    // Adding to the bill recomputes it; the discount is still there and still applied.
    assert.equal((await post(base, s, `/api/orders/${id}/items`, { items: [{ item_id: s.roti.id, qty: 1 }] })).status, 200);
    const whileOff = await orderRow(db, id);
    assert.equal(whileOff.discount_cents, 100);
    assert.equal((await get(base, s, '/api/orders')).find(o => o.id === id).discounts.length, 1);

    await setFeatures(base, s, { discounts: true });
    const listed = (await get(base, s, '/api/orders')).find(o => o.id === id);
    assert.equal(listed.discounts.length, 1);
    assert.equal(listed.discounts[0].reason, 'regular');
    assert.equal((await orderRow(db, id)).discount_cents, 100);
    assert.equal((await db.query('SELECT count(*)::int n FROM discounts WHERE order_id = $1', [id])).rows[0].n, 1);
  });
});

test('printing off: a settled bill and a reprint queue nothing', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await setFeatures(base, s, { printing: false, shifts: false });
    const id = await openCard(base, s, 9);
    assert.equal((await post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' })).status, 200);
    assert.equal((await db.query('SELECT count(*)::int n FROM print_jobs')).rows[0].n, 0);
  });
});

test('split and combine cannot be switched off under an open combined bill', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 10);
    const b = await openCard(base, s, 11);
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));
    const r = await call(base, s, 'PATCH', '/api/features', { features: { split_combine: false } });
    assert.equal(r.status, 409);
    assert.equal((await get(base, s, '/api/features')).features.split_combine, true, 'nothing changed');
    await call(base, s, 'DELETE', `/api/bill-groups/${g.id}`);
    await setFeatures(base, s, { split_combine: false });
  });
});

test('a fresh database has no setup and every module reads on; the wizard finishes it', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const rows = (await db.query("SELECT key FROM settings WHERE key LIKE 'feature%' OR key = 'setup_completed'")).rows;
    assert.deepEqual(rows, [], 'the migration writes nothing on a fresh database');
    const f = await get(base, s, '/api/features');
    assert.equal(f.setup_completed, false, 'the wizard is shown');
    assert.deepEqual(f.features, allFlags(true));

    const r = await post(base, s, '/api/setup', {
      restaurant_name: 'Kedai Ali', restaurant_address: 'Jalan 1', sst_number: 'W10-1808-31000000',
      tax_rate_bp: 600, svc_rate_bp: 1000, card_count: 20, features: allFlags(false),
    });
    assert.equal(r.status, 200);
    const after = await get(base, s, '/api/features');
    assert.equal(after.setup_completed, true);
    assert.deepEqual(after.features, allFlags(false));
    const settings = await get(base, s, '/api/settings');
    assert.equal(settings.restaurant_name, 'Kedai Ali');
    assert.equal(settings.svc_rate_bp, 1000);
    assert.equal((await db.query('SELECT count(*)::int n FROM cards WHERE active')).rows[0].n, 20);

    // Lite end to end: an order is served at once and paid with no shift.
    const id = await openCard(base, s, 1);
    assert.equal((await orderRow(db, id)).status, 'served');
    assert.equal((await post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' })).status, 200);
    assert.equal((await orderRow(db, id)).status, 'paid');
  });
});

/* Runs every migration before 015 against a fresh schema, lets the test put a
   shop's history in place, then applies 015 — what an upgrade does. */
async function withPreFeaturesDb(before, fn) {
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
      if (file >= '015') break;
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

test('upgrading a shop that already has orders switches every module on and skips the wizard', async () => {
  await withPreFeaturesDb(async db => {
    const card = (await db.query('SELECT id FROM cards WHERE number = 1')).rows[0];
    await db.query(
      "INSERT INTO orders (card_id, status, source, order_type, total_cents) VALUES ($1, 'paid', 'staff', 'dine_in', 200)", [card.id]);
  }, async db => {
    const rows = Object.fromEntries((await db.query(
      "SELECT key, value FROM settings WHERE key LIKE 'feature%' OR key = 'setup_completed'")).rows.map(r => [r.key, r.value]));
    for (const m of MODULES) assert.equal(rows[`feature_${m}`], '1', m);
    assert.equal(rows.setup_completed, '1');

    const base = await startApp();
    const s = await setup(base);
    const f = await get(base, s, '/api/features');
    assert.equal(f.setup_completed, true, 'no wizard');
    assert.deepEqual(f.features, allFlags(true));
  });
});

test('upgrading a database with no orders yet leaves setup to the wizard', async () => {
  await withPreFeaturesDb(async () => {}, async db => {
    const n = (await db.query("SELECT count(*)::int n FROM settings WHERE key LIKE 'feature%' OR key = 'setup_completed'")).rows[0].n;
    assert.equal(n, 0);
  });
});
