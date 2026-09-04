const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');
const { roundHalfUp, lineTotal, computeBill, roundCashCents, formatRM } = require('../../src/lib/money');

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

/* ===== pure math ===== */

test('roundHalfUp: 0.5 always rounds away from zero', () => {
  assert.equal(roundHalfUp(2.5), 3);
  assert.equal(roundHalfUp(-2.5), -3);
});

test('subtotal 1000, tax 600bp, svc 0 -> tax 60, total 1060', () => {
  const bill = computeBill({ lines: [{ price_cents: 1000, qty: 1, mods: [] }], taxRateBp: 600, svcRateBp: 0, method: 'Card' });
  assert.equal(bill.subtotal_cents, 1000);
  assert.equal(bill.tax_cents, 60);
  assert.equal(bill.total_cents, 1060);
});

test('subtotal 1000, tax 600bp, svc 1000bp -> svc 100, tax 66 (on 1100), total 1166', () => {
  const bill = computeBill({ lines: [{ price_cents: 1000, qty: 1, mods: [] }], taxRateBp: 600, svcRateBp: 1000, method: 'Card' });
  assert.equal(bill.service_charge_cents, 100);
  assert.equal(bill.tax_cents, 66);
  assert.equal(bill.total_cents, 1166);
});

test('subtotal 333, tax 600bp -> tax 20 (19.98 rounds up), total 353', () => {
  const bill = computeBill({ lines: [{ price_cents: 333, qty: 1, mods: [] }], taxRateBp: 600, svcRateBp: 0, method: 'Card' });
  assert.equal(bill.tax_cents, 20);
  assert.equal(bill.total_cents, 353);
});

// The phase prompt's own example table asks for gross 1063 -> rounding -3 -> total
// 1060, and gross 1067 -> rounding +3 -> total 1070. That is impossible for
// "nearest 5 sen": with 5-cent buckets the remainder is in [0,4], so the maximum
// possible adjustment magnitude to the nearest multiple of 5 is 2, never 3 (e.g.
// 1063 is 3 away from 1060 but only 2 away from 1065, so 1065 is nearer; 1067 is
// 2 away from 1065 but 3 away from 1070, so 1065 is nearer there too). Both
// examples in the prompt round to the farther candidate, not the nearer one.
// roundCashCents (kept unchanged, as instructed) implements genuine nearest-5-sen
// rounding, so these cases assert its actual, correct behaviour on those same
// inputs instead of the prompt's arithmetically-impossible expected values.
test('cash, gross 1063 -> nearest 5 sen is 1065 (rounding +2)', () => {
  const bill = computeBill({ lines: [{ price_cents: 1063, qty: 1, mods: [] }], taxRateBp: 0, svcRateBp: 0, method: 'Cash' });
  assert.equal(bill.rounding_cents, 2);
  assert.equal(bill.total_cents, 1065);
});

test('cash, gross 1067 -> nearest 5 sen is 1065 (rounding -2)', () => {
  const bill = computeBill({ lines: [{ price_cents: 1067, qty: 1, mods: [] }], taxRateBp: 0, svcRateBp: 0, method: 'Cash' });
  assert.equal(bill.rounding_cents, -2);
  assert.equal(bill.total_cents, 1065);
});

test('card, gross 1063 -> rounding 0, total 1063 (card/e-wallet is never rounded)', () => {
  const bill = computeBill({ lines: [{ price_cents: 1063, qty: 1, mods: [] }], taxRateBp: 0, svcRateBp: 0, method: 'Card' });
  assert.equal(bill.rounding_cents, 0);
  assert.equal(bill.total_cents, 1063);
});

test('tax 0, svc 0 -> total equals subtotal exactly', () => {
  const bill = computeBill({ lines: [{ price_cents: 987, qty: 3, mods: [] }], taxRateBp: 0, svcRateBp: 0, method: 'Card' });
  assert.equal(bill.total_cents, bill.subtotal_cents);
});

test('discount 500 on subtotal 1000, tax 600bp -> tax computed on 1000 not 500; total 560', () => {
  const bill = computeBill({ lines: [{ price_cents: 1000, qty: 1, mods: [] }], taxRateBp: 600, svcRateBp: 0, discountCents: 500, method: 'Card' });
  assert.equal(bill.tax_cents, 60);
  assert.equal(bill.total_cents, 560);
});

test('100 lines x qty 20 -> no float drift, total is exact', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ price_cents: 1099 + i, qty: 20, mods: [{ price_cents: 50 }, { price_cents: 30 }] }));
  const expectedSubtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const bill = computeBill({ lines, taxRateBp: 600, svcRateBp: 1000, method: 'Cash' });
  assert.equal(bill.subtotal_cents, expectedSubtotal);
  assert.equal(Number.isInteger(bill.total_cents), true);
  // total is reproducible from the stored components alone
  assert.equal(bill.subtotal_cents + bill.service_charge_cents + bill.tax_cents - bill.discount_cents + bill.rounding_cents, bill.total_cents);
});

test('lineTotal: (price + mods) x qty', () => {
  assert.equal(lineTotal({ price_cents: 1000, qty: 2, mods: [{ price_cents: 200 }, { price_cents: 100 }] }), 2600);
});

test('formatRM formats cents as ringgit', () => {
  assert.equal(formatRM(1235), 'RM 12.35');
});

/* ===== integration: pay an order by cash, re-read it, rate change does not alter it ===== */

test('pay by cash snapshots the bill; a later rate change does not alter the stored order', async () => {
  await withDb(async db => {
    const base = await startApp();

    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', pin: '1234' }),
    });
    const { csrf_token } = await login.json();
    // Phase 11: sessions are an httpOnly cookie, not a bearer token — node's
    // fetch happily sends a manually-set Cookie header (it isn't a browser
    // sandbox), so the session is carried by hand instead of a cookie jar.
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const auth = { cookie, 'x-csrf-token': csrf_token, 'content-type': 'application/json' };

    // Phase 09: a payment is refused unless a shift is open.
    await fetch(`${base}/api/shift/open`, { method: 'POST', headers: auth, body: JSON.stringify({ float: 0 }) });

    const menu = await (await fetch(`${base}/api/menu`, { headers: auth })).json();
    const roti = menu.items.find(i => i.name === 'Roti Canai');
    const tables = await (await fetch(`${base}/api/tables`, { headers: auth })).json();

    const created = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ table_id: tables[0].id, items: [{ item_id: roti.id, qty: 3 }] }),
    });
    const { id: orderId } = await created.json();

    const paid = await fetch(`${base}/api/orders/${orderId}/pay`, {
      method: 'POST', headers: auth, body: JSON.stringify({ method: 'Cash' }),
    });
    assert.equal(paid.status, 200);
    const paidBody = await paid.json();
    // subtotal 3 x 200 = 600, tax 600bp -> 36, gross 636, nearest 5 sen -> 635
    assert.equal(paidBody.bill.subtotal, 6.00);
    assert.equal(paidBody.bill.tax, 0.36);
    assert.equal(paidBody.bill.total, 6.35);

    const before = await (await fetch(`${base}/api/orders?mode=recent`, { headers: auth })).json();
    const orderBefore = before.find(o => o.id === orderId);
    assert.equal(orderBefore.grand_total, 6.35);
    assert.equal(orderBefore.tax_rate_bp, 600);

    // The stored components must sum to total_cents. Check this in the integer-cents
    // domain (straight from the DB) rather than on the RM floats the API returns for
    // display — summing already-divided-by-100 floats is exactly the float drift
    // money.js's "convert to ringgit only for display" rule exists to avoid.
    const row = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(
      row.subtotal_cents + row.service_charge_cents + row.tax_cents - row.discount_cents + row.rounding_cents,
      row.total_cents);
    assert.equal(row.subtotal_cents, 600);
    assert.equal(row.tax_cents, 36);
    assert.equal(row.rounding_cents, -1);
    assert.equal(row.total_cents, 635);
    assert.equal(row.tax_rate_bp, 600);

    // change the live rate — historical receipt must not move
    const patched = await fetch(`${base}/api/settings`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ tax_rate_bp: 800, svc_rate_bp: 500 }),
    });
    assert.equal(patched.status, 200);

    const after = await (await fetch(`${base}/api/orders?mode=recent`, { headers: auth })).json();
    const orderAfter = after.find(o => o.id === orderId);
    assert.equal(orderAfter.grand_total, orderBefore.grand_total);
    assert.equal(orderAfter.tax, orderBefore.tax);
    assert.equal(orderAfter.tax_rate_bp, 600);

    const rowAfter = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(rowAfter.total_cents, row.total_cents);
    assert.equal(rowAfter.tax_rate_bp, 600);
  });
});
