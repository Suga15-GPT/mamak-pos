const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const {
  startApp, setup, post, patch, del, get, json, openCard, one, race, orderRow,
} = require('../apphelper');

/* Split by items (day-one fixes, part 3): tick lines, and pay exactly those
   lines' share of the bill, service charge and SST included; the last share
   takes any rounding remainder; cash is rounded to 5 sen only on the payment
   that settles the bill. Split by seat is gone; the seat column stays. */

const preview = async (base, s, orderId, ids) => {
  const r = await fetch(`${base}/api/orders/${orderId}/split?by=items&items=${ids.join(',')}`, { headers: s.h });
  return { status: r.status, body: await r.json() };
};
const payItems = (base, s, orderId, ids, method = 'Card', amount) =>
  post(base, s, `/api/orders/${orderId}/pay`, { method, item_ids: ids, ...(amount !== undefined ? { amount } : {}) });
const linesOf = async (db, orderId) => (await db.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id', [orderId])).rows.map(r => r.id);
const payments = async (db, orderId) => (await db.query(
  'SELECT method, amount_cents, tendered_cents, item_ids FROM payments WHERE order_id = $1 ORDER BY id', [orderId])).rows;

async function withRates(base, s, svc, tax) {
  assert.equal((await patch(base, s, '/api/settings', { svc_rate_bp: svc, tax_rate_bp: tax })).status, 200);
}

test('Split by items: each share is its lines\' part of the bill with their service charge and SST, and the last share takes the remainder', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await withRates(base, s, 1000, 600);
    // Three RM2.00 lines: 6.00 + 10% service 0.60 + 6% SST on 6.60 (0.40) = 7.00.
    const id = await openCard(base, s, 1, [one(s.roti)[0], one(s.roti)[0], one(s.roti)[0]]);
    const [a, b, c] = await linesOf(db, id);
    assert.equal((await orderRow(db, id)).total_cents, 700);

    const pa = await preview(base, s, id, [a]);
    assert.equal(pa.status, 200);
    assert.deepEqual(pa.body, { amount: 2.33, last: false, due: 7, item_ids: [a] }, 'a third of 7.00, rounded');
    const r1 = await json(await payItems(base, s, id, [a], 'Card', 2.33));
    assert.deepEqual([r1.paid, r1.remaining, r1.settled], [2.33, 4.67, false]);

    // Cash on a share that doesn't settle the bill is not rounded.
    const r2 = await json(await payItems(base, s, id, [b], 'Cash', 2.33));
    assert.deepEqual([r2.paid, r2.change, r2.remaining, r2.settled], [2.33, 0, 2.34, false]);

    // The last share is what is left — 2.34, not 2.33 — and in cash rounds to 2.35.
    const pc = await preview(base, s, id, [c]);
    assert.deepEqual(pc.body, { amount: 2.34, last: true, due: 2.34, item_ids: [c] });
    const r3 = await json(await payItems(base, s, id, [c], 'Cash', 2.34));
    assert.deepEqual([r3.paid, r3.settled], [2.35, true]);

    const o = await orderRow(db, id);
    assert.equal(o.status, 'paid');
    assert.equal(o.rounding_cents, 1, 'the 5-sen rounding lands on the settling cash share only');
    assert.equal(o.total_cents, 701);
    const rows = await payments(db, id);
    assert.deepEqual(rows.map(p => [p.method, p.amount_cents, p.item_ids]),
      [['Card', 233, [a]], ['Cash', 233, [b]], ['Cash', 235, [c]]]);
    assert.equal(rows.reduce((t, p) => t + p.amount_cents, 0), o.total_cents, 'the shares add up to the bill exactly');
    const audit = (await db.query("SELECT detail FROM audit_log WHERE action = 'order.pay' ORDER BY id")).rows.map(r => r.detail);
    assert.deepEqual(audit.map(d => [d.item_ids, d.last_share]), [[[a], false], [[b], false], [[c], true]]);
  });
});

test('Split by items shares out a discount with the tax, and works beside a specific amount paid first', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await withRates(base, s, 1000, 600);
    // 2.00 + 8.50 = 10.50; service 1.05; SST 6% of 11.55 = 0.69; less RM1.00 = 11.24.
    const id = await openCard(base, s, 2, [one(s.roti)[0], one(s.mee)[0]]);
    const [roti, mee] = await linesOf(db, id);
    assert.equal((await post(base, s, `/api/orders/${id}/discounts`, { kind: 'amount', value: 1, reason: 'regular customer' })).status, 200);
    assert.equal((await orderRow(db, id)).total_cents, 1124);
    // Roti's share: 11.24 × 2.00 / 10.50 = 2.141 -> 2.14.
    assert.equal((await preview(base, s, id, [roti])).body.amount, 2.14);
    assert.equal((await preview(base, s, id, [mee])).body.amount, 9.1, 'mee: 11.24 × 8.50 / 10.50 = 9.10');

    // Someone pays RM5 towards the bill first; the item shares carry on.
    assert.equal((await post(base, s, `/api/orders/${id}/pay`, { method: 'Card', amount: 5 })).status, 200);
    assert.equal((await json(await payItems(base, s, id, [roti], 'Card', 2.14))).remaining, 4.1);
    const last = await preview(base, s, id, [mee]);
    assert.deepEqual([last.body.amount, last.body.last], [4.1, true], 'the last share is whatever is left');
    const r = await json(await payItems(base, s, id, [mee], 'DuitNow/eWallet', 4.1));
    assert.equal(r.settled, true);
    const rows = await payments(db, id);
    assert.equal(rows.reduce((t, p) => t + p.amount_cents, 0), 1124);
  });
});

test('Split by items refuses lines already paid for, lines not on the bill, and a bill that changed since the amount was shown — recording nothing', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const id = await openCard(base, s, 3, [one(s.roti)[0], one(s.mee)[0], one(s.telur)[0], one(s.teh)[0]]);
    const [roti, mee, telur, teh] = await linesOf(db, id);
    const other = await openCard(base, s, 4, one(s.roti));
    const [otherLine] = await linesOf(db, other);

    assert.equal((await payItems(base, s, id, [roti], 'Card')).status, 200);
    const bill = (await get(base, s, '/api/orders')).find(o => o.id === id);
    assert.deepEqual(bill.paid_item_ids, [roti]);
    assert.deepEqual(bill.payments.map(p => p.item_ids), [[roti]]);

    const count = async () => (await payments(db, id)).length;
    const again = await payItems(base, s, id, [roti, mee], 'Card');
    assert.equal(again.status, 409);
    assert.equal((await json(again)).error, 'Some of those items have already been paid for.');
    assert.equal((await preview(base, s, id, [roti])).status, 409);
    const foreign = await payItems(base, s, id, [otherLine], 'Card');
    assert.equal(foreign.status, 400);
    assert.equal((await json(foreign)).error, 'Those items are not on this bill.');
    for (const bad of [[], ['x'], [0]]) assert.equal((await payItems(base, s, id, bad, 'Card')).status, 400, JSON.stringify(bad));

    // The till showed a price (9.01); a RM1.00 discount lands before it is taken.
    const shown = (await preview(base, s, id, [mee])).body.amount;
    assert.equal(shown, 9.01);
    assert.equal((await post(base, s, `/api/orders/${id}/discounts`, { kind: 'amount', value: 1, reason: 'kept waiting' })).status, 200);
    const stale = await payItems(base, s, id, [mee], 'Card', shown);
    assert.equal(stale.status, 409);
    assert.equal((await json(stale)).error, 'The bill has changed: these items now come to RM 8.51. Check the amount and take it again.');
    assert.equal(await count(), 1, 'nothing recorded');
    assert.equal((await post(base, s, `/api/orders/${id}/items/${teh}/void`, { reason: 'wrong drink' })).status, 200);
    const voided = await payItems(base, s, id, [teh], 'Card');
    assert.equal(voided.status, 400, 'a voided line is not on the bill');

    // With the right amount it goes through, and the last line settles it.
    const now = (await preview(base, s, id, [mee])).body.amount;
    assert.equal((await payItems(base, s, id, [mee], 'Card', now)).status, 200);
    const end = await json(await payItems(base, s, id, [telur], 'Card'));
    assert.equal(end.settled, true);
    const o = await orderRow(db, id);
    assert.equal((await payments(db, id)).reduce((t, p) => t + p.amount_cents, 0), o.total_cents);
  });
});

test('a share refunded in full frees its lines to be paid for again', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const id = await openCard(base, s, 5, [one(s.roti)[0], one(s.mee)[0]]);
    const [roti, mee] = await linesOf(db, id);
    assert.equal((await payItems(base, s, id, [roti], 'Card')).status, 200);
    const [p] = (await get(base, s, '/api/orders')).find(o => o.id === id).payments;
    assert.equal((await post(base, s, `/api/orders/${id}/refunds`, { payment_id: p.id, amount: p.amount, reason: 'wrong card charged' })).status, 200);
    assert.deepEqual((await get(base, s, '/api/orders')).find(o => o.id === id).paid_item_ids, []);
    const all = await preview(base, s, id, [roti, mee]);
    assert.deepEqual([all.body.amount, all.body.last], [11.13, true]);
    assert.equal((await json(await payItems(base, s, id, [roti, mee], 'Card', 11.13))).settled, true);
  });
});

test('Split by items is part of Split and combine, not for a combined bill; Split by seat is gone and the seat column stays', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 6, one(s.roti));
    const b = await openCard(base, s, 7, one(s.roti));
    assert.equal((await post(base, s, '/api/bill-groups', { order_ids: [a, b] })).status, 201);
    const [line] = await linesOf(db, a);
    assert.equal((await preview(base, s, a, [line])).status, 409);
    assert.equal((await payItems(base, s, a, [line], 'Card')).status, 409);

    const c = await openCard(base, s, 8, one(s.roti));
    const [cl] = await linesOf(db, c);
    const seat = await fetch(`${base}/api/orders/${c}/split?by=seat`, { headers: s.h });
    assert.equal(seat.status, 400);
    assert.equal((await seat.json()).error, 'ways or by=items required');
    const column = (await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'order_items' AND column_name = 'seat'")).rows;
    assert.equal(column.length, 1, 'forward-only: the column is kept');

    assert.equal((await patch(base, s, '/api/features', { features: { split_combine: false } })).status, 409, 'a combined bill is open');
    assert.equal((await del(base, s, `/api/bill-groups/${(await get(base, s, '/api/orders')).find(o => o.id === a).bill_group_id}`)).status, 200);
    assert.equal((await patch(base, s, '/api/features', { features: { split_combine: false } })).status, 200);
    assert.equal((await preview(base, s, c, [cl])).status, 404);
    assert.equal((await payItems(base, s, c, [cl], 'Card')).status, 404);
    assert.equal((await post(base, s, `/api/orders/${c}/merge`, { from_order_id: a })).status, 404);
    // Paying in full needs no module.
    assert.equal((await post(base, s, `/api/orders/${c}/pay`, { method: 'Card' })).status, 200);
  });
});

test('race: two tills paying overlapping items at once — every line is paid for once: 20 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const id = await openCard(base, s, (i % 40) + 1, [one(s.roti)[0], one(s.mee)[0], one(s.telur)[0]]);
      const [x, y] = await linesOf(db, id);
      const [p1, p2] = await race(i, () => payItems(base, s, id, [x], 'Card'), () => payItems(base, s, id, [x, y], 'Card'));
      assert.deepEqual([p1.status, p2.status].sort(), [200, 409], `run ${i}: ${p1.status}/${p2.status}`);
      seen.add(p1.status === 200 ? 'one line first' : 'two lines first');
      const paidIds = (await payments(db, id)).flatMap(p => p.item_ids);
      assert.equal(new Set(paidIds).size, paidIds.length, `run ${i}: no line paid twice`);
      // Settle what is left, so the card is free for a later run.
      assert.equal((await post(base, s, `/api/orders/${id}/pay`, { method: 'Card' })).status, 200);
      const o = await orderRow(db, id);
      assert.equal((await payments(db, id)).reduce((t, p) => t + p.amount_cents, 0), o.total_cents, `run ${i}`);
    }
    assert.deepEqual([...seen].sort(), ['one line first', 'two lines first']);
  });
});
