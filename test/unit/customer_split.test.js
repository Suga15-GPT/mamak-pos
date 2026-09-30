const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const { startApp, setup, post, json, openCard, one } = require('../apphelper');

/* "Split the bill" on the customer's phone: the arithmetic always adds up to
   exactly what is left to pay, and the card's own QR gives the page what it
   needs (prices, the breakdown, what is paid) — and nothing more. */

const load = () => import(path.join(__dirname, '..', '..', 'public', 'customer', 'split-math.js'));

test('an even split adds up to the sen, and the first shares carry the spare sen', async () => {
  const { splitEvenCents } = await load();
  assert.deepEqual(splitEvenCents(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitEvenCents(1001, 2), [501, 500]);
  for (let cents = 0; cents < 3000; cents += 37) {
    for (let n = 1; n <= 12; n++) {
      const s = splitEvenCents(cents, n);
      assert.equal(s.reduce((a, b) => a + b, 0), cents);
      assert.ok(Math.max(...s) - Math.min(...s) <= 1);
    }
  }
});

test('split by items: shares follow what each person had, shared dishes divide, SST follows the food, the total is exact', async () => {
  const { splitByItems } = await load();
  // RM 2.00 roti, RM 8.50 mee, RM 3.00 teh shared; SST 6% → 14.31 total.
  const bill = { total: 14.31, due: 14.31, paid: 0, lines: [
    { id: 1, name: 'Roti Canai', qty: 1, amount: 2.00, paid: false },
    { id: 2, name: 'Mee Goreng', qty: 1, amount: 8.50, paid: false },
    { id: 3, name: 'Teh Tarik', qty: 2, amount: 3.00, paid: false },
  ] };
  const r = splitByItems(bill, ['Ali', 'Siti'], { 1: ['Ali'], 2: ['Siti'], 3: ['Ali', 'Siti'] });
  const byName = Object.fromEntries(r.people.map(p => [p.name, p.cents]));
  // Ali had 2.00 + 1.50 = 3.50 of 13.50; Siti 8.50 + 1.50 = 10.00.
  assert.equal(byName.Ali + byName.Siti, 1431);
  assert.equal(byName.Ali, Math.round(1431 * 350 / 1350));
  assert.equal(r.unclaimed_cents, 0);
  assert.deepEqual(r.people[0].dishes, ['1× Roti Canai', '2× Teh Tarik (shared ÷2)']);

  // Something nobody has claimed yet is shown, and still everything adds up.
  const partial = splitByItems(bill, ['Ali'], { 1: ['Ali'] });
  assert.equal(partial.people[0].cents + partial.unclaimed_cents, 1431);
  assert.equal(partial.unclaimed_lines.length, 2);

  // Lines already paid at the till drop out; what is left is split.
  const later = { ...bill, due: 6.36, paid: 7.95, lines: bill.lines.map(l => (l.id === 2 ? { ...l, paid: true } : l)) };
  const r2 = splitByItems(later, ['Ali', 'Siti'], { 1: ['Ali'], 3: ['Siti'] });
  assert.equal(r2.people[0].cents + r2.people[1].cents, 636);

  // Fuzz: any bill, any assignment, the parts sum to what is due.
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 500; run++) {
    const lines = Array.from({ length: 1 + rnd(8) }, (_, i) => ({ id: i + 1, name: `D${i}`, qty: 1, amount: (50 + rnd(3000)) / 100, paid: rnd(10) === 0 }));
    const due = (100 + rnd(20000)) / 100;
    const people = ['A', 'B', 'C', 'D'].slice(0, 1 + rnd(4));
    const assigned = Object.fromEntries(lines.map(l => [l.id, people.filter(() => rnd(3) === 0)]));
    const res = splitByItems({ due, lines }, people, assigned);
    assert.equal(res.people.reduce((t, p) => t + p.cents, 0) + res.unclaimed_cents, Math.round(due * 100), `run ${run}`);
  }
});

test('a card\'s own QR shows prices, the breakdown and what is left to pay — and no staff detail', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const id = await openCard(base, s, 3, [{ item_id: s.roti.id, qty: 2 }, { item_id: s.mee.id, qty: 1 }]);
    const token = (await db.query('SELECT qr_token FROM cards WHERE number = 3')).rows[0].qr_token;
    const view = async () => (await json(await fetch(`${base}/api/t/${token}`))).bill;
    const b = await view();
    assert.deepEqual(b.lines.map(l => [l.qty, l.name, l.amount, l.paid]), [[2, 'Roti Canai', 4, false], [1, 'Mee Goreng Mamak', 8.5, false]]);
    assert.equal(b.subtotal, 12.5);
    assert.equal(b.tax, 0.75);
    assert.equal(b.total, 13.25);
    assert.equal(b.paid, 0);
    assert.equal(b.due, 13.25);
    for (const l of b.lines) assert.deepEqual(Object.keys(l).sort(), ['amount', 'from_card', 'id', 'name', 'options', 'paid', 'qty', 'status']);

    // A share paid at the till for the roti shows as paid, and "left to pay" drops.
    const roti = b.lines.find(l => l.name === 'Roti Canai').id;
    const share = await json(await fetch(`${base}/api/orders/${id}/split?by=items&items=${roti}`, { headers: s.h }));
    assert.equal((await post(base, s, `/api/orders/${id}/pay`, { method: 'Card', item_ids: [roti], amount: share.amount })).status, 200);
    const after = await view();
    assert.equal(after.lines.find(l => l.id === roti).paid, true);
    assert.equal(after.paid, share.amount);
    assert.equal(after.due, Math.round((13.25 - share.amount) * 100) / 100);
  });
});
