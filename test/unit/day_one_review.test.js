const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const {
  startApp, login, headers, setup, post, patch, get, json, openCard, one, manyCards, race, orderRow, assertBalanced,
} = require('../apphelper');

/* The review of claude/day-one-fixes (D1-D7, P4): each finding, reproduced
   and then held shut. */

const merge = (base, s, into, from) => post(base, s, `/api/orders/${into}/merge`, { from_order_id: from });
const idemPost = (base, s, url, body, key) => fetch(`${base}${url}`, {
  method: 'POST', headers: { ...s.h, 'Idempotency-Key': key }, body: JSON.stringify(body),
});
const dueOf = async (base, s, id) => (await get(base, s, '/api/orders')).find(o => o.id === id).amount_due;
const paymentsOn = async (db, id) => (await db.query('SELECT amount_cents FROM payments WHERE order_id = $1 ORDER BY id', [id])).rows.map(r => r.amount_cents);
const ok = async (pending, label) => {
  const res = await pending;
  assert.ok(res.status < 300, `${label}: ${res.status} ${await res.clone().text()}`);
  return res;
};

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
const clear = (base, s) => ok(post(base, s, '/api/admin/sales/clear', { pin: '1234', confirm: 'CLEAR' }), 'clear');

// A staff member as they are on day two: signed in, first PIN already changed
// (until then every route but /api/me/pin answers 403).
async function staffSession(base, s, name, pin) {
  assert.equal((await post(base, s, '/api/admin/users', { name, role: 'staff', pin: '9157' })).status, 200);
  const first = { h: headers(await login(base, name, '9157')) };
  assert.equal((await post(base, first, '/api/me/pin', { current_pin: '9157', new_pin: pin })).status, 200);
  return first;
}

/* ===== D1 ===== */

test('D1: pay in full with the total the till showed is refused (409) once a Combine has grown the bill, and records nothing', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const c1 = await openCard(base, s, 1, one(s.roti));
    const c4 = await openCard(base, s, 4, one(s.mee));
    const shown = await dueOf(base, s, c1);
    assert.equal(shown, 2.12);
    assert.equal((await merge(base, s, c1, c4)).status, 200);

    const stale = await post(base, s, `/api/orders/${c1}/pay`, { method: 'Cash', expected_due: shown });
    assert.equal(stale.status, 409);
    const now = await dueOf(base, s, c1);
    assert.ok(now > 11, `Card 1 now carries the mee goreng too (${now})`);
    assert.equal((await json(stale)).error, `The bill has changed: it now comes to RM ${now.toFixed(2)}. Check it and take payment again.`);
    assert.deepEqual(await paymentsOn(db, c1), [], 'nothing recorded');
    assert.equal((await orderRow(db, c1)).status, 'sent');

    const fresh = await post(base, s, `/api/orders/${c1}/pay`, { method: 'Card', expected_due: await dueOf(base, s, c1) });
    assert.equal(fresh.status, 200);
    assert.equal((await json(fresh)).settled, true);
    await assertBalanced(db, c1, 'Card 1');
  });
});

test('race D1: Combine vs pay-in-full sending the total shown — the money taken is always what the till showed: 40 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const c1 = await openCard(base, s, 2 * i + 1, one(s.roti));
      const c4 = await openCard(base, s, 2 * i + 2, one(s.mee));
      const shown = await dueOf(base, s, c1);
      const [m, p] = await race(i,
        () => merge(base, s, c1, c4),
        () => post(base, s, `/api/orders/${c1}/pay`, { method: 'Cash', expected_due: shown }));
      if (p.status === 200) {
        seen.add('paid first');
        assert.equal(m.status, 409, `run ${i}: a paid bill can't take a Combine`);
        assert.deepEqual(await paymentsOn(db, c1), [210], `run ${i}: RM2.12 shown, RM2.10 in cash`);
        assert.equal((await orderRow(db, c4)).status, 'sent', `run ${i}: Card 4 keeps its own bill`);
      } else {
        seen.add('merged first');
        assert.equal(m.status, 200, `run ${i}: merge`);
        assert.equal(p.status, 409, `run ${i}: payment ${p.status}`);
        assert.deepEqual(await paymentsOn(db, c1), [], `run ${i}: nothing taken at a total nobody saw`);
      }
      await assertBalanced(db, c1, `run ${i} Card 1`);
    }
    assert.deepEqual([...seen].sort(), ['merged first', 'paid first']);
  });
});

/* ===== D2 ===== */

test('D2: approving a discount with an admin PIN has a wrong-PIN limit, answers 403 (not a logout), and refuses inactive admins', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const siti = await staffSession(base, s, 'Siti', '4826');
    const authorize = (who, pin, name = 'Admin') => post(base, who, '/api/discounts/authorize', { name, pin });

    for (let i = 0; i < 5; i++) assert.equal((await authorize(siti, '0000')).status, 403, `wrong PIN ${i + 1}`);
    assert.equal((await authorize(siti, '1234')).status, 429, 'five wrong and even the right PIN waits');
    // Siti's session still works — a wrong PIN never logged her out.
    assert.equal((await fetch(`${base}/api/orders`, { headers: siti.h })).status, 200);

    // Another till is not held by Siti's guesses...
    const ali = await staffSession(base, s, 'Ali', '5937');
    assert.equal((await authorize(ali, '1234')).status, 200);
    // ...but the admin's own budget is shared across every till: ten in all.
    for (let i = 0; i < 5; i++) assert.equal((await authorize(ali, '0000')).status, 403);
    const chong = await staffSession(base, s, 'Chong', '6048');
    assert.equal((await authorize(chong, '0000')).status, 429, 'ten wrong for Admin across tills');

    // An admin who has been switched off can't approve anything.
    assert.equal((await post(base, s, '/api/admin/users', { name: 'Old Boss', role: 'admin', pin: '7159' })).status, 200);
    const users = await get(base, s, '/api/admin/users');
    const old = users.find(u => u.name === 'Old Boss');
    assert.equal((await patch(base, s, `/api/admin/users/${old.id}`, { active: false })).status, 200);
    const muthu = await staffSession(base, s, 'Muthu', '8260');
    assert.equal((await authorize(muthu, '7159', 'Old Boss')).status, 403);
  });
});

test('D2: 25 wrong admin PINs fired at once from one staff session get exactly 5 checks: 40 runs', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 40; i++) {
      const who = await staffSession(base, s, `Burst ${i}`, String(4001 + 137 * i));
      // Aim at a different admin name each run, so only the per-session limit is in play.
      const results = await Promise.all(Array.from({ length: 25 }, () =>
        post(base, who, '/api/discounts/authorize', { name: `Nobody ${i}`, pin: '0000' })));
      const codes = results.map(r => r.status);
      assert.equal(codes.filter(c => c === 403).length, 5, `run ${i}: ${codes.join(',')}`);
      assert.equal(codes.filter(c => c === 429).length, 20, `run ${i}`);
    }
  });
});

test('D2: changing your own PIN has a wrong-PIN limit, and a wrong current PIN answers 403', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const siti = await staffSession(base, s, 'Siti', '4826');
    const change = current => post(base, siti, '/api/me/pin', { current_pin: current, new_pin: '5273' });
    for (let i = 0; i < 5; i++) assert.equal((await change('0000')).status, 403);
    assert.equal((await change('4826')).status, 429);
    assert.equal((await fetch(`${base}/api/orders`, { headers: siti.h })).status, 200, 'still logged in');
  });
});

/* ===== D3 ===== */

test('D3: an add-on that landed on Card 4 before a Combine replays as done, and one that never landed is refused naming Card 1', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const c1 = await openCard(base, s, 1, one(s.roti));
    const c4 = await openCard(base, s, 4, one(s.mee));
    const key = 'd3-landed';
    assert.equal((await idemPost(base, s, `/api/orders/${c4}/items`, { items: one(s.teh) }, key)).status, 200);
    assert.equal((await merge(base, s, c1, c4)).status, 200);
    const count = async () => (await db.query('SELECT count(*)::int n FROM order_items WHERE order_id = $1', [c1])).rows[0].n;
    const before = await count();

    // The till never got its first answer and sends again: it is told "done".
    const replay = await idemPost(base, s, `/api/orders/${c4}/items`, { items: one(s.teh) }, key);
    assert.equal(replay.status, 200);
    assert.equal(await count(), before, 'nothing added twice');

    // A new add-on for Card 4's old bill is refused, and says where it went.
    const late = await idemPost(base, s, `/api/orders/${c4}/items`, { items: one(s.teh) }, 'd3-new');
    assert.equal(late.status, 409);
    assert.match((await json(late)).error, /Card 1/);
    assert.equal(await count(), before);
  });
});

test('D3: a failed send is kept and listed on the till, with the server\'s reason', () => {
  const outbox = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'outbox.js'), 'utf8');
  const pos = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'pos.js'), 'utf8');
  assert.match(outbox, /moveToFailed\(entry, data\.error \|\|/);
  assert.match(pos, /failedEntries\(\)/, 'the till reads the failed store');
  assert.match(pos, /data-action="dismiss-failed"/);
});

/* ===== D4, D5 ===== */

test('D4: a create or an add-on replayed after Clear sales data is answered as done — no second bill — and the restore still works', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const create = await idemPost(base, s, '/api/orders', { card_id: s.card(5).id, items: [{ item_id: s.mee.id, qty: 2 }] }, 'd4-create');
    assert.equal(create.status, 201);
    const id = (await json(create)).id;
    assert.equal((await idemPost(base, s, `/api/orders/${id}/items`, { items: one(s.teh) }, 'd4-add')).status, 200);
    await ok(post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }), 'pay');
    await finishBoard(base, s);
    await closeShift(base, s);
    const { archive } = await json(await clear(base, s));

    const again = await idemPost(base, s, '/api/orders', { card_id: s.card(5).id, items: [{ item_id: s.mee.id, qty: 2 }] }, 'd4-create');
    assert.equal(again.status, 200);
    assert.deepEqual(await json(again), { id, archived: true });
    const addAgain = await idemPost(base, s, `/api/orders/${id}/items`, { items: one(s.teh) }, 'd4-add');
    assert.equal(addAgain.status, 200);
    assert.equal((await db.query('SELECT count(*)::int n FROM orders')).rows[0].n, 0, 'no bill opened by a replay');
    assert.equal((await db.query('SELECT count(*)::int n FROM order_send_tickets')).rows[0].n, 0, 'nothing sent to the kitchen');

    const { restoreArchive } = require('../../src/services/sales_archive');
    const r = await restoreArchive(archive);
    assert.equal(r.rows.orders, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM archived_idempotency_keys WHERE archive = $1', [archive])).rows[0].n, 0);
    // Back in the shop's own records, the keys still answer "done".
    assert.equal((await idemPost(base, s, '/api/orders', { card_id: s.card(5).id, items: one(s.mee) }, 'd4-create')).status, 200);
  });
});

test('D5: a menu item or printer deleted after a clear no longer blocks the restore; those links come back empty, as ON DELETE SET NULL would leave them', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const item = await json(await ok(post(base, s, '/api/admin/items', {
      name: 'Trial Murtabak', price: 9, category_id: s.roti.category_id, station_code: 'kitchen',
    }), 'new item'));
    const printer = await json(await ok(post(base, s, '/api/admin/printers', { name: 'Front', host: '192.0.2.1', role: 'receipt' }), 'printer'));
    const id = await openCard(base, s, 2, [{ item_id: item.id, qty: 1 }]);
    await ok(post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }), 'pay');
    assert.ok((await db.query('SELECT 1 FROM print_jobs WHERE printer_id = $1', [printer.id])).rows[0], 'a job for that printer');
    await finishBoard(base, s);
    await closeShift(base, s);
    const { archive } = await json(await clear(base, s));

    await ok(fetch(`${base}/api/admin/items/${item.id}`, { method: 'DELETE', headers: s.h }), 'delete item');
    await ok(fetch(`${base}/api/admin/printers/${printer.id}`, { method: 'DELETE', headers: s.h }), 'delete printer');
    assert.equal((await db.query('SELECT count(*)::int n FROM items WHERE id = $1', [item.id])).rows[0].n, 0, 'really gone');

    const { restoreArchive } = require('../../src/services/sales_archive');
    const r = await restoreArchive(archive);
    assert.equal(r.unlinked['order_items.item_id'], 1);
    assert.ok(r.unlinked['print_jobs.printer_id'] >= 1);
    const line = (await db.query('SELECT item_id, name, price_cents FROM order_items WHERE order_id = $1', [id])).rows[0];
    assert.deepEqual(line, { item_id: null, name: 'Trial Murtabak', price_cents: 900 }, 'the snapshot keeps the sale');
    await assertBalanced(db, id, 'restored bill');
  });
});

/* ===== D6, D7 ===== */

test('D6: other screens hear "sales.cleared"', () => {
  const state = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'state.js'), 'utf8');
  assert.match(state, /'sales\.cleared'\]\s*\n\s*\.forEach\(type => es\.addEventListener/);
});

test('D7: separating a card whose items were all voided leaves no open RM0 bill — it closes itself', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const c10 = await openCard(base, s, 10, one(s.roti));
    const c11 = await openCard(base, s, 11, one(s.mee));
    assert.equal((await merge(base, s, c10, c11)).status, 200);
    const line = (await db.query('SELECT id FROM order_items WHERE order_id = $1 AND item_id = $2', [c10, s.mee.id])).rows[0].id;
    await ok(post(base, s, `/api/orders/${c10}/items/${line}/void`, { reason: 'customer left' }), 'void');
    const sep = await ok(post(base, s, `/api/orders/${c10}/separate`, { card_id: s.card(11).id }), 'separate');
    const fresh = (await json(sep)).new_order_id;
    const row = await orderRow(db, fresh);
    assert.equal(row.status, 'paid');
    assert.equal(row.total_cents, 0);
    assert.equal((await db.query(
      "SELECT count(*)::int n FROM orders WHERE card_id = $1 AND status NOT IN ('paid','cancelled','refunded','merged')", [s.card(11).id])).rows[0].n, 0,
      'Card 11 is free');
    assert.equal((await orderRow(db, c10)).status, 'sent', 'Card 10 keeps its own bill');
  });
});
