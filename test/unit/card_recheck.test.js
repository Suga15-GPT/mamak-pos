const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');

/* Regression tests for the PR #16 re-check (at 7387495). Each reproduces the
   finding through the real routes; the races fire the conflicting requests
   concurrently, 40 iterations each. */

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


const HELD = 'A customer order is waiting for approval — approve or reject it first.';
const status = r => r.status;

// Enough cards for 40 iterations of three each.
async function manyCards(base, s) {
  assert.equal((await patch(base, s, '/api/admin/cards/count', { count: 130 })).status, 200);
  const cards = await json(await fetch(`${base}/api/admin/cards`, { headers: s.h }));
  s.card = n => cards.find(c => c.number === n);
}

/* ===== #5: the reviewer's three deadlock scenarios ===== */

test('#5 combine naming a NON-lowest member of a group vs paying that group: 40 concurrent runs, no 500', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    for (let i = 0; i < 40; i++) {
      const [a, b, c] = [3 * i + 1, 3 * i + 2, 3 * i + 3];
      const oa = await openCard(base, s, a, one(s.roti));
      const ob = await openCard(base, s, b, one(s.roti));
      const oc = await openCard(base, s, c, one(s.roti));
      const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [oa, ob] }));
      // "Combine" on Card c, ticking Card b — already combined, not its lowest id.
      const [combined, paid] = await Promise.all([
        post(base, s, '/api/bill-groups', { order_ids: [oc, ob] }),
        post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Cash' }] }),
      ]);
      assert.ok(combined.status < 500, `run ${i}: combine ${combined.status}`);
      assert.ok(paid.status < 500, `run ${i}: pay ${paid.status}`);
      for (const id of [oa, ob, oc]) await assertOrderBalances(db, id, `run ${i} order ${id}`);
    }
  });
});

test('#5 the added card was opened first (lowest id) vs paying the group: 40 concurrent runs, no 500', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    for (let i = 0; i < 40; i++) {
      const [a, b, c] = [3 * i + 1, 3 * i + 2, 3 * i + 3];
      const oc = await openCard(base, s, c, one(s.roti));   // opened first: lowest order id
      const oa = await openCard(base, s, a, one(s.roti));
      const ob = await openCard(base, s, b, one(s.roti));
      const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [oa, ob] }));
      const [combined, paid] = await Promise.all([
        post(base, s, '/api/bill-groups', { order_ids: [oc, ob] }),
        post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Cash' }] }),
      ]);
      assert.ok(combined.status < 500, `run ${i}: combine ${combined.status}`);
      assert.ok(paid.status < 500, `run ${i}: pay ${paid.status}`);
      for (const id of [oa, ob, oc]) await assertOrderBalances(db, id, `run ${i} order ${id}`);
    }
  });
});

test('#5 un-combine racing combine on the same group: 40 concurrent runs, no 500', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    for (let i = 0; i < 40; i++) {
      const [a, b, c] = [3 * i + 1, 3 * i + 2, 3 * i + 3];
      const oc = await openCard(base, s, c, one(s.roti));
      const oa = await openCard(base, s, a, one(s.roti));
      const ob = await openCard(base, s, b, one(s.roti));
      const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [oa, ob] }));
      const [combined, removed] = await Promise.all([
        post(base, s, '/api/bill-groups', { order_ids: [oc, ob] }),
        del(base, s, `/api/bill-groups/${g.id}/orders/${oa}`),
      ]);
      assert.ok(combined.status < 500, `run ${i}: combine ${combined.status}`);
      assert.ok(removed.status < 500, `run ${i}: un-combine ${removed.status}`);
    }
  });
});

/* ===== R-A: a held customer order must never be closed away ===== */

async function heldScenario(base, s, db, number) {
  await patch(base, s, '/api/settings', { qr_require_approval: true });
  const id = await openCard(base, s, number, one(s.roti));                      // accepted, 2.12
  const q = await json(await publicOrder(base, { table_token: s.card(number).qr_token, items: [{ item_id: s.teh.id, qty: 2 }] }));
  assert.equal(q.status, 'pending');
  return { id, ref: q.ref };
}

async function assertHeldSurvives(base, s, db, id, ref, number) {
  const row = await orderRow(db, id);
  assert.ok(!['paid', 'cancelled', 'refunded'].includes(row.status), `the card stays open (was ${row.status})`);
  assert.equal((await get(base, s, '/api/cards')).find(c => c.number === number).in_use, true, 'the card is not handed out again');
  const pending = await get(base, s, '/api/kitchen/pending');
  const mine = pending.find(p => p.order_id === id);
  assert.ok(mine, 'the round is still in the approval queue');
  assert.equal((await post(base, s, `/api/kitchen/sends/${mine.id}/approve`)).status, 200, 'approving it works');
  assert.equal((await json(await fetch(`${base}/api/public/sends/${ref}`))).status, 'sent', "the customer's phone says sent");
  await assertOrderBalances(db, id, 'after approval');
}

test('R-A voiding the only accepted line while a customer round is held keeps the card open and the round decidable', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { id, ref } = await heldScenario(base, s, db, 4);
    const [line] = await lineIds(db, id);
    assert.equal((await post(base, s, `/api/orders/${id}/items/${line}/void`, { reason: 'burnt it' })).status, 200);
    await assertHeldSurvives(base, s, db, id, ref, 4);
  });
});

test('R-A a discount to zero while a customer round is held keeps the card open and the round decidable', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { id, ref } = await heldScenario(base, s, db, 5);
    assert.equal((await post(base, s, `/api/orders/${id}/discounts`, { kind: 'amount', value: 2.12, reason: 'long wait' })).status, 200);
    await assertHeldSurvives(base, s, db, id, ref, 5);
  });
});

test('R-A a comp while a customer round is held is refused (409), like payment', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { id, ref } = await heldScenario(base, s, db, 6);
    const r = await post(base, s, `/api/orders/${id}/discounts`, { kind: 'comp', reason: 'on the house' });
    assert.equal(r.status, 409);
    assert.equal((await json(r)).error, HELD);
    assert.equal((await db.query('SELECT count(*)::int n FROM discounts WHERE order_id = $1', [id])).rows[0].n, 0);
    await assertHeldSurvives(base, s, db, id, ref, 6);
  });
});

test('R-A a grouped card with a held round never leaves its group on its own', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { id } = await heldScenario(base, s, db, 7);
    const other = await openCard(base, s, 8, one(s.roti));
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [id, other] }));
    const [line] = await lineIds(db, id);
    await post(base, s, `/api/orders/${id}/items/${line}/void`, { reason: 'burnt it' });
    assert.equal((await orderRow(db, id)).bill_group_id, g.id, 'still combined');
    assert.deepEqual(await groupAudit(db, g.id), ['bill_group.combine']);
  });
});

/* ===== N-B: a void or discount racing a payment ===== */

test('N-B void racing a payment never rewrites the just-paid bill: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, (i % 50) + 1, one(s.roti));
      const [line] = await lineIds(db, id);
      const [paid, voided] = await Promise.all([
        post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' }),
        post(base, s, `/api/orders/${id}/items/${line}/void`, { reason: 'wrong order' }),
      ]);
      assert.ok(paid.status < 500 && voided.status < 500, `run ${i}: ${paid.status}/${voided.status}`);
      assert.equal((await orderRow(db, id)).status, 'paid', `run ${i}`);
      await assertOrderBalances(db, id, `run ${i}`);
    }
  });
});

test('N-B a 10% discount racing a payment never rewrites the just-paid bill: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    for (let i = 0; i < 40; i++) {
      const id = await openCard(base, s, (i % 50) + 1, one(s.mee));
      const [paid, disc] = await Promise.all([
        post(base, s, `/api/orders/${id}/pay`, { method: 'Cash' }),
        post(base, s, `/api/orders/${id}/discounts`, { kind: 'percent', value: 10, reason: 'regular customer' }),
      ]);
      assert.ok(paid.status < 500 && disc.status < 500, `run ${i}: ${paid.status}/${disc.status}`);
      await assertOrderBalances(db, id, `run ${i}`);
    }
  });
});

test('N-B a void on a grouped card racing the group payment never rewrites the paid bill: 40 concurrent runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    for (let i = 0; i < 40; i++) {
      const a = await openCard(base, s, 2 * i + 1, one(s.roti));
      const b = await openCard(base, s, 2 * i + 2, [{ item_id: s.roti.id, qty: 1 }, { item_id: s.mee.id, qty: 1 }]);
      const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));
      const [, meeLine] = await lineIds(db, b);
      const [paid, voided] = await Promise.all([
        post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Cash' }] }),
        post(base, s, `/api/orders/${b}/items/${meeLine}/void`, { reason: 'wrong order' }),
      ]);
      assert.ok(paid.status < 500 && voided.status < 500, `run ${i}: ${paid.status}/${voided.status}`);
      for (const id of [a, b]) await assertOrderBalances(db, id, `run ${i} order ${id}`);
    }
  });
});

/* ===== Small ===== */

test('combining a card that already has a payment of its own is refused (409)', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, [{ item_id: s.roti.id, qty: 3 }]);
    const b = await openCard(base, s, 2, one(s.roti));
    assert.equal((await post(base, s, `/api/orders/${a}/pay`, { method: 'Card', amount: 2 })).status, 200);
    const r = await post(base, s, '/api/bill-groups', { order_ids: [b, a] });
    assert.equal(r.status, 409);
    assert.equal((await json(r)).error, 'This card has a payment on it — pay or refund it before combining.');
    assert.equal((await db.query('SELECT count(*)::int n FROM bill_groups')).rows[0].n, 0);
  });
});

test('too little cash on a combined bill says how much was given and how much is still due', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, one(s.roti));
    const b = await openCard(base, s, 2, one(s.mee));
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));   // 2.12 + 9.01 = 11.13
    const r = await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: 2.13 }, { method: 'Cash', tendered: 5 }] });
    assert.equal(r.status, 400);
    assert.equal((await json(r)).error, 'Cash given RM 5.00 is less than the RM 9.00 still due');
    assert.equal((await db.query('SELECT count(*)::int n FROM payments')).rows[0].n, 0);
  });
});
