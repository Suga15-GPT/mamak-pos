const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');

/* Regression tests for the PR #16 review findings. Each one reproduces the
   finding through the real routes; the race findings fire the conflicting
   requests concurrently, several rounds each. */

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
  const h = auth(await login(base, 'Admin', '1234'));
  await fetch(`${base}/api/shift/open`, { method: 'POST', headers: h, body: JSON.stringify({ float: 0 }) });
  const menu = await json(await fetch(`${base}/api/menu`, { headers: h }));
  const cards = await json(await fetch(`${base}/api/admin/cards`, { headers: h }));
  const byName = n => menu.items.find(i => i.name === n);
  const card = n => cards.find(c => c.number === n);
  return { h, cards, card, roti: byName('Roti Canai'), teh: byName('Teh Tarik'), mee: byName('Mee Goreng Mamak') };
}

const post = (base, s, url, body) => fetch(`${base}${url}`, { method: 'POST', headers: s.h, body: JSON.stringify(body || {}) });
const patch = (base, s, url, body) => fetch(`${base}${url}`, { method: 'PATCH', headers: s.h, body: JSON.stringify(body || {}) });
const del = (base, s, url) => fetch(`${base}${url}`, { method: 'DELETE', headers: s.h });
const get = async (base, s, url) => json(await fetch(`${base}${url}`, { headers: s.h }));
const publicOrder = (base, body) => fetch(`${base}/api/public/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function openCard(base, s, number, items) {
  const r = await post(base, s, '/api/orders', { card_id: s.card(number).id, items });
  assert.equal(r.status, 201, `opening Card ${number}`);
  return (await json(r)).id;
}
const one = item => [{ item_id: item.id, qty: 1 }];
const orderRow = (db, id) => db.query('SELECT * FROM orders WHERE id = $1', [id]).then(r => r.rows[0]);
const lineIds = async (db, id) => (await db.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id', [id])).rows.map(r => r.id);
const groupAudit = async (db, groupId) => (await db.query(
  "SELECT action FROM audit_log WHERE entity_type = 'bill_group' AND entity_id = $1 ORDER BY id", [groupId])).rows.map(r => r.action);

/* The books balance on one order: the stored subtotal is exactly its live,
   accepted lines, and a paid order's payments (net of refunds) are exactly its
   total. Items that slipped onto a paid bill, or a bill recomputed after it was
   paid, break one of these. */
async function assertOrderBalances(db, id, label) {
  const o = await orderRow(db, id);
  const lines = (await db.query(
    `SELECT COALESCE(SUM(oi.price_cents * oi.qty), 0)::int s FROM order_items oi
       LEFT JOIN order_sends se ON se.id = oi.send_id
      WHERE oi.order_id = $1 AND oi.voided_at IS NULL AND (se.id IS NULL OR se.approval_state = 'approved')`, [id])).rows[0].s;
  assert.equal(o.subtotal_cents, lines, `${label}: the bill is exactly its lines`);
  if (o.status === 'paid') {
    const paid = (await db.query('SELECT COALESCE(SUM(amount_cents), 0)::int s FROM payments WHERE order_id = $1', [id])).rows[0].s;
    assert.equal(paid, o.total_cents, `${label}: a paid order's payments equal its total`);
  }
}

/* ===== Finding #1: a grouped card closing on its own left its partner stuck ===== */

async function stuckCardScenario(close) {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const o1 = await openCard(base, s, 1, one(s.roti));                  // 2.12
    const o2 = await close.open(base, s);                                // 9.01 or a held QR round
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [o1, o2] }));

    // The repro started by paying only Card 1's share of the group. That is
    // refused now: a combined bill is paid in full in one go (or, while a QR
    // round awaits approval, not at all). Nothing is written either way.
    const part = await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: 2.12 }] });
    const refusal = close.refusal || { status: 400, error: 'A combined bill has to be paid in full in one go.' };
    assert.equal(part.status, refusal.status);
    assert.equal((await json(part)).error, refusal.error);
    assert.equal((await db.query('SELECT count(*)::int n FROM payments')).rows[0].n, 0);

    await close.run(base, s, db, o2);
    assert.ok(['paid', 'cancelled'].includes((await orderRow(db, o2)).status), 'Card 2 closed on its own');

    // Card 2 left the group, the group of one dissolved, and each step is audited.
    assert.equal((await orderRow(db, o2)).bill_group_id, null);
    assert.equal((await orderRow(db, o1)).bill_group_id, null, 'Card 1 is on its own bill again');
    assert.ok((await db.query('SELECT closed_at FROM bill_groups WHERE id = $1', [g.id])).rows[0].closed_at);
    assert.deepEqual(await groupAudit(db, g.id), ['bill_group.combine', 'bill_group.remove', 'bill_group.dissolve']);

    // Card 1 is payable and frees itself — nothing is stuck.
    const paid = await json(await post(base, s, `/api/orders/${o1}/pay`, { method: 'Cash' }));
    assert.equal(paid.settled, true);
    const floor = await get(base, s, '/api/cards');
    assert.equal(floor.find(c => c.number === 1).in_use, false);
    assert.equal(floor.find(c => c.number === 2).in_use, false);
  });
}

test('#1 a grouped card voided to zero leaves its group; the other card is not stuck', () => stuckCardScenario({
  open: (base, s) => openCard(base, s, 2, one(s.mee)),
  run: async (base, s, db, id) => {
    const [line] = await lineIds(db, id);
    const r = await post(base, s, `/api/orders/${id}/items/${line}/void`, { reason: 'customer left' });
    assert.equal(r.status, 200);
  },
}));

test('#1 a grouped card comped to zero leaves its group; the other card is not stuck', () => stuckCardScenario({
  open: (base, s) => openCard(base, s, 2, one(s.mee)),
  run: async (base, s, db, id) => {
    const r = await post(base, s, `/api/orders/${id}/discounts`, { kind: 'comp', reason: 'birthday on the house' });
    assert.equal(r.status, 200);
  },
}));

test('#1 a grouped card whose QR round is rejected (cancelled) leaves its group; the other card is not stuck', () => stuckCardScenario({
  refusal: { status: 409, error: 'A customer order is waiting for approval — approve or reject it first.' },
  open: async (base, s) => {
    await patch(base, s, '/api/settings', { qr_require_approval: true });
    assert.equal((await publicOrder(base, { table_token: s.card(2).qr_token, items: one(s.mee) })).status, 201);
    return (await get(base, s, '/api/orders')).find(o => o.card_number === 2).id;
  },
  run: async (base, s, db, id) => {
    const [send] = (await db.query('SELECT id FROM order_sends WHERE order_id = $1', [id])).rows;
    const r = await post(base, s, `/api/kitchen/sends/${send.id}/reject`, { reason: 'kitchen closed' });
    assert.equal(r.status, 200);
  },
}));

test('#1 a card leaving a group of three leaves the other two combined and payable in one go', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const [o1, o2, o3] = [await openCard(base, s, 1, one(s.roti)), await openCard(base, s, 2, one(s.mee)), await openCard(base, s, 3, one(s.roti))];
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [o1, o2, o3] }));
    await post(base, s, `/api/orders/${o2}/discounts`, { kind: 'comp', reason: 'staff meal ok' });
    assert.equal((await orderRow(db, o2)).bill_group_id, null);
    const after = await get(base, s, `/api/bill-groups/${g.id}`);
    assert.deepEqual(after.members.map(m => m.card_number), [1, 3]);
    assert.deepEqual(await groupAudit(db, g.id), ['bill_group.combine', 'bill_group.remove']);
    const paid = await json(await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: 4.24 }] }));
    assert.equal(paid.settled, true);
  });
});

/* ===== Finding #2 / decision 3: held (awaiting-approval) lines ===== */

test('#2 held shop-mode lines count in no total, and the till refuses payment until they are decided', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await patch(base, s, '/api/settings', { qr_mode: 'shop', qr_require_approval: false });
    const token = (await get(base, s, '/api/admin/qr-shop')).url.split('/t/')[1];

    const o5 = await openCard(base, s, 5, one(s.roti));                  // 2.12
    const q = await publicOrder(base, { table_token: token, card_number: 5, items: [{ item_id: s.teh.id, qty: 2 }] });
    assert.equal((await json(q)).status, 'pending');

    // Shown, marked held, and not in any total.
    const order = (await get(base, s, '/api/orders')).find(o => o.id === o5);
    assert.equal(order.grand_total, 2.12, 'card bill leaves the held drinks out');
    assert.equal(order.total, 2, 'line total before SST: the roti alone');
    assert.deepEqual(order.items.map(i => [i.name, i.held]), [['Roti Canai', false], ['Teh Tarik', true]]);
    const printing = require('../../src/services/printing');
    const receipt = (await printing.buildReceipt(o5, 42)).toString('latin1');
    assert.equal(receipt.includes('Teh Tarik'), false, 'the receipt leaves the held drinks out');

    // Single-card payment refused while a round awaits approval.
    const HELD = 'A customer order is waiting for approval — approve or reject it first.';
    const pay = await post(base, s, `/api/orders/${o5}/pay`, { method: 'Cash' });
    assert.equal(pay.status, 409);
    assert.equal((await json(pay)).error, HELD);

    // Combined: the held lines stay out of the group total, and it can't be paid either.
    const o6 = await openCard(base, s, 6, one(s.roti));
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [o5, o6] }));
    assert.equal(g.total, 4.24);
    assert.equal(g.awaiting_approval, true);
    const gpay = await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Cash' }] });
    assert.equal(gpay.status, 409);
    assert.equal((await json(gpay)).error, HELD);
    assert.equal((await db.query('SELECT count(*)::int n FROM payments')).rows[0].n, 0, 'nothing was charged');

    // Approving puts the drinks on the bill and on the drinks station; then it pays.
    const pending = await get(base, s, '/api/kitchen/pending');
    assert.equal((await post(base, s, `/api/kitchen/sends/${pending[0].id}/approve`)).status, 200);
    assert.equal((await orderRow(db, o5)).total_cents, 806, 'roti + 2 teh tarik, SST on this card alone');
    const drinks = await get(base, s, '/api/kitchen/tickets?station=drinks');
    assert.equal(drinks.tickets.length, 1, 'the drinks reach the station');
    const done = await json(await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Cash', tendered: 20 }] }));
    assert.equal(done.settled, true);
    assert.equal(done.paid, 10.20, '8.06 + 2.12 = 10.18, cash-rounded once to 10.20');
  });
});

test('#2 approve and reject refuse (409) on an order that is no longer open, and never recompute its bill', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await patch(base, s, '/api/settings', { qr_require_approval: true });
    const o7 = await openCard(base, s, 7, one(s.roti));
    await publicOrder(base, { table_token: s.card(7).qr_token, items: one(s.teh) });
    await publicOrder(base, { table_token: s.card(7).qr_token, items: one(s.mee) });
    const before = await orderRow(db, o7);
    assert.equal((await patch(base, s, `/api/orders/${o7}`, { status: 'cancelled' })).status, 200);

    const pending = (await db.query("SELECT id FROM order_sends WHERE order_id = $1 AND approval_state = 'pending' ORDER BY id", [o7])).rows;
    const ap = await post(base, s, `/api/kitchen/sends/${pending[0].id}/approve`);
    const rj = await post(base, s, `/api/kitchen/sends/${pending[1].id}/reject`, { reason: 'too late' });
    assert.equal(ap.status, 409);
    assert.equal(rj.status, 409);
    const after = await orderRow(db, o7);
    assert.equal(after.status, 'cancelled');
    assert.equal(after.total_cents, before.total_cents, 'the closed bill was not recomputed');
    assert.equal((await db.query("SELECT count(*)::int n FROM order_sends WHERE order_id = $1 AND approval_state = 'pending'", [o7])).rows[0].n, 2);
  });
});

/* ===== Finding #3: corrections on a grouped, unpaid card ===== */

test('#3 void, discount and add all work on a grouped card, and the bill is then paid in one go', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const o1 = await openCard(base, s, 1, [{ item_id: s.roti.id, qty: 1 }, { item_id: s.mee.id, qty: 1 }]);
    const o2 = await openCard(base, s, 2, one(s.mee));
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [o1, o2] }));

    // The state that used to make every correction fail — part of the group
    // paid — can no longer be reached.
    assert.equal((await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: 5 }] })).status, 400);

    const [, meeLine] = await lineIds(db, o1);
    assert.equal((await post(base, s, `/api/orders/${o1}/items/${meeLine}/void`, { reason: 'wrong dish' })).status, 200);
    assert.equal((await post(base, s, `/api/orders/${o2}/discounts`, { kind: 'amount', value: 1, reason: 'regular customer' })).status, 200);
    assert.equal((await post(base, s, `/api/orders/${o2}/items`, { items: one(s.roti) })).status, 200);

    const after = await get(base, s, `/api/bill-groups/${g.id}`);
    assert.equal(after.members.length, 2, 'still combined');
    // Card 1: roti 2.12. Card 2: mee + roti 10.50 + SST 0.63 - 1.00 = 10.13.
    assert.equal(after.amount_due, 12.25);
    const paid = await json(await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Cash', tendered: 15 }] }));
    assert.equal(paid.settled, true);
    assert.equal(paid.paid, 12.25);
    assert.equal(paid.change, 2.75);
    for (const id of [o1, o2]) await assertOrderBalances(db, id, `order ${id}`);
  });
});

/* ===== Finding #4: move vs lowering the card count ===== */

test('#4 moving an order onto a card while the count is lowered never leaves an open bill on an inactive card', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 12; i++) {
      assert.equal((await patch(base, s, '/api/admin/cards/count', { count: 50 })).status, 200);
      const id = await openCard(base, s, 3, one(s.roti));
      const [moved, lowered] = await Promise.all([
        post(base, s, `/api/orders/${id}/move`, { card_id: s.card(45).id }),
        patch(base, s, '/api/admin/cards/count', { count: 40 }),
      ]);
      assert.ok([200, 404].includes(moved.status), `move: ${moved.status}`);
      assert.ok([200, 409].includes(lowered.status), `count: ${lowered.status}`);
      const stranded = (await db.query(
        `SELECT count(*)::int n FROM orders o JOIN cards c ON c.id = o.card_id
          WHERE NOT c.active AND o.status NOT IN ('paid','cancelled','refunded')`)).rows[0].n;
      assert.equal(stranded, 0, `round ${i}: an open bill sits on a card that is off the floor`);
      await patch(base, s, `/api/orders/${id}`, { status: 'cancelled' });
    }
  });
});

/* ===== Finding #5: one lock order for combine / un-combine / pay ===== */

test('#5 concurrent combine and un-combine on the same cards never deadlock', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 10; i++) {
      const [a, b, c] = [3 * i + 1, 3 * i + 2, 3 * i + 3];
      const [oa, ob, oc] = [await openCard(base, s, a, one(s.roti)), await openCard(base, s, b, one(s.roti)), await openCard(base, s, c, one(s.roti))];
      const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [oa, ob] }));
      const [combined, removed] = await Promise.all([
        post(base, s, '/api/bill-groups', { order_ids: [oc, oa] }),
        del(base, s, `/api/bill-groups/${g.id}/orders/${ob}`),
      ]);
      assert.ok(combined.status < 500, `round ${i}: combine ${combined.status} ${JSON.stringify(await json(combined))}`);
      assert.ok(removed.status < 500, `round ${i}: remove ${removed.status}`);
    }
  });
});

test('#5 concurrent combine and pay-in-full never deadlock, and every card ends up paid or open, never half-way', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 10; i++) {
      const [a, b, c] = [3 * i + 1, 3 * i + 2, 3 * i + 3];
      const ids = [await openCard(base, s, a, one(s.roti)), await openCard(base, s, b, one(s.roti)), await openCard(base, s, c, one(s.roti))];
      const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [ids[0], ids[1]] }));
      const [combined, paid] = await Promise.all([
        post(base, s, '/api/bill-groups', { order_ids: [ids[2], ids[0]] }),
        post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Cash' }] }),
      ]);
      assert.ok(combined.status < 500, `round ${i}: combine ${combined.status}`);
      assert.ok(paid.status < 500, `round ${i}: pay ${paid.status}`);
      for (const id of ids) await assertOrderBalances(db, id, `round ${i} order ${id}`);
    }
  });
});

/* ===== Finding #6: a 1-2 sen remainder paid in cash ===== */

test('#6 a 2 sen balance paid in cash settles on rounding alone — single card and combined bill', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    const o1 = await openCard(base, s, 1, one(s.roti));                  // 2.12
    assert.equal((await post(base, s, `/api/orders/${o1}/pay`, { method: 'Card', amount: 2.10 })).status, 200);
    const cash = await post(base, s, `/api/orders/${o1}/pay`, { method: 'Cash' });
    assert.equal(cash.status, 200);
    assert.equal((await json(cash)).settled, true);
    const r1 = await orderRow(db, o1);
    assert.equal(r1.status, 'paid');
    assert.equal(r1.rounding_cents, -2);
    assert.equal(r1.total_cents, 210);
    const rows1 = (await db.query('SELECT method, amount_cents FROM payments WHERE order_id = $1', [o1])).rows;
    assert.deepEqual(rows1, [{ method: 'Card', amount_cents: 210 }], 'no zero-sen cash row');

    const o2 = await openCard(base, s, 2, one(s.roti));
    const o3 = await openCard(base, s, 3, one(s.roti));
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [o2, o3] }));
    const gp = await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: 4.22 }, { method: 'Cash' }] });
    assert.equal(gp.status, 200);
    const body = await json(gp);
    assert.equal(body.settled, true);
    assert.equal(body.paid, 4.22);
    const rows = (await db.query('SELECT method, amount_cents FROM payments WHERE order_id = ANY($1::int[]) ORDER BY id', [[o2, o3]])).rows;
    assert.ok(rows.every(r => r.method === 'Card' && r.amount_cents > 0), 'no zero-sen cash row');
    assert.equal(rows.reduce((t, r) => t + r.amount_cents, 0), 422);
    const [r2, r3] = [await orderRow(db, o2), await orderRow(db, o3)];
    assert.equal(r2.rounding_cents + r3.rounding_cents, -2, 'the 2 sen is rounding, once');
    for (const id of [o2, o3]) await assertOrderBalances(db, id, `order ${id}`);
  });
});

/* ===== Finding #7: items added while a payment is in flight ===== */

test('#7 items added while a single card is being paid never land on the paid bill', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 15; i++) {
      const id = await openCard(base, s, i + 1, one(s.roti));
      const [paid, added] = await Promise.all([
        post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' }),
        post(base, s, `/api/orders/${id}/items`, { items: one(s.teh) }),
      ]);
      assert.equal(paid.status, 200, `round ${i}: pay`);
      assert.ok([200, 400, 409].includes(added.status), `round ${i}: add ${added.status}`);
      assert.equal((await orderRow(db, id)).status, 'paid');
      await assertOrderBalances(db, id, `round ${i}`);
    }
  });
});

test('#7 items added to a grouped card while the combined bill is being paid never land on the paid bill', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 12; i++) {
      const a = await openCard(base, s, 2 * i + 1, one(s.roti));
      const b = await openCard(base, s, 2 * i + 2, one(s.roti));
      const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));
      const [paid, added] = await Promise.all([
        post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Cash' }] }),
        post(base, s, `/api/orders/${b}/items`, { items: one(s.teh) }),
      ]);
      assert.equal(paid.status, 200, `round ${i}: pay`);
      assert.ok([200, 400, 409].includes(added.status), `round ${i}: add ${added.status}`);
      for (const id of [a, b]) await assertOrderBalances(db, id, `round ${i} order ${id}`);
    }
  });
});

test('#7 a QR order arriving while the card is being paid never lands on the paid bill', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 12; i++) {
      const id = await openCard(base, s, i + 1, one(s.roti));
      const [paid] = await Promise.all([
        post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' }),
        publicOrder(base, { table_token: s.card(i + 1).qr_token, items: one(s.teh) }),
      ]);
      assert.equal(paid.status, 200, `round ${i}: pay`);
      await assertOrderBalances(db, id, `round ${i}`);
    }
  });
});

/* ===== Finding #8: a refund on an open bill ===== */

test('#8 refunding a part-payment on an open bill leaves it open and owing, and the card in use', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const id = await openCard(base, s, 4, [{ item_id: s.roti.id, qty: 10 }]);   // 21.20
    const p = await json(await post(base, s, `/api/orders/${id}/pay`, { method: 'Card', amount: 10 }));
    const paymentId = (await db.query('SELECT id FROM payments WHERE order_id = $1', [id])).rows[0].id;
    const r = await post(base, s, `/api/orders/${id}/refunds`, { payment_id: paymentId, amount: 10, reason: 'charged wrong card' });
    assert.equal(r.status, 200);
    assert.equal(p.settled, false);

    assert.notEqual((await orderRow(db, id)).status, 'refunded', 'an open bill is never "refunded"');
    assert.equal((await get(base, s, '/api/cards')).find(c => c.number === 4).in_use, true, 'the card is still in use');
    const open = (await get(base, s, '/api/orders')).find(o => o.id === id);
    assert.equal(open.amount_due, 21.20, 'the refund just reduces what has been paid');

    const settled = await json(await post(base, s, `/api/orders/${id}/pay`, { method: 'Card' }));
    assert.equal(settled.settled, true);
    assert.equal((await orderRow(db, id)).status, 'paid');
  });
});

/* ===== QR rotation ===== */

test('regenerating a card QR or the shop poster QR retires the printed one, and is audited', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const old = s.card(9).qr_token;
    assert.equal((await fetch(`${base}/api/t/${old}`)).status, 200);
    const r = await json(await post(base, s, `/api/admin/cards/${s.card(9).id}/regenerate-qr`));
    const fresh = r.url.split('/t/')[1];
    assert.notEqual(fresh, old);
    assert.equal((await fetch(`${base}/api/t/${old}`)).status, 404, 'the printed QR stops working');
    assert.equal((await json(await fetch(`${base}/api/t/${fresh}`))).card.number, 9);

    await patch(base, s, '/api/settings', { qr_mode: 'shop' });
    const oldShop = (await get(base, s, '/api/admin/qr-shop')).url.split('/t/')[1];
    const newShop = (await json(await post(base, s, '/api/admin/qr-shop/regenerate'))).url.split('/t/')[1];
    assert.notEqual(newShop, oldShop);
    assert.equal((await fetch(`${base}/api/t/${oldShop}`)).status, 404);
    assert.equal((await fetch(`${base}/api/t/${newShop}`)).status, 200);

    const actions = (await db.query(
      "SELECT action FROM audit_log WHERE action IN ('card.qr_regenerate','qr_shop.regenerate') ORDER BY id")).rows.map(x => x.action);
    assert.deepEqual(actions, ['card.qr_regenerate', 'qr_shop.regenerate']);
  });
});
