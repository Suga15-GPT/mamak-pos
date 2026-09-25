const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { withDb, getFreePort, TEST_DATABASE_URL } = require('../helper');
const { BILL_LOCK_KEY } = require('../../src/lib/billlock');

// This file's own connections, told apart from other test files' — they run in
// parallel against the same database, and the bill lock is database-wide.
const APP_NAME = `features-test-${process.pid}`;
process.env.PGAPPNAME = APP_NAME;

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
const count = async (db, sql, params) => (await db.query(sql, params)).rows[0].n;

// A customer's round from the card's own QR; returns the order it landed on.
async function customerOrder(base, s, db, number, item = s.roti) {
  const r = await fetch(`${base}/api/public/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table_token: s.card(number).qr_token, items: [{ item_id: item.id, qty: 1 }] }),
  });
  assert.equal(r.status, 201, `a customer order on Card ${number}`);
  return (await db.query(
    "SELECT id FROM orders WHERE card_id = $1 AND status NOT IN ('paid','cancelled','refunded')", [s.card(number).id])).rows[0].id;
}
const pendingRound = async (db, orderId) => (await db.query(
  "SELECT id FROM order_sends WHERE order_id = $1 AND approval_state = 'pending'", [orderId])).rows[0].id;

// What a switch committed in SQL looks like to anything that reads the flag
// under the bill lock (the cache is not told — the point).
const setFlagSql = (tx, name, on) => tx.query(
  'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
  [`feature_${name}`, on ? '1' : '0']);

/* Takes the bill lock on a connection of its own, starts `request`, waits
   until that request is queued behind the lock, commits `change` (the payment,
   shift close, switch or cancel that got there first) and lets it through.
   This is the one ordering a check made before the lock gets wrong, forced
   every time instead of hoped for. Returns the request's response. */
async function behindLock(db, request, change) {
  const c = await db.pool.connect();
  let pending;
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [BILL_LOCK_KEY]);
    pending = request();
    pending.catch(() => {});
    for (let i = 0; ; i++) {
      const queued = await db.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'",
        [APP_NAME]);
      if (queued.rows[0]) break;
      if (i === 200) throw new Error('the request never queued behind the bill lock');
      await new Promise(r => setTimeout(r, 25));
    }
    await change(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return pending;
}

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
    dashboard: [['GET', '/api/dashboard'], ['GET', '/api/summary']],
  };
}

// Taps every ticket on every station's board through to served.
async function clearKitchenBoard(base, s) {
  const rest = { sent: ['preparing', 'ready', 'served'], preparing: ['ready', 'served'], ready: ['served'] };
  for (const st of await get(base, s, '/api/kitchen/stations')) {
    for (const t of (await get(base, s, `/api/kitchen/tickets?station=${st.code}`)).tickets) {
      for (const next of rest[t.status] || []) {
        assert.equal((await call(base, s, 'PATCH', `/api/kitchen/tickets/${t.id}`, { status: next })).status, 200);
      }
    }
  }
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
      // The calls above sent orders to the kitchen; its screen only switches
      // off once they're done (A2).
      if (mod === 'kitchen') await clearKitchenBoard(base, s);
      const res = await setFeatures(base, s, { ...allFlags(true), [mod]: false });
      const off = new Set([mod, ...res.switched_off]);
      for (const [m, list] of Object.entries(eps)) {
        for (const ep of list) {
          assert.equal(await isDisabled(base, s, ep), off.has(m), `${m} ${ep[0]} ${ep[1]} with only ${mod} off`);
        }
      }
    }
    // The core is never a module: taking an order and the menu still work with everything off.
    await clearKitchenBoard(base, s);
    await setFeatures(base, s, allFlags(false));
    assert.equal((await fetch(`${base}/api/menu`)).status, 200);
    assert.equal((await post(base, s, '/api/orders', { order_type: 'takeaway', items: [{ item_id: s.roti.id, qty: 1 }] })).status, 201);
    assert.equal(await isDisabled(base, s, ['GET', '/api/summary']), true, 'sales figures are the dashboard’s');
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

/* ===== each module against card mode's bill lock =====
   Every bill write takes one lock first (src/lib/billlock.js). These put the
   write that got there first in place while the other waits on that lock. */

test('shifts off: a combined bill paid in legs takes no shift and records none, like a single payment', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 12);
    const b = await openCard(base, s, 13, s.milo);
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));

    const legs = { legs: [{ method: 'Card', amount: 1 }, { method: 'Cash', tendered: 20 }] };
    const refused = await post(base, s, `/api/bill-groups/${g.id}/pay`, legs);
    assert.equal(refused.status, 400, 'shifts on and none open: refused, as a single payment is');
    assert.match((await json(refused)).error, /no shift is open/);

    await setFeatures(base, s, { shifts: false });
    assert.equal((await post(base, s, `/api/bill-groups/${g.id}/pay`, legs)).status, 200);
    const rows = (await db.query('SELECT method, shift_id FROM payments WHERE order_id = ANY($1::int[])', [[a, b]])).rows;
    assert.deepEqual([...new Set(rows.map(r => r.method))].sort(), ['Card', 'Cash'], 'both legs written');
    assert.ok(rows.every(r => r.shift_id === null), 'no leg carries a shift');
    for (const id of [a, b]) {
      const row = await orderRow(db, id);
      assert.equal(row.status, 'paid');
      assert.equal(row.closed_shift_id, null);
    }
  });
});

test('the open shift is read under the bill lock: a refund, payment or combined payment queued behind a shift close lands in no closed shift', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const openShift = async () => assert.equal((await post(base, s, '/api/shift/open', { float: 0 })).status, 201);
    const closeShift = tx => tx.query('UPDATE shifts SET closed_at = now() WHERE closed_at IS NULL');

    await openShift();
    const paid = await openCard(base, s, 14);
    assert.equal((await post(base, s, `/api/orders/${paid}/pay`, { method: 'Card' })).status, 200);
    const payment = (await db.query('SELECT id FROM payments WHERE order_id = $1', [paid])).rows[0].id;
    const single = await openCard(base, s, 15);
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [await openCard(base, s, 16), await openCard(base, s, 17)] }));

    const cases = [
      ['a refund', 'refunds', () => post(base, s, `/api/orders/${paid}/refunds`, { payment_id: payment, amount: 0.5, reason: 'cold roti' })],
      ['a payment', 'payments', () => post(base, s, `/api/orders/${single}/pay`, { method: 'Card' })],
      ['a combined payment', 'payments', () => post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: g.amount_due }] })],
    ];
    for (const [label, table, request] of cases) {
      const before = await count(db, `SELECT count(*)::int n FROM ${table}`);
      const r = await behindLock(db, request, closeShift);
      assert.equal(r.status, 400, `${label} queued behind a shift close is refused`);
      assert.match((await json(r)).error, /no shift is open/);
      assert.equal(await count(db, `SELECT count(*)::int n FROM ${table}`), before, `${label} wrote nothing into the closed shift`);
      await openShift();
    }

    // The switch itself is read under the lock too. Shifts only go off with no
    // shift open (A1), so close it first; a payment queued behind shifts going
    // back on and a shift opening is taken into that shift, not recorded in
    // none and left out of its cash-up.
    assert.equal((await post(base, s, '/api/shift/close', { counted: 0 })).status, 200);
    await setFeatures(base, s, { shifts: false });
    const late = await openCard(base, s, 18);
    const admin = (await db.query("SELECT id FROM users WHERE name = 'Admin'")).rows[0].id;
    const r = await behindLock(db, () => post(base, s, `/api/orders/${late}/pay`, { method: 'Card' }), async tx => {
      await setFlagSql(tx, 'shifts', true);
      await tx.query('INSERT INTO shifts (opened_by, float_cents) VALUES ($1, 0)', [admin]);
    });
    assert.equal(r.status, 200);
    const open = (await db.query('SELECT id FROM shifts WHERE closed_at IS NULL')).rows[0].id;
    assert.equal((await db.query('SELECT shift_id FROM payments WHERE order_id = $1', [late])).rows[0].shift_id, open);
  });
});

test('Split and combine: the switch and a combine each wait on the bill lock and re-read under it, so neither slips past the other', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 18);
    const b = await openCard(base, s, 19);
    const openGroups = () => count(db, 'SELECT count(*)::int n FROM bill_groups WHERE closed_at IS NULL');

    // A combine lands first: the switch, queued behind it, sees the combined bill.
    const off = await behindLock(db, () => call(base, s, 'PATCH', '/api/features', { features: { split_combine: false } }), async tx => {
      const g = (await tx.query('INSERT INTO bill_groups (created_by) VALUES (NULL) RETURNING id')).rows[0].id;
      await tx.query('UPDATE orders SET bill_group_id = $1 WHERE id = ANY($2::int[])', [g, [a, b]]);
    });
    assert.equal(off.status, 409);
    assert.equal((await get(base, s, '/api/features')).features.split_combine, true, 'nothing switched');
    const gid = (await orderRow(db, a)).bill_group_id;
    assert.equal((await call(base, s, 'DELETE', `/api/bill-groups/${gid}`)).status, 200);

    // The switch lands first: a combine the route let through is refused under the lock.
    const combine = await behindLock(db, () => post(base, s, '/api/bill-groups', { order_ids: [a, b] }),
      tx => setFlagSql(tx, 'split_combine', false));
    assert.equal(combine.status, 404);
    assert.equal((await json(combine)).error, 'feature_disabled');
    assert.equal(await openGroups(), 0, 'no combined bill opened after the switch');
  });
});

test('QR: not switched off under a round awaiting approval, and no customer round lands after the switch', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    assert.equal((await call(base, s, 'PATCH', '/api/settings', { qr_require_approval: true })).status, 200);
    const qrOff = () => call(base, s, 'PATCH', '/api/features', { features: { qr: false } });

    const held = await customerOrder(base, s, db, 20);
    const refused = await qrOff();
    assert.equal(refused.status, 409);
    assert.match((await json(refused)).error, /waiting for approval/);
    assert.equal((await get(base, s, '/api/features')).features.qr, true, 'nothing switched');
    assert.equal((await post(base, s, `/api/kitchen/sends/${await pendingRound(db, held)}/approve`)).status, 200);

    // A customer round lands first: the switch, queued behind it, sees it waiting.
    const off = await behindLock(db, qrOff, async tx => {
      const o = (await tx.query(
        "INSERT INTO orders (card_id, status, source, order_type) VALUES ($1, 'sent', 'qr', 'dine_in') RETURNING id", [s.card(21).id])).rows[0].id;
      await tx.query("INSERT INTO order_sends (order_id, seq_no, source, approval_state) VALUES ($1, 1, 'qr', 'pending')", [o]);
    });
    assert.equal(off.status, 409);
    assert.equal((await get(base, s, '/api/features')).features.qr, true, 'nothing switched');

    // The switch lands first: a round the route let through is refused under the lock.
    const late = await behindLock(db, () => fetch(`${base}/api/public/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table_token: s.card(22).qr_token, items: [{ item_id: s.roti.id, qty: 1 }] }),
    }), tx => setFlagSql(tx, 'qr', false));
    assert.equal(late.status, 404);
    assert.equal((await json(late)).error, 'feature_disabled');
    assert.equal(await count(db, 'SELECT count(*)::int n FROM orders WHERE card_id = $1', [s.card(22).id]), 0,
      'no order, and no round left awaiting an approval queue that is gone');
  });
});

test('kitchen off: an accepted customer round is born served; an add-on or an acceptance queued behind a payment or a cancel never writes onto the closed bill', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await setFeatures(base, s, { kitchen: false });
    assert.equal((await call(base, s, 'PATCH', '/api/settings', { qr_require_approval: true })).status, 200);
    const ticketStatuses = async sendId => (await db.query(
      'SELECT status FROM order_send_tickets WHERE send_id = $1', [sendId])).rows.map(r => r.status);

    // Accepting through the approval queue: born served, and the order says so.
    const q = await customerOrder(base, s, db, 23);
    const qRound = await pendingRound(db, q);
    assert.equal((await post(base, s, `/api/kitchen/sends/${qRound}/approve`)).status, 200);
    assert.deepEqual(await ticketStatuses(qRound), ['served']);
    assert.equal((await orderRow(db, q)).status, 'served');

    // An add-on queued behind the payment that closed the bill: refused, still paid.
    const id = await openCard(base, s, 24);
    const add = await behindLock(db, () => post(base, s, `/api/orders/${id}/items`, { items: [{ item_id: s.milo.id, qty: 1 }] }), async tx => {
      const { total_cents: total } = (await tx.query('SELECT total_cents FROM orders WHERE id = $1', [id])).rows[0];
      await tx.query("INSERT INTO payments (order_id, method, amount_cents) VALUES ($1, 'Card', $2)", [id, total]);
      await tx.query("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [id]);
    });
    assert.equal(add.status, 400);
    assert.equal((await json(add)).error, 'order closed');
    assert.equal((await orderRow(db, id)).status, 'paid');
    assert.equal(await count(db, 'SELECT count(*)::int n FROM order_sends WHERE order_id = $1', [id]), 1, 'no new round');

    // An acceptance queued behind a cancel: refused, still cancelled, nothing born served.
    const c = await customerOrder(base, s, db, 25);
    const cRound = await pendingRound(db, c);
    const approve = await behindLock(db, () => post(base, s, `/api/kitchen/sends/${cRound}/approve`),
      tx => tx.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [c]));
    assert.equal(approve.status, 409);
    assert.equal((await orderRow(db, c)).status, 'cancelled');
    assert.deepEqual(await ticketStatuses(cRound), []);

    // The switch is read under the lock: an order queued behind the kitchen
    // screen going off is born served, not left 'sent' for a screen that's gone.
    await setFeatures(base, s, { kitchen: true });
    const r = await behindLock(db, () => post(base, s, '/api/orders', { card_id: s.card(26).id, items: [{ item_id: s.roti.id, qty: 1 }] }),
      tx => setFlagSql(tx, 'kitchen', false));
    assert.equal(r.status, 201);
    assert.equal((await orderRow(db, (await json(r)).id)).status, 'served');
  });
});

// What migration 017 freezes on a closed order (paid → refunded aside).
const FROZEN = ['card_id', 'table_id', 'order_type', 'subtotal_cents', 'service_charge_cents', 'tax_cents',
  'discount_cents', 'rounding_cents', 'total_cents', 'tax_rate_bp', 'svc_rate_bp'];
const frozenCols = async (db, id) => { const o = await orderRow(db, id); return Object.fromEntries(FROZEN.map(k => [k, o[k]])); };

test('kitchen and shifts off, a bill settled by cash rounding or by a comp is frozen (017); refunding it only changes its status', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await setFeatures(base, s, { kitchen: false, shifts: false });

    // 3 × RM2.00 + 6% SST = RM6.36, paid in cash as RM6.35: the rounding is
    // written while the bill is open, by the payment that settles it.
    const a = await openCard(base, s, 1, s.roti, 3);
    assert.equal((await orderRow(db, a)).status, 'served', 'born served');
    assert.equal((await post(base, s, `/api/orders/${a}/pay`, { method: 'Cash' })).status, 200);
    const paid = await orderRow(db, a);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.rounding_cents, -1);
    assert.equal(paid.closed_shift_id, null);
    const atClose = await frozenCols(db, a);

    const payment = (await db.query('SELECT id, amount_cents, shift_id FROM payments WHERE order_id = $1', [a])).rows[0];
    assert.equal(payment.shift_id, null);
    const refund = await post(base, s, `/api/orders/${a}/refunds`, { payment_id: payment.id, amount: payment.amount_cents / 100, reason: 'wrong order' });
    assert.equal(refund.status, 200);
    assert.equal((await json(refund)).refunded_to_zero, true);
    assert.equal((await orderRow(db, a)).status, 'refunded');
    assert.deepEqual(await frozenCols(db, a), atClose, 'the refund changed only the status');

    // An add-on onto the closed bill — the born-served path — is refused before it writes.
    assert.equal((await post(base, s, `/api/orders/${a}/items`, { items: [{ item_id: s.milo.id, qty: 1 }] })).status, 400);
    assert.deepEqual(await frozenCols(db, a), atClose);
    assert.equal((await orderRow(db, a)).status, 'refunded');

    // A comp settles through settleIfMatchesPaid, with no shift to close into.
    const b = await openCard(base, s, 2);
    assert.equal((await post(base, s, `/api/orders/${b}/discounts`, { kind: 'comp', reason: 'regular customer' })).status, 200);
    const comped = await orderRow(db, b);
    assert.equal(comped.status, 'paid');
    assert.equal(comped.total_cents, 0);
    assert.equal(comped.closed_shift_id, null);
  });
});

/* ===== the setup-and-features review (A1–A5) ===== */

const SHIFT_OPEN_REFUSAL = 'Close the open shift before switching shifts off.';
const KITCHEN_BUSY_REFUSAL = 'Finish or clear the kitchen board before switching the kitchen screen off.';
const flagRow = async (db, m) => (await db.query('SELECT value FROM settings WHERE key = $1', [`feature_${m}`])).rows[0]?.value;
const kitchenTicket = async (base, s, orderId) =>
  (await get(base, s, '/api/kitchen/tickets?station=kitchen')).tickets.find(t => t.order_id === orderId);

/* Run i of a race: a third of the runs start both requests at once, a third
   let the first lead by 15 ms and a third the second. Left to chance, one
   side can win every time (a switch reaches the bill lock before an order
   does), so the ordering that matters would never be tried. */
function race(i, first, second) {
  const lag = ms => new Promise(r => setTimeout(r, ms));
  if (i % 3 === 1) return Promise.all([first(), lag(15).then(second)]);
  if (i % 3 === 2) return Promise.all([lag(15).then(first), second()]);
  return Promise.all([first(), second()]);
}

test('A1 shifts can\'t be switched off while a shift is open, in Admin or in the wizard; switched on with none open, the answer says so', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    assert.equal((await post(base, s, '/api/shift/open', { float: 0 })).status, 201);
    assert.equal((await get(base, s, '/api/features')).shift_open, true);

    const refused = await call(base, s, 'PATCH', '/api/features', { features: { shifts: false } });
    assert.equal(refused.status, 409);
    assert.equal((await json(refused)).error, SHIFT_OPEN_REFUSAL);
    assert.equal((await get(base, s, '/api/features')).features.shifts, true, 'nothing switched');

    // The wizard's Finish is refused the same way, and writes nothing at all.
    const finish = await post(base, s, '/api/setup', {
      restaurant_name: 'Kedai Baru', card_count: 20, features: { ...allFlags(true), shifts: false },
    });
    assert.equal(finish.status, 409);
    assert.equal((await json(finish)).error, SHIFT_OPEN_REFUSAL);
    assert.equal(await count(db, 'SELECT count(*)::int n FROM cards WHERE active'), 50);
    assert.notEqual((await get(base, s, '/api/settings')).restaurant_name, 'Kedai Baru');
    const f = await get(base, s, '/api/features');
    assert.equal(f.features.shifts, true);
    assert.equal(f.setup_completed, false);

    // Closed, shifts switch off; back on with no shift open, the answer says
    // payments will be refused — and they are, until a shift opens.
    assert.equal((await post(base, s, '/api/shift/close', { counted: 0 })).status, 200);
    assert.equal((await setFeatures(base, s, { shifts: false })).features.shifts, false);
    const back = await setFeatures(base, s, { shifts: true });
    assert.equal(back.shift_open, false);
    assert.equal((await get(base, s, '/api/features')).shift_open, false);
    const id = await openCard(base, s, 30);
    assert.match((await json(await post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }))).error, /no shift is open/);
  });
});

test('A1 race: switching shifts off and opening a shift never leave shifts off with a shift open: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const [sw, opened] = await race(i,
        () => call(base, s, 'PATCH', '/api/features', { features: { shifts: false } }),
        () => post(base, s, '/api/shift/open', { float: 0 }));
      assert.ok([200, 409].includes(sw.status) && [201, 404].includes(opened.status), `run ${i}: switch ${sw.status}, open ${opened.status}`);
      seen.add(sw.status);
      const off = await flagRow(db, 'shifts') === '0';
      const open = await count(db, 'SELECT count(*)::int n FROM shifts WHERE closed_at IS NULL');
      assert.ok(!(off && open), `run ${i}: shifts switched off with a shift open`);
      assert.equal(sw.status === 200, off, `run ${i}: the switch's answer matches the stored flag`);
      if (off) await setFeatures(base, s, { shifts: true });
      if (open) assert.equal((await post(base, s, '/api/shift/close', { counted: 0 })).status, 200);
    }
    assert.deepEqual([...seen].sort(), [200, 409], 'both orderings happened: the switch first, and the shift first');
  });
});

test('A2 the kitchen screen can\'t be switched off while a ticket on an open bill is unfinished, in Admin or in the wizard', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const id = await openCard(base, s, 31);
    const ticket = await kitchenTicket(base, s, id);
    assert.equal((await call(base, s, 'PATCH', `/api/kitchen/tickets/${ticket.id}`, { status: 'preparing' })).status, 200);

    const refused = await call(base, s, 'PATCH', '/api/features', { features: { kitchen: false } });
    assert.equal(refused.status, 409);
    assert.equal((await json(refused)).error, KITCHEN_BUSY_REFUSAL);
    assert.equal((await get(base, s, '/api/features')).features.kitchen, true, 'nothing switched');
    const finish = await post(base, s, '/api/setup', { features: { ...allFlags(true), kitchen: false } });
    assert.equal(finish.status, 409);
    assert.equal((await json(finish)).error, KITCHEN_BUSY_REFUSAL);

    // Finished, the board is clear and the switch goes through.
    for (const st of ['ready', 'served']) {
      assert.equal((await call(base, s, 'PATCH', `/api/kitchen/tickets/${ticket.id}`, { status: st })).status, 200);
    }
    assert.equal((await setFeatures(base, s, { kitchen: false })).features.kitchen, false);
  });
});

test('A2 race: switching the kitchen off and sending an order never leave the kitchen off with unfinished work: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const [sw, sent] = await race(i,
        () => call(base, s, 'PATCH', '/api/features', { features: { kitchen: false } }),
        () => post(base, s, '/api/orders', { card_id: s.card((i % 50) + 1).id, items: [{ item_id: s.roti.id, qty: 1 }] }));
      assert.ok([200, 409].includes(sw.status) && sent.status === 201, `run ${i}: switch ${sw.status}, send ${sent.status}`);
      seen.add(sw.status);
      const off = await flagRow(db, 'kitchen') === '0';
      const unfinished = await count(db,
        `SELECT count(*)::int n FROM order_send_tickets t JOIN order_sends x ON x.id = t.send_id JOIN orders o ON o.id = x.order_id
          WHERE t.status NOT IN ('served', 'cancelled') AND o.status NOT IN ('paid', 'cancelled', 'refunded')`);
      assert.ok(!(off && unfinished), `run ${i}: kitchen switched off with ${unfinished} unfinished ticket(s)`);
      assert.equal(sw.status === 200, off, `run ${i}: the switch's answer matches the stored flag`);
      assert.equal((await call(base, s, 'PATCH', `/api/orders/${(await json(sent)).id}`, { status: 'cancelled' })).status, 200);
      if (off) await setFeatures(base, s, { kitchen: true });
    }
    assert.deepEqual([...seen].sort(), [200, 409], 'both orderings happened: the switch first, and the order first');
  });
});

test('A2 a paid, refunded or cancelled order\'s tickets are never on the kitchen board, and a tap on one is refused', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    assert.equal((await post(base, s, '/api/shift/open', { float: 0 })).status, 201);
    const tap = (ticketId, status) => call(base, s, 'PATCH', `/api/kitchen/tickets/${ticketId}`, { status });
    const ticketStatus = async ticketId => (await db.query('SELECT status FROM order_send_tickets WHERE id = $1', [ticketId])).rows[0].status;
    const refusedTap = async (ticketId, label) => {
      const r = await tap(ticketId, 'ready');
      assert.equal(r.status, 409, label);
      assert.match((await json(r)).error, /kitchen ticket can no longer be moved/);
    };

    // Paid while it was cooking: off the board, and it stays where it was.
    const paid = await openCard(base, s, 32);
    const tp = (await kitchenTicket(base, s, paid)).id;
    assert.equal((await tap(tp, 'preparing')).status, 200);
    assert.equal((await post(base, s, `/api/orders/${paid}/pay`, { method: 'Card' })).status, 200);
    assert.equal(await kitchenTicket(base, s, paid), undefined, 'paid: not on the board');
    await refusedTap(tp, 'paid');
    assert.equal(await ticketStatus(tp), 'preparing');

    // Refunded in full.
    const payment = (await db.query('SELECT id, amount_cents FROM payments WHERE order_id = $1', [paid])).rows[0];
    assert.equal((await post(base, s, `/api/orders/${paid}/refunds`, { payment_id: payment.id, amount: payment.amount_cents / 100, reason: 'never came' })).status, 200);
    assert.equal((await orderRow(db, paid)).status, 'refunded');
    assert.equal(await kitchenTicket(base, s, paid), undefined, 'refunded: not on the board');
    await refusedTap(tp, 'refunded');

    // Cancelled.
    const cancelled = await openCard(base, s, 33);
    const tc = (await kitchenTicket(base, s, cancelled)).id;
    assert.equal((await call(base, s, 'PATCH', `/api/orders/${cancelled}`, { status: 'cancelled' })).status, 200);
    assert.equal(await kitchenTicket(base, s, cancelled), undefined, 'cancelled: not on the board');
    await refusedTap(tc, 'cancelled');

    // A tap queued behind the payment that closes the bill is refused too.
    const q = await openCard(base, s, 34);
    const tq = (await kitchenTicket(base, s, q)).id;
    const late = await behindLock(db, () => tap(tq, 'preparing'), async tx => {
      const { total_cents: total } = (await tx.query('SELECT total_cents FROM orders WHERE id = $1', [q])).rows[0];
      await tx.query("INSERT INTO payments (order_id, method, amount_cents) VALUES ($1, 'Card', $2)", [q, total]);
      await tx.query("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [q]);
    });
    assert.equal(late.status, 409);
    assert.equal(await ticketStatus(tq), 'sent');
  });
});

test('A2 race: a kitchen tap and a payment never leave a paid bill on the board, or its ticket moved by a refused tap: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    assert.equal((await post(base, s, '/api/shift/open', { float: 0 })).status, 201);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, (i % 50) + 1);
      const t = await kitchenTicket(base, s, id);
      const [tapped, paid] = await race(i,
        () => call(base, s, 'PATCH', `/api/kitchen/tickets/${t.id}`, { status: 'preparing' }),
        () => post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }));
      assert.ok([200, 409].includes(tapped.status) && paid.status === 200, `run ${i}: tap ${tapped.status}, pay ${paid.status}`);
      seen.add(tapped.status);
      const status = (await db.query('SELECT status FROM order_send_tickets WHERE id = $1', [t.id])).rows[0].status;
      assert.equal(status, tapped.status === 200 ? 'preparing' : 'sent', `run ${i}: the ticket moved only on an accepted tap`);
      assert.equal((await orderRow(db, id)).status, 'paid', `run ${i}`);
      assert.equal(await kitchenTicket(base, s, id), undefined, `run ${i}: the paid bill is on the kitchen board`);
    }
    assert.deepEqual([...seen].sort(), [200, 409], 'both orderings happened: the tap first, and the payment first');
  });
});

test('A3 /api/summary belongs to the dashboard: it answers with the dashboard on and 404s feature_disabled with it off', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const on = await fetch(`${base}/api/summary`, { headers: s.h });
    assert.equal(on.status, 200);
    assert.ok('today' in (await json(on)));
    await setFeatures(base, s, { dashboard: false });
    assert.equal(await isDisabled(base, s, ['GET', '/api/summary']), true);
  });
});

test('A5 a Finish that is refused changes nothing — not the card count either; one that goes through writes it all together', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [await openCard(base, s, 5), await openCard(base, s, 6)] }));
    const activeCards = () => count(db, 'SELECT count(*)::int n FROM cards WHERE active');
    const audits = () => count(db, "SELECT count(*)::int n FROM audit_log WHERE action IN ('cards.count', 'setup.complete', 'features.update')");
    const before = { cards: await activeCards(), audits: await audits(), settings: await get(base, s, '/api/settings') };
    const body = { restaurant_name: 'Kedai Lain', tax_rate_bp: 800, card_count: 20, features: { ...allFlags(true), split_combine: false } };

    // Refused (a combined bill is open): nothing is written.
    const r = await post(base, s, '/api/setup', body);
    assert.equal(r.status, 409);
    assert.equal(await activeCards(), before.cards, 'the card count is unchanged');
    assert.equal(await audits(), before.audits, 'nothing audited');
    const settings = await get(base, s, '/api/settings');
    assert.equal(settings.restaurant_name, before.settings.restaurant_name);
    assert.equal(settings.tax_rate_bp, before.settings.tax_rate_bp);
    const f = await get(base, s, '/api/features');
    assert.equal(f.setup_completed, false);
    assert.equal(f.features.split_combine, true);

    // With the combined bill taken apart, the same Finish writes all of it.
    assert.equal((await call(base, s, 'DELETE', `/api/bill-groups/${g.id}`)).status, 200);
    assert.equal((await post(base, s, '/api/setup', body)).status, 200);
    assert.equal(await activeCards(), 20);
    const after = await get(base, s, '/api/settings');
    assert.equal(after.restaurant_name, 'Kedai Lain');
    assert.equal(after.tax_rate_bp, 800);
    const done = await get(base, s, '/api/features');
    assert.equal(done.setup_completed, true);
    assert.equal(done.features.split_combine, false);
  });
});

test('a fresh database has no setup and every module reads on; the wizard finishes it', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    // Card mode's 015, this module's 016, the follow-ups' 017 and this
    // module's 018, in that order.
    const applied = (await db.query('SELECT version FROM schema_migrations ORDER BY applied_at, version')).rows
      .map(r => r.version).filter(v => /^01[5-8]_/.test(v));
    assert.deepEqual(applied,
      ['015_closed_orders_stay_closed.sql', '016_features.sql', '017_closed_orders_frozen.sql', '018_features_existing_shops.sql']);
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

/* A shop on main before this module: every migration but this module's own
   (016 and 018) against a fresh schema — card mode's 015 and the follow-ups'
   017 included. The test puts the shop's history in place, then the upgrade
   runs: 016 and 018, after 017, which is what upgrading a shop from main does. */
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
      if (/^01[68]_/.test(file)) continue;
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
    const applied = (await db.query('SELECT version FROM schema_migrations ORDER BY applied_at, version')).rows.map(r => r.version);
    assert.deepEqual(applied.slice(-2), ['016_features.sql', '018_features_existing_shops.sql'], 'the upgrade ran 016 and 018, after 017');
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

test('a database with no users yet — a fresh install, migrated before seeding — leaves setup to the wizard', async () => {
  await withPreFeaturesDb(async () => {}, async db => {
    const n = (await db.query("SELECT count(*)::int n FROM settings WHERE key LIKE 'feature%' OR key = 'setup_completed'")).rows[0].n;
    assert.equal(n, 0);
  });
});

test('A4 an installed shop that never took an order keeps every module on and skips the wizard after upgrading', async () => {
  await withPreFeaturesDb(async db => {
    // Installed and set up — its admin exists — but no order taken yet.
    const { hashPin } = require('../../src/lib/auth');
    await db.query("INSERT INTO users (name, role, pin_hash) VALUES ('Admin', 'admin', $1)", [hashPin('1234')]);
    assert.equal(await count(db, 'SELECT count(*)::int n FROM orders'), 0);
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
