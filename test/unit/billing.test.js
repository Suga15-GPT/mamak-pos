const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');
const { splitEvenly } = require('../../src/services/billing');
const { rm2cents, roundHalfUp, cents2rm } = require('../../src/lib/money');

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

async function json(res) { return res.json(); }
// Phase 11: sessions are an httpOnly cookie, not a bearer token — node's
// fetch happily sends a manually-set Cookie header (it isn't a browser
// sandbox), so tests carry the session by hand instead of a cookie jar.
async function login(base, name, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin }),
  });
  const body = await json(r);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrfToken: body.csrf_token };
}
function auth(session) {
  return { cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
}

async function setup(base) {
  const adminToken = await login(base, 'Admin', '1234');
  const adminAuth = auth(adminToken);
  // Phase 09: a payment is refused unless a shift is open.
  await fetch(`${base}/api/shift/open`, { method: 'POST', headers: adminAuth, body: JSON.stringify({ float: 0 }) });
  // '1111' would fail the phase-11 PIN policy (all-same digit) — this passes it.
  const staffId = (await json(await fetch(`${base}/api/admin/users`, {
    method: 'POST', headers: adminAuth, body: JSON.stringify({ name: 'Staffer', role: 'staff', pin: '6284' }),
  }))).id;
  const staffToken = await login(base, 'Staffer', '6284');
  // A brand-new account starts with must_change_pin — clear it so the many
  // tests below exercise their own scenario, not that gate.
  await fetch(`${base}/api/me/pin`, {
    method: 'POST', headers: auth(staffToken), body: JSON.stringify({ current_pin: '6284', new_pin: '4816' }),
  });
  const menu = await json(await fetch(`${base}/api/menu`, { headers: adminAuth }));
  const tables = await json(await fetch(`${base}/api/tables`, { headers: adminAuth }));
  return {
    adminAuth, staffAuth: auth(staffToken), staffId,
    tableId: tables[0].id, tableId2: tables[1].id, tableId3: tables[2].id,
    itemA: menu.items.find(i => i.name === 'Roti Canai'),
    itemB: menu.items.find(i => i.name === 'Teh Tarik'),
  };
}

async function createOrder(base, s, tableId, itemId, qty = 1) {
  const r = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: s.staffAuth,
    body: JSON.stringify({ table_id: tableId, items: [{ item_id: itemId, qty }] }),
  });
  return { status: r.status, body: await json(r) };
}

/* ===== splitEvenly: pure function ===== */

test('splitEvenly divides, floors, and distributes the remainder — never loses or invents a sen', () => {
  const s3 = splitEvenly(1000, 3);
  assert.deepEqual(s3, [334, 333, 333]);
  assert.equal(s3.reduce((a, b) => a + b, 0), 1000);

  const s7 = splitEvenly(1000, 7);
  assert.deepEqual(s7, [143, 143, 143, 143, 143, 143, 142]);
  assert.equal(s7.reduce((a, b) => a + b, 0), 1000);

  const s6 = splitEvenly(1000, 6);
  assert.deepEqual(s6, [167, 167, 167, 167, 166, 166]);
  assert.equal(s6.reduce((a, b) => a + b, 0), 1000);
});

/* ===== integration ===== */

test('two partial payments settling exactly -> order becomes paid, amountDue 0', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 3); // subtotal 600, tax 600bp -> 36, total 636

    const total = (await db.query('SELECT total_cents FROM orders WHERE id = $1', [orderId])).rows[0].total_cents;
    const half1 = Math.floor(total / 2);
    const half2 = total - half1;

    const r1 = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: half1 / 100 }),
    });
    assert.equal(r1.status, 200);
    const b1 = await json(r1);
    assert.equal(b1.settled, false);
    assert.equal(b1.remaining, half2 / 100);

    const r2 = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: half2 / 100 }),
    });
    assert.equal(r2.status, 200);
    const b2 = await json(r2);
    assert.equal(b2.settled, true);
    assert.equal(b2.remaining, 0);

    const row = (await db.query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'paid');
  });
});

test('payment exceeding due by cash -> change due correct; by card -> 400', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);

    // Cash: tender RM20 against a RM6.36 (unrounded) / RM6.35 (cash-rounded) due.
    const { body: { id: cashOrder } } = await createOrder(base, s, s.tableId, s.itemA.id, 3);
    const rCash = await fetch(`${base}/api/orders/${cashOrder}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Cash', tendered: 20 }),
    });
    assert.equal(rCash.status, 200);
    const bCash = await json(rCash);
    assert.equal(bCash.settled, true);
    assert.equal(bCash.bill.total, 6.35);
    assert.equal(bCash.change, 13.65);

    // Card: requesting to apply more than the due amount is rejected outright — a
    // card terminal can't "overpay" the way handing over cash notes can.
    const { body: { id: cardOrder } } = await createOrder(base, s, s.tableId2, s.itemA.id, 1); // total 2.12
    const rCard = await fetch(`${base}/api/orders/${cardOrder}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: 10 }),
    });
    assert.equal(rCard.status, 400);
  });
});

test('adding a line to an order with a payment -> 409', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 1);

    const partial = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: 1 }),
    });
    assert.equal(partial.status, 200);
    assert.equal((await json(partial)).settled, false);

    const append = await fetch(`${base}/api/orders/${orderId}/items`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ items: [{ item_id: s.itemA.id, qty: 1 }] }),
    });
    assert.equal(append.status, 409);
  });
});

test('percent discount 10% on RM 20.00 -> 200 cents off; tax still computed per §3', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 10); // subtotal 2000

    const r = await fetch(`${base}/api/orders/${orderId}/discounts`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'percent', value: 10, reason: 'loyalty promo' }),
    });
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.equal(body.amount, 2.00); // 10% of RM20.00 subtotal

    const row = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.subtotal_cents, 2000);
    assert.equal(row.tax_cents, 120); // 6% of the undiscounted 2000, not of 1800
    assert.equal(row.discount_cents, 200);
    assert.equal(row.subtotal_cents + row.service_charge_cents + row.tax_cents - row.discount_cents, row.total_cents);
  });
});

test('comp -> total 0, order closes with no payment row required, audit row written', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 1);

    const r = await fetch(`${base}/api/orders/${orderId}/discounts`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'comp', value: 0, reason: 'burnt order, manager comp' }),
    });
    assert.equal(r.status, 200);

    const row = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'paid');
    assert.equal(row.total_cents, 0);

    // payments.amount_cents has a CHECK (amount_cents > 0), so a comp that zeroes
    // the balance closes the order without ever needing a payment row.
    const payments = await db.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    assert.equal(payments.rows.length, 0);

    const audit = await db.query("SELECT * FROM audit_log WHERE action = 'discount.apply' AND entity_id = $1", [orderId]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].detail.kind, 'comp');
  });
});

/* ===== void/discount vs. a partial payment (phase 05b item 1) =====
   hasPayments() already guarded appending a line; it was never applied to void
   or discount, so either could leave the shop owing the customer money. */

test('a void that would drop the total below what is already paid -> 409, nothing changes', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    // 10 x Roti Canai: subtotal 2000, 6% tax -> 120, total 2120 (RM21.20) — the
    // exact reproduction from the phase prompt.
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 10);
    const lineId = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth })))
      .find(o => o.id === orderId).items[0].id;

    const pay = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: 15 }),
    });
    assert.equal(pay.status, 200);
    assert.equal((await json(pay)).settled, false);

    const voided = await fetch(`${base}/api/orders/${orderId}/items/${lineId}/void`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ reason: 'customer sent it back' }),
    });
    assert.equal(voided.status, 409);
    assert.match((await json(voided)).error, /RM 15\.00/);

    const line = (await db.query('SELECT voided_at FROM order_items WHERE id = $1', [lineId])).rows[0];
    assert.equal(line.voided_at, null, 'the line is still un-voided');
    const row = (await db.query('SELECT status, total_cents FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.total_cents, 2120, 'total is unchanged');
  });
});

test('a void that lands the total exactly on what is already paid -> order settles, amount_due 0', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    const created = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.staffAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.itemA.id, qty: 1 }, { item_id: s.itemB.id, qty: 1 }] }),
    });
    const { id: orderId } = await json(created);
    const lineA = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth })))
      .find(o => o.id === orderId).items.find(i => i.name === s.itemA.name);

    // What the order's total will become once lineA is voided — item B alone,
    // taxed the same way computeBill/recomputeOrderBill would.
    const subtotalB = rm2cents(s.itemB.price);
    const totalB = subtotalB + roundHalfUp(subtotalB * 600 / 10000);

    const pay = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: totalB / 100 }),
    });
    assert.equal(pay.status, 200);
    assert.equal((await json(pay)).settled, false);

    const voided = await fetch(`${base}/api/orders/${orderId}/items/${lineA.id}/void`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ reason: 'kitchen mistake' }),
    });
    assert.equal(voided.status, 200);

    const row = (await db.query('SELECT status, total_cents FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'paid');
    assert.equal(row.total_cents, totalB);

    const settleAudit = await db.query("SELECT * FROM audit_log WHERE action = 'order.settle' AND entity_id = $1", [orderId]);
    assert.equal(settleAudit.rows.length, 1);
    assert.equal(settleAudit.rows[0].detail.trigger, 'void');
  });
});

test('a void that leaves the total above what is already paid -> allowed, correct remaining balance', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    const created = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.staffAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.itemA.id, qty: 1 }, { item_id: s.itemB.id, qty: 1 }] }),
    });
    const { id: orderId } = await json(created);
    const lineA = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth })))
      .find(o => o.id === orderId).items.find(i => i.name === s.itemA.name);

    const pay = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: 0.5 }),
    });
    assert.equal(pay.status, 200);

    const voided = await fetch(`${base}/api/orders/${orderId}/items/${lineA.id}/void`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ reason: 'wrong item' }),
    });
    assert.equal(voided.status, 200);

    const subtotalB = rm2cents(s.itemB.price);
    const totalB = subtotalB + roundHalfUp(subtotalB * 600 / 10000);

    const row = (await db.query('SELECT status, total_cents FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.total_cents, totalB);

    const after = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === orderId);
    assert.equal(after.amount_due, cents2rm(totalB - 50));
  });
});

test('a discount that would drop the total below what is already paid -> 409, nothing changes', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 10); // total 2120

    const pay = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: 15 }),
    });
    assert.equal(pay.status, 200);
    assert.equal((await json(pay)).settled, false);

    const discounted = await fetch(`${base}/api/orders/${orderId}/discounts`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'comp', value: 0, reason: 'manager comp attempt' }),
    });
    assert.equal(discounted.status, 409);
    assert.match((await json(discounted)).error, /RM 15\.00/);

    const discRows = await db.query('SELECT * FROM discounts WHERE order_id = $1', [orderId]);
    assert.equal(discRows.rows.length, 0, 'no discount row was written');
    const row = (await db.query('SELECT status, total_cents FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.total_cents, 2120, 'total is unchanged');
  });
});

test('a discount that lands the total exactly on what is already paid -> order settles', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);

    const created = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: s.staffAuth,
      body: JSON.stringify({ table_id: s.tableId, items: [{ item_id: s.itemA.id, qty: 1 }, { item_id: s.itemB.id, qty: 1 }] }),
    });
    const { id: orderId } = await json(created);

    const before = (await db.query('SELECT total_cents FROM orders WHERE id = $1', [orderId])).rows[0].total_cents;
    const subtotalB = rm2cents(s.itemB.price);
    const totalB = subtotalB + roundHalfUp(subtotalB * 600 / 10000);
    const diffCents = before - totalB; // roughly item A's own contribution to the combined total

    const pay = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: totalB / 100 }),
    });
    assert.equal(pay.status, 200);
    assert.equal((await json(pay)).settled, false);

    // 'amount' discounts subtract straight from gross, so this lands the new
    // total exactly on totalB — what was just paid.
    const discounted = await fetch(`${base}/api/orders/${orderId}/discounts`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'amount', value: diffCents / 100, reason: 'goodwill discount' }),
    });
    assert.equal(discounted.status, 200);

    const row = (await db.query('SELECT status, total_cents FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'paid');
    assert.equal(row.total_cents, totalB);

    const settleAudit = await db.query("SELECT * FROM audit_log WHERE action = 'order.settle' AND entity_id = $1", [orderId]);
    assert.equal(settleAudit.rows.length, 1);
    assert.equal(settleAudit.rows[0].detail.trigger, 'discount');
  });
});

test('a discount that leaves the total above what is already paid -> allowed, correct remaining balance', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 10); // total 2120

    const pay = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card', amount: 0.5 }),
    });
    assert.equal(pay.status, 200);

    // 5% off a 2000-cent subtotal -> 100 cents off, well short of zeroing the bill.
    const discounted = await fetch(`${base}/api/orders/${orderId}/discounts`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'percent', value: 5, reason: 'small loyalty discount' }),
    });
    assert.equal(discounted.status, 200);

    const row = (await db.query('SELECT status, total_cents FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal(row.total_cents, 2020); // 2120 - 100

    const after = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === orderId);
    assert.equal(after.amount_due, cents2rm(2020 - 50));
  });
});

/* ===== refunds (phase 12, audit #39) ===== */

test('refund exceeding its payment -> 400', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 1);
    const payR = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Cash' }),
    });
    assert.equal(payR.status, 200);
    const order = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === orderId);
    const paymentId = order.payments[0].id;

    const over = await fetch(`${base}/api/orders/${orderId}/refunds`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ payment_id: paymentId, amount: 999, reason: 'too much' }),
    });
    assert.equal(over.status, 400);
  });
});

test('a cash refund reduces expected cash by exactly its amount; a card refund does not', async () => {
  await withDb(async () => {
    const base = await startApp();
    const s = await setup(base);
    const shift = await json(await fetch(`${base}/api/shift/current`, { headers: s.adminAuth }));

    const { body: { id: cashOrder } } = await createOrder(base, s, s.tableId, s.itemA.id, 1);
    await fetch(`${base}/api/orders/${cashOrder}/pay`, { method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Cash' }) });
    const cashPaymentId = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth })))
      .find(o => o.id === cashOrder).payments[0].id;

    const repBeforeCash = await json(await fetch(`${base}/api/shift/${shift.id}/report`, { headers: s.adminAuth }));
    const cashRefund = await fetch(`${base}/api/orders/${cashOrder}/refunds`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ payment_id: cashPaymentId, amount: 1, reason: 'goodwill refund' }),
    });
    assert.equal(cashRefund.status, 200);
    const repAfterCash = await json(await fetch(`${base}/api/shift/${shift.id}/report`, { headers: s.adminAuth }));
    assert.equal(repBeforeCash.cash.expected_cents - repAfterCash.cash.expected_cents, 100);

    const { body: { id: cardOrder } } = await createOrder(base, s, s.tableId2, s.itemA.id, 1);
    await fetch(`${base}/api/orders/${cardOrder}/pay`, { method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card' }) });
    const cardPaymentId = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth })))
      .find(o => o.id === cardOrder).payments[0].id;

    const repBeforeCard = await json(await fetch(`${base}/api/shift/${shift.id}/report`, { headers: s.adminAuth }));
    const cardRefund = await fetch(`${base}/api/orders/${cardOrder}/refunds`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ payment_id: cardPaymentId, amount: 1, reason: 'card refund' }),
    });
    assert.equal(cardRefund.status, 200);
    const repAfterCard = await json(await fetch(`${base}/api/shift/${shift.id}/report`, { headers: s.adminAuth }));
    assert.equal(repBeforeCard.cash.expected_cents, repAfterCard.cash.expected_cents);
  });
});

test('two partial refunds summing to the payment -> allowed; a third cent -> 400', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 1);
    await fetch(`${base}/api/orders/${orderId}/pay`, { method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card' }) });
    const order = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === orderId);
    const paymentId = order.payments[0].id;
    const totalCents = Math.round(order.payments[0].amount * 100);
    const half1 = Math.floor(totalCents / 2), half2 = totalCents - half1;

    const r1 = await fetch(`${base}/api/orders/${orderId}/refunds`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ payment_id: paymentId, amount: half1 / 100, reason: 'partial refund 1' }),
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${base}/api/orders/${orderId}/refunds`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ payment_id: paymentId, amount: half2 / 100, reason: 'partial refund 2' }),
    });
    assert.equal(r2.status, 200);
    assert.equal((await json(r2)).refunded_to_zero, true);

    const row = (await db.query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.status, 'refunded');

    const r3 = await fetch(`${base}/api/orders/${orderId}/refunds`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ payment_id: paymentId, amount: 0.01, reason: 'one more cent' }),
    });
    assert.equal(r3.status, 400);
  });
});

test('concurrent double-refund of the same payment does not over-refund', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 1);
    await fetch(`${base}/api/orders/${orderId}/pay`, { method: 'POST', headers: s.staffAuth, body: JSON.stringify({ method: 'Card' }) });
    const order = (await json(await fetch(`${base}/api/orders?mode=recent`, { headers: s.staffAuth }))).find(o => o.id === orderId);
    const paymentId = order.payments[0].id;
    const totalCents = Math.round(order.payments[0].amount * 100);

    // Two concurrent requests both trying to refund the full amount against
    // the same payment — exactly one may succeed; a read-then-write guard
    // would let both through.
    const [a, b] = await Promise.all([
      fetch(`${base}/api/orders/${orderId}/refunds`, {
        method: 'POST', headers: s.adminAuth, body: JSON.stringify({ payment_id: paymentId, amount: totalCents / 100, reason: 'race A' }),
      }),
      fetch(`${base}/api/orders/${orderId}/refunds`, {
        method: 'POST', headers: s.adminAuth, body: JSON.stringify({ payment_id: paymentId, amount: totalCents / 100, reason: 'race B' }),
      }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400]);

    const refunded = await db.query('SELECT COALESCE(SUM(amount_cents), 0)::int s FROM refunds WHERE payment_id = $1', [paymentId]);
    assert.equal(refunded.rows[0].s, totalCents);
  });
});

test('admin removes a discount before any payment -> total reverts, audit row written', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const { body: { id: orderId } } = await createOrder(base, s, s.tableId, s.itemA.id, 10); // total 2120

    const discounted = await fetch(`${base}/api/orders/${orderId}/discounts`, {
      method: 'POST', headers: s.adminAuth, body: JSON.stringify({ kind: 'percent', value: 10, reason: 'test discount' }),
    });
    assert.equal(discounted.status, 200);
    const { id: discountId } = await json(discounted);

    const removed = await fetch(`${base}/api/orders/${orderId}/discounts/${discountId}`, {
      method: 'DELETE', headers: s.adminAuth,
    });
    assert.equal(removed.status, 200);

    const row = (await db.query('SELECT total_cents, discount_cents FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(row.discount_cents, 0);
    assert.equal(row.total_cents, 2120);

    const audit = await db.query("SELECT * FROM audit_log WHERE action = 'discount.remove' AND entity_id = $1", [orderId]);
    assert.equal(audit.rows.length, 1);
  });
});
