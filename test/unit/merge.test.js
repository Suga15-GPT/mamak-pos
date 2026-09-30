const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const {
  startApp, setup, post, patch, del, get, json, publicOrder, openCard, one, manyCards, race, orderRow, assertBalanced,
} = require('../apphelper');

/* Combine = merge (day-one fixes, part 2). On Card 1, Combine -> Card 4 moves
   Card 4's rounds, lines and kitchen tickets onto Card 1's bill, closes Card
   4's emptied order as 'merged' and frees Card 4. "Separate Card 4" moves
   exactly those back to a new order on Card 4. */

const merge = (base, s, into, from) => post(base, s, `/api/orders/${into}/merge`, { from_order_id: from });
const separate = (base, s, orderId, cardNumber) => post(base, s, `/api/orders/${orderId}/separate`, { card_id: s.card(cardNumber).id });
const lines = async (db, orderId) => (await db.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id', [orderId])).rows.map(r => r.id);
const sendsOf = async (db, orderId) => (await db.query('SELECT * FROM order_sends WHERE order_id = $1 ORDER BY seq_no', [orderId])).rows;
const openOn = async (db, cardId) => (await db.query(
  "SELECT id FROM orders WHERE card_id = $1 AND status NOT IN ('paid','cancelled','refunded','merged')", [cardId])).rows.map(r => r.id);
const kitchenTickets = async (base, s, station = 'kitchen') => (await get(base, s, `/api/kitchen/tickets?station=${station}`)).tickets;
const errorOf = async res => (await json(res)).error;

/* Nothing sits on a merged order: no line, no round, no payment. */
async function assertMergedEmpty(db, label) {
  const r = (await db.query(
    `SELECT (SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'merged')::int AS lines,
            (SELECT count(*) FROM order_sends s JOIN orders o ON o.id = s.order_id WHERE o.status = 'merged')::int AS rounds,
            (SELECT count(*) FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.status = 'merged')::int AS payments,
            (SELECT count(*) FROM orders WHERE status = 'merged' AND (total_cents <> 0 OR subtotal_cents <> 0))::int AS money`)).rows[0];
  assert.deepEqual(r, { lines: 0, rounds: 0, payments: 0, money: 0 }, `${label}: a merged order holds nothing`);
}

test('Combine moves Card 4\'s rounds, lines and kitchen tickets onto Card 1\'s bill, and frees Card 4', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const c1 = await openCard(base, s, 1, one(s.roti));
    assert.equal((await post(base, s, `/api/orders/${c1}/items`, { items: one(s.telur) })).status, 200);
    const c4 = await openCard(base, s, 4, one(s.mee));
    const c4Lines = await lines(db, c4);
    const [c4Round] = await sendsOf(db, c4);
    const ticket = (await kitchenTickets(base, s)).find(t => t.order_id === c4);
    assert.equal((await patch(base, s, `/api/kitchen/tickets/${ticket.id}`, { status: 'preparing' })).status, 200);

    const r = await merge(base, s, c1, c4);
    assert.equal(r.status, 200, await r.clone().text());
    const body = await json(r);
    assert.equal(body.label, 'Card 1');
    assert.equal(body.from_label, 'Card 4');

    // The lines and the round moved; the ticket went with its round, at the
    // state it was in.
    assert.deepEqual(await lines(db, c4), []);
    assert.deepEqual((await lines(db, c1)).filter(id => c4Lines.includes(id)), c4Lines);
    const moved = (await db.query('SELECT * FROM order_sends WHERE id = $1', [c4Round.id])).rows[0];
    assert.equal(moved.order_id, c1);
    assert.equal(moved.seq_no, 3, 'numbered on after Card 1\'s two rounds');
    assert.equal(moved.merged_from_card_id, s.card(4).id);
    assert.equal(moved.merged_from_order_id, c4);
    assert.equal(moved.merged_from_seq_no, 1);
    assert.ok(moved.merged_at);
    const t = (await db.query('SELECT * FROM order_send_tickets WHERE id = $1', [ticket.id])).rows[0];
    assert.equal(t.send_id, c4Round.id);
    assert.equal(t.status, 'preparing');

    // Card 4's order is closed as merged, with nothing on it.
    const old = await orderRow(db, c4);
    assert.equal(old.status, 'merged');
    assert.equal(old.merged_into_order_id, c1);
    assert.equal(old.total_cents, 0);
    assert.equal(old.subtotal_cents, 0);
    assert.equal(old.paid_at, null);
    assert.equal(old.closed_shift_id, null);
    await assertMergedEmpty(db, 'after the merge');

    // Card 1's bill is all three lines: 2.00 + 3.50 + 8.50, SST 6%.
    const one1 = await orderRow(db, c1);
    assert.equal(one1.subtotal_cents, 1400);
    assert.equal(one1.total_cents, 1484);
    assert.equal(one1.status, 'sent', 'Card 1\'s own rounds are still new, so it reads new');
    await assertBalanced(db, c1, 'Card 1');

    // The floor: Card 4 is free, Card 1 carries Card 4's items, labelled.
    const cards = await get(base, s, '/api/cards');
    assert.equal(cards.find(c => c.number === 4).in_use, false);
    assert.equal(cards.find(c => c.number === 1).in_use, true);
    const open = await get(base, s, '/api/orders');
    assert.equal(open.find(o => o.card_number === 4), undefined);
    const bill = open.find(o => o.id === c1);
    assert.deepEqual(bill.merged_from, [{ card_id: s.card(4).id, card_number: 4 }]);
    const mee = bill.items.find(i => i.name === 'Mee Goreng Mamak');
    assert.equal(mee.from_card, 4);
    assert.equal(mee.round_no, 1);
    assert.equal(bill.items.find(i => i.name === 'Roti Canai').from_card, null);

    // The kitchen board: "Card 1 (from 4)", still its own round 1, not an add-on.
    const board = await kitchenTickets(base, s);
    const moved4 = board.find(x => x.id === ticket.id);
    assert.equal(moved4.table, 'Card 1 (from 4)');
    assert.equal(moved4.round, 1);
    assert.equal(moved4.is_addon, false);
    assert.equal(moved4.status, 'preparing');
    assert.equal(board.find(x => x.order_id === c1 && x.round === 2).table, 'Card 1');

    // A new group takes Card 4 at once.
    const fresh = await openCard(base, s, 4, one(s.roti));
    assert.notEqual(fresh, c4);

    const audit = (await db.query("SELECT * FROM audit_log WHERE action = 'order.merge'")).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_id, c1);
    assert.equal(audit[0].detail.from_order_id, c4);
    assert.equal(audit[0].detail.from, 'Card 4');
    assert.equal(audit[0].detail.to, 'Card 1');
  });
});

test('Card 4\'s merged order counts as neither a sale nor a cancellation in any report', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const shift = await get(base, s, '/api/shift/current');
    const c1 = await openCard(base, s, 1, one(s.roti));
    const c4 = await openCard(base, s, 4, one(s.mee));
    assert.equal((await merge(base, s, c1, c4)).status, 200);

    // While Card 1 is open: one bill carried forward, not two.
    const x = await get(base, s, `/api/shift/${shift.id}/report`);
    assert.equal(x.carried_forward.count, 1);
    assert.equal(x.carried_forward.cents, 1113);
    const floor = (await get(base, s, '/api/dashboard')).floor;
    assert.equal(floor.open_cards, 1);

    assert.equal((await post(base, s, `/api/orders/${c1}/pay`, { method: 'Card' })).status, 200);
    const dash = await get(base, s, '/api/dashboard');
    assert.equal(dash.today.orders, 1);
    assert.equal(dash.today.sales, 11.13);
    assert.equal(dash.today.dine_in.orders, 1);
    const summary = await get(base, s, '/api/summary');
    assert.equal(summary.today.orders, 1);
    assert.equal(summary.today.sales, 11.13);

    assert.equal((await post(base, s, '/api/shift/close', { counted: 0, note: 'card only' })).status, 200);
    const z = await get(base, s, `/api/shift/${shift.id}/report?final=1`);
    assert.equal(z.order_count, 1);
    assert.equal(z.net_sales_cents, 1113);
    assert.equal(z.gross_cents, 1050);
    assert.equal(z.carried_forward.count, 0);
    assert.deepEqual(z.top_items.map(i => i.name).sort(), ['Mee Goreng Mamak', 'Roti Canai']);

    assert.equal((await db.query("SELECT count(*)::int n FROM orders WHERE status = 'cancelled'")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE action = 'order.cancel'")).rows[0].n, 0);
    assert.equal((await orderRow(db, c4)).status, 'merged');
  });
});

test('Combine is refused when either bill has a payment, when Card 4 has a discount or a round awaiting approval, and for takeaway, closed or grouped bills', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const refused = async (into, from, status, pattern, label) => {
      const before = await lines(db, from);
      const r = await merge(base, s, into, from);
      assert.equal(r.status, status, `${label}: ${r.status}`);
      assert.match(await errorOf(r), pattern, label);
      assert.deepEqual(await lines(db, from), before, `${label}: nothing moved`);
      assert.notEqual((await orderRow(db, from)).status, 'merged', label);
    };

    // A payment on Card 1, then on Card 4.
    let c1 = await openCard(base, s, 1, [{ item_id: s.mee.id, qty: 2 }]);
    let c4 = await openCard(base, s, 4, one(s.roti));
    assert.equal((await post(base, s, `/api/orders/${c1}/pay`, { method: 'Card', amount: 1 })).status, 200);
    await refused(c1, c4, 409, /^Card 1 has a payment on it, so it can't be combined\.$/, 'payment on Card 1');
    await refused(c4, c1, 409, /^Card 1 has a payment on it/, 'payment on the card moving');

    const c2 = await openCard(base, s, 2, one(s.roti));
    const c5 = await openCard(base, s, 5, [{ item_id: s.mee.id, qty: 2 }]);
    assert.equal((await post(base, s, `/api/orders/${c5}/pay`, { method: 'Cash', amount: 1 })).status, 200);
    await refused(c2, c5, 409, /^Card 5 has a payment on it/, 'payment on Card 5');

    // A discount on the card moving: remove it first. On the card staying, fine.
    const c6 = await openCard(base, s, 6, one(s.mee));
    const d = await json(await post(base, s, `/api/orders/${c6}/discounts`, { kind: 'amount', value: 1, reason: 'regular customer' }));
    await refused(c2, c6, 409, /^Card 6 has a discount — remove the discount first\.$/, 'discount on Card 6');
    assert.equal((await del(base, s, `/api/orders/${c6}/discounts/${d.id}`)).status, 200);
    const c7 = await openCard(base, s, 7, one(s.mee));
    assert.equal((await post(base, s, `/api/orders/${c7}/discounts`, { kind: 'amount', value: 1, reason: 'regular customer' })).status, 200);
    assert.equal((await merge(base, s, c7, c6)).status, 200, 'the card staying may carry a discount');
    assert.equal((await orderRow(db, c7)).discount_cents, 100, 'and keeps it');

    // A customer round awaiting approval on the card moving.
    assert.equal((await patch(base, s, '/api/settings', { qr_require_approval: true })).status, 200);
    const tok8 = (await get(base, s, '/api/admin/cards')).find(c => c.number === 8).qr_token;
    assert.equal((await publicOrder(base, { table_token: tok8, items: one(s.roti) })).status, 201);
    const [c8] = await openOn(db, s.card(8).id);
    await refused(c2, c8, 409, /^Card 8 has a customer order waiting for approval — approve or reject it first\.$/, 'held round');
    assert.equal((await patch(base, s, '/api/settings', { qr_require_approval: false })).status, 200);

    // Takeaway, the same card, a closed bill.
    const ta = await json(await post(base, s, '/api/orders', { order_type: 'takeaway', items: one(s.roti) }));
    await refused(c2, ta.id, 409, /Only card bills can be combined/, 'takeaway');
    await refused(ta.id, c2, 409, /Only card bills can be combined/, 'into a takeaway');
    const self = await merge(base, s, c2, c2);
    assert.equal(self.status, 400);
    const c9 = await openCard(base, s, 9, one(s.roti));
    assert.equal((await post(base, s, `/api/orders/${c9}/pay`, { method: 'Card' })).status, 200);
    await refused(c9, c2, 409, /^Card 9's bill is already closed\.$/, 'closed target');

    // A card still on a combined bill from before merge shipped.
    const c10 = await openCard(base, s, 10, one(s.roti));
    const c11 = await openCard(base, s, 11, one(s.roti));
    assert.equal((await post(base, s, '/api/bill-groups', { order_ids: [c10, c11] })).status, 201);
    await refused(c2, c10, 409, /^Card 10 is on a combined bill from before — take it off that bill first\.$/, 'grouped card');
    await refused(c10, c2, 409, /^Card 10 is on a combined bill from before/, 'into a grouped card');

    await assertMergedEmpty(db, 'after every refusal');
  });
});

test('"Separate Card 4" moves exactly Card 4\'s lines and tickets back to a new order on Card 4', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const c1 = await openCard(base, s, 1, one(s.roti));
    const c4 = await openCard(base, s, 4, one(s.mee));
    assert.equal((await post(base, s, `/api/orders/${c4}/items`, { items: one(s.telur) })).status, 200);
    const c4Lines = await lines(db, c4);
    const c4Rounds = await sendsOf(db, c4);
    const c4Tickets = (await db.query(
      'SELECT id, send_id, status FROM order_send_tickets WHERE send_id = ANY($1::int[]) ORDER BY id', [c4Rounds.map(r => r.id)])).rows;
    const c1Before = await orderRow(db, c1);
    assert.equal((await merge(base, s, c1, c4)).status, 200);
    // Card 1 goes on ordering after the merge: that round stays with Card 1.
    assert.equal((await post(base, s, `/api/orders/${c1}/items`, { items: one(s.roti) })).status, 200);
    const c1Own = (await lines(db, c1)).filter(id => !c4Lines.includes(id));

    const r = await separate(base, s, c1, 4);
    assert.equal(r.status, 200, await r.clone().text());
    const { new_order_id: fresh } = await json(r);
    assert.notEqual(fresh, c4);

    assert.deepEqual(await lines(db, fresh), c4Lines, 'exactly Card 4\'s lines');
    assert.deepEqual(await lines(db, c1), c1Own, 'Card 1 keeps its own, including the round after the merge');
    const back = await sendsOf(db, fresh);
    assert.deepEqual(back.map(x => x.id), c4Rounds.map(x => x.id));
    assert.deepEqual(back.map(x => x.seq_no), [1, 2], 'numbered as they were sent on Card 4');
    assert.ok(back.every(x => x.merged_from_card_id === null && x.merged_at === null));
    assert.deepEqual((await db.query(
      'SELECT id, send_id, status FROM order_send_tickets WHERE send_id = ANY($1::int[]) ORDER BY id', [c4Rounds.map(x => x.id)])).rows,
      c4Tickets, 'the same tickets, at the same states');

    const row = await orderRow(db, fresh);
    assert.equal(row.card_id, s.card(4).id);
    assert.equal(row.status, 'sent');
    assert.equal(row.subtotal_cents, 1200);
    assert.equal(row.total_cents, 1272);
    const c1After = await orderRow(db, c1);
    assert.equal(c1After.subtotal_cents, c1Before.subtotal_cents + 200, 'Card 1 is back to its own lines');
    await assertBalanced(db, c1, 'Card 1');
    await assertBalanced(db, fresh, 'Card 4 again');
    assert.equal((await orderRow(db, c4)).status, 'merged', 'the merged order stays closed');

    const board = await get(base, s, '/api/kitchen/tickets?station=kitchen');
    assert.ok(board.tickets.filter(t => t.order_id === fresh).every(t => t.table === 'Card 4'));
    const cards = await get(base, s, '/api/cards');
    assert.equal(cards.find(c => c.number === 4).in_use, true);
    const bill = (await get(base, s, '/api/orders')).find(o => o.id === c1);
    assert.deepEqual(bill.merged_from, []);
    const audit = (await db.query("SELECT * FROM audit_log WHERE action = 'order.separate'")).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_id, c1);
    assert.equal(audit[0].detail.new_order_id, fresh);

    // And it can be combined again.
    assert.equal((await merge(base, s, c1, fresh)).status, 200);
    assert.deepEqual((await lines(db, c1)).filter(id => c4Lines.includes(id)), c4Lines);
  });
});

test('Separate is refused once the bill has a payment, once Card 4 has a new bill, and past a discount given after the merge', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const refused = async (orderId, card, status, pattern, label) => {
      const before = await lines(db, orderId);
      const r = await separate(base, s, orderId, card);
      assert.equal(r.status, status, `${label}: ${r.status}`);
      assert.match(await errorOf(r), pattern, label);
      assert.deepEqual(await lines(db, orderId), before, `${label}: nothing moved`);
    };

    // A payment on the bill.
    const c1 = await openCard(base, s, 1, [{ item_id: s.mee.id, qty: 2 }]);
    const c4 = await openCard(base, s, 4, one(s.roti));
    assert.equal((await merge(base, s, c1, c4)).status, 200);
    assert.equal((await post(base, s, `/api/orders/${c1}/pay`, { method: 'Card', amount: 1 })).status, 200);
    await refused(c1, 4, 409, /^This bill has a payment on it, so Card 4's items can't be separated\.$/, 'payment');

    // Card 4 given to the next group.
    const c2 = await openCard(base, s, 2, one(s.mee));
    const c5 = await openCard(base, s, 5, one(s.roti));
    assert.equal((await merge(base, s, c2, c5)).status, 200);
    await openCard(base, s, 5, one(s.telur));
    await refused(c2, 5, 409, /^Card 5 has a new bill of its own now, so its earlier items can't go back to it\.$/, 'card in use');

    // A discount given after the merge; a discount from before is fine.
    const c3 = await openCard(base, s, 3, one(s.mee));
    const early = await json(await post(base, s, `/api/orders/${c3}/discounts`, { kind: 'amount', value: 1, reason: 'before combining' }));
    const c6 = await openCard(base, s, 6, one(s.mee));
    assert.equal((await merge(base, s, c3, c6)).status, 200);
    const late = await json(await post(base, s, `/api/orders/${c3}/discounts`, { kind: 'percent', value: 10, reason: 'the whole table' }));
    await refused(c3, 6, 409, /^This bill has a discount given after Card 6 joined it — remove the discount first\.$/, 'late discount');
    assert.equal((await del(base, s, `/api/orders/${c3}/discounts/${late.id}`)).status, 200);
    assert.equal((await separate(base, s, c3, 6)).status, 200, 'the early discount stays with Card 3');
    assert.equal((await orderRow(db, c3)).discount_cents, 100);
    assert.ok(early.id);

    // Nothing came from Card 9.
    const c7 = await openCard(base, s, 7, one(s.roti));
    await refused(c7, 9, 404, /^Nothing on this bill came from Card 9\.$/, 'nothing from that card');
  });
});

test('A merged order is closed for good: paying it, adding to it or retrying its create never reopens it or opens Card 4 again', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const c1 = await openCard(base, s, 1, one(s.roti));
    const key = 'retry-card-4-first-order';
    const created = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: { ...s.h, 'idempotency-key': key },
      body: JSON.stringify({ card_id: s.card(4).id, items: one(s.mee) }),
    });
    const c4 = (await json(created)).id;
    assert.equal((await merge(base, s, c1, c4)).status, 200);

    // The till retrying the create it wasn't sure of finds the merged order.
    const retry = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: { ...s.h, 'idempotency-key': key },
      body: JSON.stringify({ card_id: s.card(4).id, items: one(s.mee) }),
    });
    assert.equal(retry.status, 200);
    assert.equal((await json(retry)).id, c4);
    assert.deepEqual(await openOn(db, s.card(4).id), [], 'Card 4 was not opened again');

    const COMBINED = /^This bill was combined into Card 1 — use Card 1's bill instead\.$/;
    const pay = await post(base, s, `/api/orders/${c4}/pay`, { method: 'Card' });
    assert.equal(pay.status, 409);
    assert.match(await errorOf(pay), COMBINED);
    const add = await post(base, s, `/api/orders/${c4}/items`, { items: one(s.roti) });
    assert.equal(add.status, 409);
    assert.match(await errorOf(add), COMBINED);
    const disc = await post(base, s, `/api/orders/${c4}/discounts`, { kind: 'comp', reason: 'too late now' });
    assert.equal(disc.status, 409);
    assert.match(await errorOf(disc), COMBINED);

    // The database refuses it too (migration 019's 'merged' in the trigger).
    await assert.rejects(db.query("UPDATE orders SET status = 'sent' WHERE id = $1", [c4]), /cannot become sent/);
    await assert.rejects(db.query('UPDATE orders SET total_cents = 500 WHERE id = $1', [c4]), /bill cannot change/);
    await assert.rejects(db.query('UPDATE orders SET merged_into_order_id = NULL WHERE id = $1', [c4]), /where it was merged cannot change/);
    await assert.rejects(db.query('UPDATE orders SET card_id = $2 WHERE id = $1', [c4, s.card(9).id]), /cannot be moved/);
    await assertMergedEmpty(db, 'after every attempt');
  });
});

test('A customer scanning Card 1 sees the merged bill; scanning Card 4 sees a fresh card', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const cards = await get(base, s, '/api/admin/cards');
    const tok = n => cards.find(c => c.number === n).qr_token;
    const c1 = await openCard(base, s, 1, one(s.roti));
    const q = await json(await publicOrder(base, { table_token: tok(4), items: [{ item_id: s.mee.id, qty: 2 }] }));
    const [c4] = await openOn(db, s.card(4).id);

    const before = await json(await fetch(`${base}/api/t/${tok(4)}`));
    assert.equal(before.has_open_order, true);
    assert.deepEqual(before.bill.lines.map(l => [l.qty, l.name, l.from_card]), [[2, 'Mee Goreng Mamak', null]]);

    assert.equal((await merge(base, s, c1, c4)).status, 200);
    const one1 = await json(await fetch(`${base}/api/t/${tok(1)}`));
    assert.equal(one1.has_open_order, true);
    assert.deepEqual(one1.bill.lines.map(l => [l.qty, l.name, l.from_card]),
      [[1, 'Roti Canai', null], [2, 'Mee Goreng Mamak', 4]]);
    assert.equal(one1.bill.total, 20.14, '2.00 + 17.00, SST 6%');
    const four = await json(await fetch(`${base}/api/t/${tok(4)}`));
    assert.equal(four.has_open_order, false);
    assert.equal(four.bill, null);

    // The phone that ordered on Card 4 follows its round to Card 1's bill.
    const status = await json(await fetch(`${base}/api/public/sends/${q.ref}`));
    assert.equal(status.table, 'Card 1 (from 4)');
    assert.equal(status.round, 1);

    // The next group scanning Card 4 starts a bill of its own.
    const next = await publicOrder(base, { table_token: tok(4), items: one(s.telur) });
    assert.equal(next.status, 201);
    const [fresh] = await openOn(db, s.card(4).id);
    assert.notEqual(fresh, c4);
    assert.deepEqual((await db.query('SELECT name FROM order_items WHERE order_id = $1', [fresh])).rows.map(r => r.name), ['Roti Telur']);
    assert.equal((await orderRow(db, c1)).subtotal_cents, 1900, 'Card 1\'s bill is untouched');

    // The shop poster never shows a bill: anyone can type any card number.
    assert.equal((await patch(base, s, '/api/settings', { qr_mode: 'shop' })).status, 200);
    const poster = (await get(base, s, '/api/admin/qr-shop')).url.split('/t/')[1];
    const shop = await json(await fetch(`${base}/api/t/${poster}?card=1`));
    assert.equal(shop.has_open_order, true);
    assert.equal(shop.bill, null);
  });
});

test('Cards combined in a chain keep their own labels and separate one at a time', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const c1 = await openCard(base, s, 1, one(s.roti));
    const c4 = await openCard(base, s, 4, one(s.mee));
    const c7 = await openCard(base, s, 7, one(s.telur));
    const l4 = await lines(db, c4);
    const l7 = await lines(db, c7);
    assert.equal((await merge(base, s, c4, c7)).status, 200);
    assert.equal((await merge(base, s, c1, c4)).status, 200);

    const bill = (await get(base, s, '/api/orders')).find(o => o.id === c1);
    assert.deepEqual(bill.merged_from.map(m => m.card_number), [4, 7]);
    const labels = (await get(base, s, '/api/kitchen/tickets?station=kitchen')).tickets
      .filter(t => t.order_id === c1).map(t => t.table).sort();
    assert.deepEqual(labels, ['Card 1', 'Card 1 (from 4)', 'Card 1 (from 7)']);

    const r7 = await json(await separate(base, s, c1, 7));
    assert.deepEqual(await lines(db, r7.new_order_id), l7);
    const r4 = await json(await separate(base, s, c1, 4));
    assert.deepEqual(await lines(db, r4.new_order_id), l4);
    assert.equal((await lines(db, c1)).length, 1);
    await assertMergedEmpty(db, 'after the chain');

    // A round coming back to the card it was ordered on is simply home.
    const c2 = await openCard(base, s, 2, one(s.roti));
    assert.equal((await merge(base, s, c2, r4.new_order_id)).status, 200);    // Card 4 into Card 2
    const back4 = await openCard(base, s, 4, one(s.telur));
    assert.equal((await merge(base, s, back4, c2)).status, 200);               // Card 2 (with 4's) into the new Card 4
    const home = (await db.query(
      'SELECT merged_from_card_id FROM order_sends WHERE id IN (SELECT send_id FROM order_items WHERE id = ANY($1::int[]))', [l4])).rows;
    assert.deepEqual(home, [{ merged_from_card_id: null }], 'Card 4\'s own round, back on a Card 4 bill, carries no "from"');
  });
});

/* ===== races: 40 runs each, under the bill lock ===== */

const status = r => r.status;

test('race: Combine vs a payment on Card 1 — the payment is always for the bill as it stands: 40 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const c1 = await openCard(base, s, 2 * i + 1, one(s.roti));
      const c4 = await openCard(base, s, 2 * i + 2, one(s.roti));
      const [m, p] = await race(i, () => merge(base, s, c1, c4), () => post(base, s, `/api/orders/${c1}/pay`, { method: 'Card' }));
      assert.equal(p.status, 200, `run ${i}: payment ${p.status}`);
      assert.ok([200, 409].includes(m.status), `run ${i}: merge ${m.status}`);
      const one1 = await orderRow(db, c1);
      assert.equal(one1.status, 'paid', `run ${i}`);
      if (m.status === 200) {
        seen.add('merged first');
        assert.equal(one1.total_cents, 424, `run ${i}: the payment covered both cards`);
        assert.equal((await orderRow(db, c4)).status, 'merged');
      } else {
        seen.add('paid first');
        assert.match(await json(m).then(b => b.error), /^Card \d+'s bill is already closed\.$/);
        assert.equal(one1.total_cents, 212, `run ${i}`);
        assert.equal((await orderRow(db, c4)).status, 'sent', `run ${i}: Card 4 kept its own bill`);
      }
      await assertBalanced(db, c1, `run ${i} Card 1`);
      await assertBalanced(db, c4, `run ${i} Card 4`);
    }
    await assertMergedEmpty(db, 'after 40 runs');
    assert.deepEqual([...seen].sort(), ['merged first', 'paid first']);
  });
});

test('race: Combine vs a payment on Card 4 — exactly one wins, and no money lands on a merged order: 40 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const c1 = await openCard(base, s, 2 * i + 1, one(s.roti));
      const c4 = await openCard(base, s, 2 * i + 2, one(s.mee));
      const [m, p] = await race(i, () => merge(base, s, c1, c4), () => post(base, s, `/api/orders/${c4}/pay`, { method: 'Card' }));
      assert.deepEqual([m.status, p.status].sort(), [200, 409], `run ${i}: merge ${m.status} / pay ${p.status}`);
      if (m.status === 200) {
        seen.add('merged first');
        assert.match(await json(p).then(b => b.error), /^This bill was combined into Card \d+ — use Card \d+'s bill instead\.$/);
        assert.equal((await orderRow(db, c1)).subtotal_cents, 1050, `run ${i}`);
        assert.equal((await orderRow(db, c4)).status, 'merged');
      } else {
        seen.add('paid first');
        assert.equal((await orderRow(db, c4)).status, 'paid');
        assert.equal((await orderRow(db, c1)).subtotal_cents, 200, `run ${i}`);
      }
      await assertBalanced(db, c1, `run ${i} Card 1`);
      await assertBalanced(db, c4, `run ${i} Card 4`);
    }
    await assertMergedEmpty(db, 'after 40 runs');
    assert.deepEqual([...seen].sort(), ['merged first', 'paid first']);
  });
});

test('race: Combine vs a kitchen tap on Card 4\'s ticket — the tap lands on the ticket wherever it is: 40 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    const seen = new Set();
    const ticketOf = async orderId => (await db.query(
      'SELECT t.id FROM order_send_tickets t JOIN order_sends x ON x.id = t.send_id WHERE x.order_id = $1', [orderId])).rows[0].id;
    for (let i = 0; i < 40; i++) {
      const c1 = await openCard(base, s, 2 * i + 1, one(s.roti));
      const c4 = await openCard(base, s, 2 * i + 2, one(s.mee));
      // Card 1's own food is ready, so once Card 4's ticket is on its bill,
      // Card 1 reads as whatever that ticket is doing.
      const own = await ticketOf(c1);
      for (const st of ['preparing', 'ready']) assert.equal((await patch(base, s, `/api/kitchen/tickets/${own}`, { status: st })).status, 200);
      const tk = await ticketOf(c4);
      const [m, tap] = await race(i,
        () => merge(base, s, c1, c4),
        () => patch(base, s, `/api/kitchen/tickets/${tk}`, { status: 'preparing' }));
      assert.equal(m.status, 200, `run ${i}: merge ${m.status}`);
      assert.equal(tap.status, 200, `run ${i}: tap ${tap.status}`);
      seen.add((await json(tap)).order_id === c1 ? 'merged first' : 'tapped first');
      const t = (await db.query(
        'SELECT t.status, x.order_id FROM order_send_tickets t JOIN order_sends x ON x.id = t.send_id WHERE t.id = $1', [tk])).rows[0];
      assert.deepEqual(t, { status: 'preparing', order_id: c1 }, `run ${i}`);
      const old = await orderRow(db, c4);
      assert.equal(old.status, 'merged', `run ${i}: a tap never writes over the merged order`);
      assert.equal(old.total_cents, 0);
      assert.equal((await orderRow(db, c1)).status, 'preparing', `run ${i}: Card 1 reads as the tapped ticket, whichever came first`);
    }
    await assertMergedEmpty(db, 'after 40 runs');
    assert.deepEqual([...seen].sort(), ['merged first', 'tapped first']);
  });
});

test('race: Combine vs a QR add-on to Card 4 — the add-on is on Card 1\'s bill or on a fresh Card 4, never lost: 40 runs', async () => {
  // Forty phones' worth of orders from one test process: tell the rate limit
  // they come from forty addresses.
  process.env.TRUST_PROXY = '1';
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    const cards = await get(base, s, '/api/admin/cards');
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const n1 = 2 * i + 1, n4 = 2 * i + 2;
      const c1 = await openCard(base, s, n1, one(s.roti));
      const c4 = await openCard(base, s, n4, one(s.mee));
      const qr = () => fetch(`${base}/api/public/orders`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${i}.1` },
        body: JSON.stringify({ table_token: cards.find(c => c.number === n4).qr_token, items: one(s.telur) }),
      });
      const [m, q] = await race(i, () => merge(base, s, c1, c4), qr);
      assert.equal(m.status, 200, `run ${i}: merge ${m.status}`);
      assert.equal(q.status, 201, `run ${i}: QR ${q.status}`);
      const telur = (await db.query(
        `SELECT oi.order_id FROM order_items oi JOIN order_sends x ON x.id = oi.send_id
          WHERE x.public_ref = $1`, [(await json(q)).ref])).rows;
      assert.equal(telur.length, 1, `run ${i}: the add-on exists exactly once`);
      const fresh = await openOn(db, s.card(n4).id);
      if (telur[0].order_id === c1) {
        seen.add('added first');
        assert.deepEqual(fresh, [], `run ${i}: Card 4 is free`);
        assert.equal((await orderRow(db, c1)).subtotal_cents, 1400);
      } else {
        seen.add('merged first');
        assert.deepEqual(fresh, [telur[0].order_id], `run ${i}: the add-on opened a fresh Card ${n4}`);
        assert.equal((await orderRow(db, c1)).subtotal_cents, 1050);
        await assertBalanced(db, fresh[0], `run ${i} fresh Card ${n4}`);
      }
      assert.equal((await orderRow(db, c4)).status, 'merged');
      await assertBalanced(db, c1, `run ${i} Card 1`);
    }
    await assertMergedEmpty(db, 'after 40 runs');
    assert.deepEqual([...seen].sort(), ['added first', 'merged first']);
  });
});

test('race: 1←4 and 4←1 at the same time — one merge wins, the other is refused, nothing is lost: 40 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const a = await openCard(base, s, 2 * i + 1, one(s.roti));
      const b = await openCard(base, s, 2 * i + 2, one(s.mee));
      const all = [...await lines(db, a), ...await lines(db, b)].sort((x, y) => x - y);
      const [ab, ba] = await race(i, () => merge(base, s, a, b), () => merge(base, s, b, a));
      assert.deepEqual([ab.status, ba.status].sort(), [200, 409], `run ${i}: ${ab.status}/${ba.status}`);
      const [winner, loser] = ab.status === 200 ? [a, b] : [b, a];
      seen.add(winner === a ? '1 took 4' : '4 took 1');
      assert.match((await json(ab.status === 200 ? ba : ab)).error, /^(This bill was combined into Card \d+ — use Card \d+'s bill instead|Card \d+'s bill is already closed)\.$/);
      assert.deepEqual(await lines(db, winner), all, `run ${i}: every line on the bill that stayed`);
      assert.equal((await orderRow(db, loser)).status, 'merged');
      assert.equal((await orderRow(db, loser)).merged_into_order_id, winner);
      await assertBalanced(db, winner, `run ${i}`);
    }
    await assertMergedEmpty(db, 'after 40 runs');
    assert.deepEqual([...seen].sort(), ['1 took 4', '4 took 1']);
  });
});

test('race: Separate Card 4 vs combining Card 7 into Card 1 — both happen, whichever comes first: 40 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    for (let i = 0; i < 40; i++) {
      const c1 = await openCard(base, s, 3 * i + 1, one(s.roti));
      const c4 = await openCard(base, s, 3 * i + 2, one(s.mee));
      const c7 = await openCard(base, s, 3 * i + 3, one(s.telur));
      const l1 = await lines(db, c1), l4 = await lines(db, c4), l7 = await lines(db, c7);
      assert.equal((await merge(base, s, c1, c4)).status, 200);
      const [sep, m] = await race(i, () => separate(base, s, c1, 3 * i + 2), () => merge(base, s, c1, c7));
      assert.equal(sep.status, 200, `run ${i}: separate ${sep.status}`);
      assert.equal(m.status, 200, `run ${i}: merge ${m.status}`);
      const fresh = (await json(sep)).new_order_id;
      assert.deepEqual(await lines(db, fresh), l4, `run ${i}: exactly Card 4's lines went back`);
      assert.deepEqual(await lines(db, c1), [...l1, ...l7].sort((x, y) => x - y), `run ${i}`);
      await assertBalanced(db, c1, `run ${i} Card 1`);
      await assertBalanced(db, fresh, `run ${i} Card 4`);
    }
    await assertMergedEmpty(db, 'after 40 runs');
  });
});

test('race: Separate Card 4 vs combining Card 1 into Card 7 — never splits a bill that has moved on: 40 runs', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    await manyCards(base, s);
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const n4 = 3 * i + 2;
      const c1 = await openCard(base, s, 3 * i + 1, one(s.roti));
      const c4 = await openCard(base, s, n4, one(s.mee));
      const c7 = await openCard(base, s, 3 * i + 3, one(s.telur));
      const l1 = await lines(db, c1), l4 = await lines(db, c4), l7 = await lines(db, c7);
      assert.equal((await merge(base, s, c1, c4)).status, 200);
      const [sep, m] = await race(i, () => separate(base, s, c1, n4), () => merge(base, s, c7, c1));
      assert.equal(m.status, 200, `run ${i}: merge ${m.status}`);
      assert.ok([200, 409].includes(sep.status), `run ${i}: separate ${sep.status}`);
      const sortIds = xs => [...xs].sort((x, y) => x - y);
      if (sep.status === 200) {
        seen.add('separated first');
        assert.deepEqual(await lines(db, (await json(sep)).new_order_id), l4, `run ${i}`);
        assert.deepEqual(await lines(db, c7), sortIds([...l1, ...l7]), `run ${i}`);
      } else {
        seen.add('combined first');
        assert.match((await json(sep)).error, /^This bill was combined into Card \d+ — use Card \d+'s bill instead\.$/);
        assert.deepEqual(await lines(db, c7), sortIds([...l1, ...l4, ...l7]), `run ${i}: everything is on Card 7's bill`);
        assert.deepEqual(await openOn(db, s.card(n4).id), [], `run ${i}: Card 4 stays free`);
        // Card 4's items can still go back — from the bill they are on now.
        assert.equal((await separate(base, s, c7, n4)).status, 200, `run ${i}`);
      }
      assert.equal((await orderRow(db, c1)).status, 'merged');
      await assertBalanced(db, c7, `run ${i} Card 7`);
    }
    await assertMergedEmpty(db, 'after 40 runs');
    assert.deepEqual([...seen].sort(), ['combined first', 'separated first']);
  });
});
