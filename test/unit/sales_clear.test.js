const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const {
  startApp, login, headers, setup, post, patch, get, json, openCard, one, race, orderRow,
} = require('../apphelper');

/* Clear sales data (day-one fixes, part 1): Admin -> System moves every sales
   row into archive_YYYYMMDD_HHMMSS, under the bill lock, copy first and then
   remove; the menu, staff, cards, settings, features and the audit log stay;
   every figure reads RM0; numbering carries on; the runbook's script puts it
   back. */

const RESTORE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'restore-sales-archive.js');
const ARCHIVE = /^archive_\d{8}_\d{6}(_\d+)?$/;

const ok = async (pending, label) => {
  const res = await pending;
  assert.ok(res.status < 300, `${label}: ${res.status} ${await res.clone().text()}`);
  return res;
};
const pay = (base, s, id, body) => ok(post(base, s, `/api/orders/${id}/pay`, body), `pay ${id}`);
const clear = (base, s, body = { pin: '1234', confirm: 'CLEAR' }) => post(base, s, '/api/admin/sales/clear', body);

// Everything still to make, taken to served, station by station.
async function finishBoard(base, s) {
  const next = { sent: ['preparing', 'ready', 'served'], preparing: ['ready', 'served'], ready: ['served'] };
  for (const station of ['kitchen', 'drinks']) {
    const { tickets } = await get(base, s, `/api/kitchen/tickets?station=${station}`);
    for (const t of tickets.filter(x => x.status !== 'served')) {
      for (const st of next[t.status]) await ok(patch(base, s, `/api/kitchen/tickets/${t.id}`, { status: st }), `ticket ${t.id}`);
    }
  }
}

async function closeShift(base, s) {
  const shift = await get(base, s, '/api/shift/current');
  if (!shift) return;
  const rep = await get(base, s, `/api/shift/${shift.id}/report`);
  await ok(post(base, s, '/api/shift/close', { counted: rep.cash.expected_cents / 100 }), 'close shift');
}

/* A day's trading that touches every sales table: cash with change, a
   discount, a void, a refund, a takeaway, a merge paid by items, a combined
   bill from before, a cancelled bill, cash out of the drawer, and failed
   print jobs (printing on, no printer). Finished: nothing open, the board
   cleared, the shift closed. */
async function trade(base, s) {
  const ids = {};
  // A dish with food options (order_item_mods): one answer to each question.
  const menu = await get(base, s, '/api/menu');
  const kandar = menu.items.find(i => i.modifier_group_ids.length);
  const answers = kandar.modifier_group_ids.map(gid => menu.modifier_options.find(o => o.group_id === gid).id);
  ids.a = await openCard(base, s, 1, [
    { item_id: s.roti.id, qty: 2 }, { item_id: s.teh.id, qty: 1 },
    { item_id: kandar.id, qty: 1, modifier_option_ids: answers },
  ]);
  await pay(base, s, ids.a, { method: 'Cash', tendered: 50 });
  ids.b = await openCard(base, s, 2, one(s.mee));
  await ok(post(base, s, `/api/orders/${ids.b}/discounts`, { kind: 'percent', value: 10, reason: 'regular customer' }), 'discount');
  await pay(base, s, ids.b, { method: 'Card' });
  ids.c = await openCard(base, s, 3, [{ item_id: s.roti.id, qty: 1 }, { item_id: s.telur.id, qty: 1 }]);
  const line = (await get(base, s, '/api/orders')).find(o => o.id === ids.c).items[0];
  await ok(post(base, s, `/api/orders/${ids.c}/items/${line.id}/void`, { reason: 'changed their mind' }), 'void');
  await pay(base, s, ids.c, { method: 'DuitNow/eWallet' });
  ids.d = await openCard(base, s, 4, one(s.mee));
  await pay(base, s, ids.d, { method: 'Card' });
  const paymentId = (await get(base, s, '/api/orders?mode=recent')).find(o => o.id === ids.d).payments[0].id;
  await ok(post(base, s, `/api/orders/${ids.d}/refunds`, { payment_id: paymentId, amount: 2, reason: 'cold food' }), 'refund');
  ids.e = (await json(await ok(post(base, s, '/api/orders', { order_type: 'takeaway', items: one(s.roti) }), 'takeaway'))).id;
  await pay(base, s, ids.e, { method: 'Cash' });
  ids.f = await openCard(base, s, 5, one(s.roti));
  ids.g = await openCard(base, s, 6, one(s.mee));
  await ok(post(base, s, `/api/orders/${ids.f}/merge`, { from_order_id: ids.g }), 'merge');
  const [first, second] = (await get(base, s, '/api/orders')).find(o => o.id === ids.f).items;
  await pay(base, s, ids.f, { method: 'Card', item_ids: [first.id] });
  await pay(base, s, ids.f, { method: 'Cash', item_ids: [second.id] });
  ids.h = await openCard(base, s, 7, one(s.roti));
  ids.i = await openCard(base, s, 8, one(s.roti));
  const g = await json(await ok(post(base, s, '/api/bill-groups', { order_ids: [ids.h, ids.i] }), 'group'));
  await ok(post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: g.amount_due }] }), 'group pay');
  ids.j = await openCard(base, s, 9, one(s.roti));
  await ok(patch(base, s, `/api/orders/${ids.j}`, { status: 'cancelled' }), 'cancel');
  await ok(post(base, s, '/api/shift/movements', { kind: 'payout', amount: 5, reason: 'ice supplier' }), 'payout');
  await finishBoard(base, s);
  await closeShift(base, s);
  return ids;
}

const schemaOf = async db => (await db.query('SELECT current_schema() AS s')).rows[0].s;
async function tableState(db, schema, table) {
  return (await db.query(
    `SELECT count(*)::int AS n, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM "${schema}"."${table}" t`)).rows[0];
}
async function snapshot(db, schema, tables) {
  const out = {};
  for (const t of tables) out[t] = await tableState(db, schema, t);
  return out;
}
async function dropArchives(db, names) {
  for (const n of names) if (ARCHIVE.test(n)) await db.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`);
}
const archivesNow = async db => (await db.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'archive\\_%'")).rows.map(r => r.nspname);

test('every table is classified: sales tables move, the rest stay, and the move order satisfies every foreign key', async () => {
  await withDb(async db => {
    await startApp();
    const { SALES_TABLES, KEPT_TABLES } = require('../../src/services/sales_archive');
    const schema = await schemaOf(db);
    const tables = (await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'", [schema])).rows.map(r => r.table_name);
    assert.deepEqual([...tables].sort(), [...SALES_TABLES, ...KEPT_TABLES].sort(),
      'a new table must be named as a sales table or a kept one');
    assert.equal(new Set([...SALES_TABLES, ...KEPT_TABLES]).size, SALES_TABLES.length + KEPT_TABLES.length);

    const fks = (await db.query(
      `SELECT cl.relname AS child, pr.relname AS parent, c.conname
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class pr ON pr.oid = c.confrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE c.contype = 'f' AND n.nspname = $1`, [schema])).rows;
    for (const fk of fks) {
      if (KEPT_TABLES.includes(fk.child)) {
        assert.ok(!SALES_TABLES.includes(fk.parent), `${fk.conname}: a kept table must not point into a sales table`);
      } else if (SALES_TABLES.includes(fk.parent) && fk.child !== fk.parent) {
        assert.ok(SALES_TABLES.indexOf(fk.child) < SALES_TABLES.indexOf(fk.parent),
          `${fk.conname}: ${fk.child} must leave before ${fk.parent}`);
      }
    }
    // The idempotency keys are columns of two of the sales tables.
    const idem = (await db.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'idempotency_key' ORDER BY 1", [schema])).rows;
    assert.deepEqual(idem.map(r => r.table_name), ['order_items', 'orders']);
  });
});

test('Clear sales data is admin only, and needs the admin\'s own PIN and the word CLEAR; a refusal changes nothing', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await trade(base, s);
    const schema = await schemaOf(db);
    const { SALES_TABLES } = require('../../src/services/sales_archive');
    const before = await snapshot(db, schema, SALES_TABLES);
    const archives = await archivesNow(db);

    assert.equal((await post(base, s, '/api/admin/users', { name: 'Siti', role: 'staff', pin: '4826' })).status, 200);
    const staff = { h: headers(await login(base, 'Siti', '4826')) };
    const asStaff = await post(base, staff, '/api/admin/sales/clear', { pin: '4826', confirm: 'CLEAR' });
    assert.equal(asStaff.status, 403);
    assert.equal((await fetch(`${base}/api/admin/sales/clear`, { headers: staff.h })).status, 403);

    const wrongPin = await clear(base, s, { pin: '9999', confirm: 'CLEAR' });
    assert.equal(wrongPin.status, 403);
    assert.equal((await json(wrongPin)).error, 'That PIN is not right.');
    for (const confirm of [undefined, '', 'clear', 'CLEAR IT']) {
      const r = await clear(base, s, { pin: '1234', confirm });
      assert.equal(r.status, 400, `confirm ${confirm}`);
      assert.equal((await json(r)).error, 'Type CLEAR to confirm.');
    }

    assert.deepEqual(await snapshot(db, schema, SALES_TABLES), before, 'nothing moved');
    assert.deepEqual(await archivesNow(db), archives, 'no archive made');
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE action = 'sales.clear'")).rows[0].n, 0);

    // Five wrong PINs, and even the right one waits; a right PIN spends none.
    for (let i = 0; i < 4; i++) assert.equal((await clear(base, s, { pin: '0000', confirm: 'CLEAR' })).status, 403);
    const locked = await clear(base, s);
    assert.equal(locked.status, 429);
    assert.deepEqual(await snapshot(db, schema, SALES_TABLES), before);
  });
});

/* The admin's PIN is counted before anything is awaited, as at login: from a
   till left logged in, 25 wrong PINs at once get exactly five checks, and a
   right PIN racing them spends none. */
test('race: 25 wrong PINs at once on Clear sales data — exactly 5 are checked and the other 20 get 429, and a right PIN racing them spends none: 20 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    await setup(base, { shift: false });
    const { hashPin } = require('../../src/lib/auth');
    const tally = rs => rs.reduce((t, r) => ({ ...t, [r.status]: (t[r.status] || 0) + 1 }), {});
    let rightIn = 0;
    let rightLockedOut = 0;
    for (let i = 0; i < 20; i++) {
      // The limit is per admin, so each run is a different one.
      const name = `Owner ${i}`;
      await db.query("INSERT INTO users (name, role, pin_hash) VALUES ($1, 'admin', $2)", [name, hashPin('7392')]);
      const a = { h: headers(await login(base, name, '7392')) };
      const [right, wrong] = await race(i,
        () => clear(base, a, { pin: '7392', confirm: 'CLEAR' }),
        () => Promise.all(Array.from({ length: 25 }, () => clear(base, a, { pin: '0000', confirm: 'CLEAR' }))));
      assert.deepEqual(tally(wrong), { 403: 5, 429: 20 }, `run ${i}: exactly five wrong PINs checked`);
      // Let in, the right PIN finds nothing to clear; after the fifth wrong one it waits.
      assert.ok([409, 429].includes(right.status), `run ${i}: the right PIN got ${right.status}`);
      if (right.status === 409) rightIn++; else rightLockedOut++;
      assert.equal((await clear(base, a, { pin: '7392', confirm: 'CLEAR' })).status, 429, `run ${i}: that admin waits`);
    }
    assert.ok(rightIn > 0 && rightLockedOut > 0, `right PIN in: ${rightIn} runs; locked out: ${rightLockedOut} runs`);
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE action = 'sales.clear'")).rows[0].n, 0, 'nothing was cleared');
  });
});

test('Clear sales data is refused while a bill, a shift or a kitchen ticket is open — one sentence each — and when there is nothing to clear', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);                      // a shift is open
    const made = [];
    try {
      const c1 = await openCard(base, s, 1, one(s.roti));
      const ta = (await json(await post(base, s, '/api/orders', { order_type: 'takeaway', items: one(s.mee) }))).id;
      await pay(base, s, ta, { method: 'Cash' });     // paid, its ticket still to cook

      const BILL = 'A bill is still open (Card 1). Take payment on it or cancel it first.';
      const SHIFT = 'A shift is still open. Close it on 🕐 Shift first.';
      const KITCHEN = 'The kitchen still has 2 tickets to finish. Finish or clear the kitchen board first.';
      const preview = await get(base, s, '/api/admin/sales/clear');
      assert.deepEqual(preview.reasons, [BILL, SHIFT, KITCHEN]);
      assert.equal(preview.bills, 2);
      const r = await clear(base, s);
      assert.equal(r.status, 409);
      assert.equal((await json(r)).error, `${BILL} ${SHIFT} ${KITCHEN}`);
      assert.equal((await orderRow(db, c1)).status, 'sent', 'nothing moved');

      const two = await openCard(base, s, 2, one(s.roti));
      assert.match((await get(base, s, '/api/admin/sales/clear')).reasons[0],
        /^2 bills are still open \(Card 1, Card 2\)\. Take payment on them or cancel them first\.$/);
      await pay(base, s, c1, { method: 'Card' });
      await pay(base, s, two, { method: 'Card' });
      assert.deepEqual((await get(base, s, '/api/admin/sales/clear')).reasons,
        [SHIFT, 'The kitchen still has 3 tickets to finish. Finish or clear the kitchen board first.']);
      await closeShift(base, s);
      assert.deepEqual((await get(base, s, '/api/admin/sales/clear')).reasons,
        ['The kitchen still has 3 tickets to finish. Finish or clear the kitchen board first.']);
      await finishBoard(base, s);
      assert.deepEqual((await get(base, s, '/api/admin/sales/clear')).reasons, []);

      const done = await clear(base, s);
      assert.equal(done.status, 200, await done.clone().text());
      made.push((await json(done)).archive);
      const again = await clear(base, s);
      assert.equal(again.status, 409);
      assert.equal((await json(again)).error, 'There are no sales to clear — every figure is already RM0.');
      const empty = await get(base, s, '/api/admin/sales/clear');
      assert.equal(empty.rows, 0);
    } finally { await dropArchives(db, made); }
  });
});

test('Clear sales data moves every sales row into archive_YYYYMMDD_HHMMSS, keeps everything else, and every figure reads RM0', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const made = [];
    try {
      await trade(base, s);
      const schema = await schemaOf(db);
      const { SALES_TABLES, KEPT_TABLES } = require('../../src/services/sales_archive');
      const kept = KEPT_TABLES.filter(t => !['audit_log', 'sessions'].includes(t));
      const salesBefore = await snapshot(db, schema, SALES_TABLES);
      const keptBefore = await snapshot(db, schema, kept);
      const auditBefore = (await db.query('SELECT count(*)::int n FROM audit_log')).rows[0].n;
      const featuresBefore = await get(base, s, '/api/features');
      for (const t of SALES_TABLES) assert.ok(salesBefore[t].n > 0, `the day's trading wrote to ${t}`);
      const money = (await db.query(
        `SELECT (SELECT COALESCE(SUM(amount_cents), 0) FROM payments)::int AS paid,
                (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds)::int AS refunded,
                (SELECT max(id) FROM orders) AS max_order, (SELECT max(id) FROM payments) AS max_payment,
                (SELECT max(id) FROM shifts) AS max_shift, (SELECT max(id) FROM order_items) AS max_line,
                (SELECT count(*) FROM orders)::int AS bills`)).rows[0];
      assert.ok((await get(base, s, '/api/dashboard')).today.sales > 0);

      const res = await clear(base, s);
      assert.equal(res.status, 200, await res.clone().text());
      const body = await json(res);
      made.push(body.archive);
      assert.match(body.archive, /^archive_\d{8}_\d{6}$/);
      // Named for the shop's own date and time (Kuala Lumpur), to the second.
      const named = (await db.query(
        `SELECT to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur' - interval '1 minute', 'YYYYMMDD_HH24MISS') <= $1
            AND $1 <= to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYYMMDD_HH24MISS') AS ok`,
        [body.archive.slice('archive_'.length)])).rows[0].ok;
      assert.ok(named, `${body.archive} is the shop's time now`);

      // Copied first, exactly: every archived table holds the same rows.
      assert.deepEqual(await snapshot(db, body.archive, SALES_TABLES), salesBefore);
      // Then removed from the shop's tables.
      for (const t of SALES_TABLES) assert.equal((await tableState(db, schema, t)).n, 0, `${t} is empty`);
      // Everything else stays, byte for byte.
      assert.deepEqual(await snapshot(db, schema, kept), keptBefore);
      assert.deepEqual(await get(base, s, '/api/features'), featuresBefore);

      // One audit row: who, when, how many bills, what total, where.
      const audit = (await db.query('SELECT * FROM audit_log ORDER BY id')).rows;
      assert.equal(audit.length, auditBefore + 1);
      const row = audit[audit.length - 1];
      assert.equal(row.action, 'sales.clear');
      assert.equal(row.user_id, (await db.query("SELECT id FROM users WHERE name = 'Admin'")).rows[0].id);
      assert.ok(row.at);
      assert.equal(row.detail.archive, body.archive);
      assert.equal(row.detail.bills, money.bills);
      assert.equal(row.detail.total_cents, money.paid - money.refunded);
      assert.equal(row.detail.rows.orders, money.bills);

      // Every figure: RM0.
      const dash = await get(base, s, '/api/dashboard');
      assert.deepEqual(dash.today, { sales: 0, orders: 0, average_order: 0, dine_in: { sales: 0, orders: 0 }, takeaway: { sales: 0, orders: 0 } });
      assert.deepEqual([dash.yesterday.sales, dash.month.sales, dash.year.sales], [0, 0, 0]);
      assert.deepEqual([dash.payment_mix, dash.hourly, dash.top_items], [[], [], []]);
      assert.deepEqual(dash.adjustments, { voids_count: 0, voids: 0, discounts: 0, refunds: 0 });
      assert.deepEqual(dash.floor, { open_cards: 0, open_takeaway: 0, ready_to_pay: 0, open_value: 0 });
      const summary = await get(base, s, '/api/summary');
      assert.deepEqual([summary.today, summary.month, summary.year], [{ sales: 0, orders: 0 }, { sales: 0, orders: 0 }, { sales: 0, orders: 0 }]);
      assert.equal(await get(base, s, '/api/shift/current'), null);
      assert.equal((await fetch(`${base}/api/shift/${money.max_shift}/report`, { headers: s.h })).status, 404);

      // Numbering carries on from where it was.
      await ok(post(base, s, '/api/shift/open', { float: 0 }), 'open shift');
      const next = await openCard(base, s, 1, one(s.roti));
      await pay(base, s, next, { method: 'Card' });
      assert.ok(next > money.max_order, `order ${next} after ${money.max_order}`);
      const fresh = (await db.query('SELECT (SELECT max(id) FROM payments) p, (SELECT max(id) FROM shifts) sh, (SELECT max(id) FROM order_items) li')).rows[0];
      assert.ok(fresh.p > money.max_payment && fresh.sh > money.max_shift && fresh.li > money.max_line);
      // And the closed-bill trigger is as strict as ever.
      await assert.rejects(db.query("UPDATE orders SET status = 'sent' WHERE id = $1", [next]), /cannot become sent/);
      await assert.rejects(db.query('UPDATE orders SET total_cents = 1 WHERE id = $1', [next]), /bill cannot change/);
    } finally { await dropArchives(db, made); }
  });
});

test('the runbook\'s restore puts an archive back beside new trading, and refuses to do it twice', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const made = [];
    try {
      await trade(base, s);
      const schema = await schemaOf(db);
      const { SALES_TABLES } = require('../../src/services/sales_archive');
      const before = await snapshot(db, schema, SALES_TABLES);
      const sales = (await get(base, s, '/api/dashboard')).today.sales;
      const { archive } = await json(await clear(base, s));
      made.push(archive);

      // The shop trades on after clearing.
      await ok(post(base, s, '/api/shift/open', { float: 0 }), 'open shift');
      const next = await openCard(base, s, 1, one(s.mee));
      await pay(base, s, next, { method: 'Card' });

      const run = arg => spawnSync(process.execPath, [RESTORE_SCRIPT, arg], { env: process.env, encoding: 'utf8' });
      const listed = run('--list');
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, new RegExp(`${archive}\\s+10 bills`));

      const restored = run(archive);
      assert.equal(restored.status, 0, restored.stderr);
      assert.match(restored.stdout, new RegExp(`Restored ${archive}:`));
      assert.match(restored.stdout, /orders: 10/);

      // Every archived row is back, beside the new bill.
      for (const t of SALES_TABLES) {
        const rows = (await db.query(
          `SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS h, count(*)::int AS n
             FROM "${schema}"."${t}" t WHERE t::text IN (SELECT a::text FROM "${archive}"."${t}" a)`)).rows[0];
        assert.deepEqual(rows, before[t], `${t} restored`);
      }
      assert.equal((await orderRow(db, next)).status, 'paid');
      assert.equal((await get(base, s, '/api/dashboard')).today.sales, Math.round((sales + 9.01) * 100) / 100);
      const audit = (await db.query("SELECT * FROM audit_log WHERE action = 'sales.restore'")).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].detail.archive, archive);

      const twice = run(archive);
      assert.equal(twice.status, 1);
      assert.match(twice.stderr, /Not restored: .* looks restored already/);
      const bad = run('orders');
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /not the name of a sales archive/);
    } finally { await dropArchives(db, made); }
  });
});

test('running the setup wizard again changes settings only: every sales row stays', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await trade(base, s);
    const open = await openCard(base, s, 12, one(s.roti));          // and a bill still open
    const schema = await schemaOf(db);
    const { SALES_TABLES } = require('../../src/services/sales_archive');
    const before = await snapshot(db, schema, SALES_TABLES);

    const r = await post(base, s, '/api/setup', {
      restaurant_name: 'Kedai Baru', restaurant_address: 'Jalan 2', sst_number: '', tax_rate_bp: 800, svc_rate_bp: 1000,
      card_count: 60, qr_mode: 'per_card',
      features: { kitchen: true, stations: true, printing: true, shifts: true, discounts: true, refunds: true, split_combine: true, qr: true, voice: true, dashboard: true },
    });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await snapshot(db, schema, SALES_TABLES), before, 'not one sales row changed');
    assert.equal((await get(base, s, '/api/settings')).restaurant_name, 'Kedai Baru');
    assert.equal((await orderRow(db, open)).status, 'sent');
  });
});

test('race: Clear sales data vs opening a bill — the bill is either refused room or lands after the clear, never lost: 20 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base, { shift: false });
    // No shift, no kitchen: every run has something to clear and nothing in the way.
    await ok(patch(base, s, '/api/features', { features: { shifts: false, kitchen: false } }), 'features');
    const made = [];
    const seen = new Set();
    try {
      for (let i = 0; i < 20; i++) {
        const ta = (await json(await post(base, s, '/api/orders', { order_type: 'takeaway', items: one(s.roti) }))).id;
        await pay(base, s, ta, { method: 'Card' });
        const [c, o] = await race(i, () => clear(base, s), () => post(base, s, '/api/orders', { card_id: s.card(1).id, items: one(s.mee) }));
        assert.equal(o.status, 201, `run ${i}: open ${o.status}`);
        const orderId = (await json(o)).id;
        assert.ok([200, 409].includes(c.status), `run ${i}: clear ${c.status}`);
        if (c.status === 200) {
          seen.add('cleared first');
          const { archive } = await json(c);
          made.push(archive);
          assert.equal((await db.query(`SELECT count(*)::int n FROM "${archive}".orders WHERE id = $1`, [orderId])).rows[0].n, 0);
          assert.equal((await db.query(`SELECT count(*)::int n FROM "${archive}".orders WHERE id = $1`, [ta])).rows[0].n, 1);
          assert.equal((await orderRow(db, ta)), undefined, `run ${i}: the takeaway moved`);
        } else {
          seen.add('opened first');
          assert.equal((await json(c)).error, 'A bill is still open (Card 1). Take payment on it or cancel it first.');
          assert.equal((await orderRow(db, ta)).status, 'paid', `run ${i}: nothing moved`);
        }
        assert.equal((await orderRow(db, orderId)).status, 'served', `run ${i}: the new bill is open, in the shop's tables`);
        await pay(base, s, orderId, { method: 'Card' });
      }
      // Every bill ever opened is in exactly one place.
      const inShop = (await db.query('SELECT count(*)::int n FROM orders')).rows[0].n;
      let archived = 0;
      for (const a of made) archived += (await db.query(`SELECT count(*)::int n FROM "${a}".orders`)).rows[0].n;
      assert.equal(inShop + archived, 40);
      assert.deepEqual([...seen].sort(), ['cleared first', 'opened first']);
    } finally { await dropArchives(db, made); }
  });
});
