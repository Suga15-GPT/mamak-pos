const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');
const { createPrinter } = require('../../src/lib/escpos');

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

/* ===== row(): the one to get right, it's every line of every receipt ===== */

test('row() pads left+right to exactly width characters, at 42 and 32', () => {
  const p42 = createPrinter(42);
  p42.row('Roti Canai', 'RM 2.00');
  const text42 = p42.toBuffer().toString('latin1');
  assert.equal(text42, 'Roti Canai' + ' '.repeat(25) + 'RM 2.00' + '\n');
  assert.equal(text42.length - 1, 42);

  const p32 = createPrinter(32);
  p32.row('Roti Canai', 'RM 2.00');
  const text32 = p32.toBuffer().toString('latin1');
  assert.equal(text32, 'Roti Canai' + ' '.repeat(15) + 'RM 2.00' + '\n');
  assert.equal(text32.length - 1, 32);
});

test('row() truncates a long left side rather than wrapping into the price column', () => {
  const p = createPrinter(42);
  const longName = 'A'.repeat(60);
  p.row(longName, 'RM 2.00');
  const text = p.toBuffer().toString('latin1');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 1); // never wraps onto a second line
  assert.equal(lines[0].length, 42);
  assert.ok(lines[0].endsWith('RM 2.00'));
  assert.equal(lines[0], 'A'.repeat(34) + ' ' + 'RM 2.00');
});

test('non-ASCII in text() never emits a byte above 0x7F', () => {
  const p = createPrinter(42);
  p.text('Nasi Lémak – "spécial" 你好\n');
  const buf = p.toBuffer();
  for (const byte of buf) assert.ok(byte <= 0x7f, `byte ${byte} exceeds 0x7F`);
});

test('cut() emits exactly the GS V 66 0 sequence', () => {
  const p = createPrinter(42);
  p.cut();
  assert.deepEqual([...p.toBuffer()], [0x1d, 0x56, 0x42, 0x00]);
});

/* ===== printing.js: templates + dispatch, over a live app ===== */

test('a receipt\'s bytes contain the correct total and end with the cut sequence', async () => {
  await withDb(async db => {
    const base = await startApp();
    const adminToken = await login(base, 'Admin', '1234');
    // Phase 09: a payment is refused unless a shift is open.
    await fetch(`${base}/api/shift/open`, { method: 'POST', headers: auth(adminToken), body: JSON.stringify({ float: 0 }) });
    const menu = await json(await fetch(`${base}/api/menu`, { headers: auth(adminToken) }));
    const tables = await json(await fetch(`${base}/api/tables`, { headers: auth(adminToken) }));
    const item = menu.items.find(i => i.name === 'Roti Canai');

    const created = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: auth(adminToken),
      body: JSON.stringify({ table_id: tables[0].id, items: [{ item_id: item.id, qty: 1 }] }),
    }));
    const pay = await json(await fetch(`${base}/api/orders/${created.id}/pay`, {
      method: 'POST', headers: auth(adminToken), body: JSON.stringify({ method: 'Cash' }),
    }));

    const { buildReceipt } = require('../../src/services/printing');
    const payload = await buildReceipt(created.id, 42);
    const text = payload.toString('latin1');

    assert.ok(text.includes(`RM ${pay.bill.total.toFixed(2)}`), `receipt should contain the total ${pay.bill.total}`);
    assert.deepEqual([...payload.slice(-4)], [0x1d, 0x56, 0x42, 0x00]);
  });
});

test('enqueue with no printer configured -> job recorded failed, order unaffected', async () => {
  await withDb(async db => {
    const base = await startApp();
    const adminToken = await login(base, 'Admin', '1234');
    const menu = await json(await fetch(`${base}/api/menu`, { headers: auth(adminToken) }));
    const tables = await json(await fetch(`${base}/api/tables`, { headers: auth(adminToken) }));
    const item = menu.items.find(i => i.name === 'Roti Canai');

    // No row in `printers` at all. routes/orders.js's create handler calls
    // printing.enqueue('chit', id) itself (Do #5) — this exercises that real
    // wiring end to end, rather than calling enqueue() a second time and
    // double-counting jobs: creating the order must still succeed (enqueue
    // must not throw or block it) and the resulting job must be recorded
    // failed rather than silently dropped.
    const r = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: auth(adminToken),
      body: JSON.stringify({ table_id: tables[0].id, items: [{ item_id: item.id, qty: 1 }] }),
    });
    assert.equal(r.status, 201);
    const created = await json(r);

    const jobs = await db.query('SELECT * FROM print_jobs WHERE order_id = $1', [created.id]);
    assert.equal(jobs.rows.length, 1);
    assert.equal(jobs.rows[0].status, 'failed');
    assert.equal(jobs.rows[0].printer_id, null);
    assert.ok(jobs.rows[0].last_error);

    const order = await db.query('SELECT status FROM orders WHERE id = $1', [created.id]);
    assert.equal(order.rows[0].status, 'sent');
  });
});
