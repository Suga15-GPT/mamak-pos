const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');
const { startApp, setup, post, get, json, openCard, one, orderRow } = require('../apphelper');

/* Review follow-ups after PR #19: N2 (tills reload themselves after an
   update), N3 (a combined bill from before pays only the total shown), N4
   (tests leave no archive schema behind). N1 and the stale pay button are
   the till's own — see the Playwright journeys. */

const ROOT = path.join(__dirname, '..', '..');

test('N2: the server says which build it serves, and names the offline cache after it', async () => {
  await withDb(async () => {
    const base = await startApp();
    const v = await (await fetch(`${base}/api/version`)).json();
    assert.match(v.version, /^[0-9a-f]{12}$/);
    const sw = await (await fetch(`${base}/sw.js`)).text();
    assert.match(sw, new RegExp(`const CACHE_VERSION = 'v\\d+-${v.version}';`));
    assert.match(sw, /'\/js\/version\.js'/, 'the checker is part of the offline shell');
    const page = await (await fetch(`${base}/index.html`)).text();
    assert.ok(page.includes(`<meta name="app-version" content="${v.version}">`), 'the page knows its own build');
  });
  const main = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
  assert.match(main, /startVersionCheck\(\)/);
});

test('N3: a combined bill from before is refused (409) when it grew after its total was shown, and pays at the total shown', async () => {
  await withDb(async db => {
    const base = await startApp();
    const s = await setup(base);
    const a = await openCard(base, s, 1, one(s.roti));
    const b = await openCard(base, s, 2, one(s.roti));
    const g = await json(await post(base, s, '/api/bill-groups', { order_ids: [a, b] }));
    const shown = g.amount_due;
    assert.equal((await post(base, s, `/api/orders/${a}/items`, { items: one(s.teh) })).status, 200);
    const stale = await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: shown }], expected_due: shown });
    assert.equal(stale.status, 409);
    assert.match((await json(stale)).error, /^The bill has changed/);
    assert.equal((await db.query('SELECT count(*)::int n FROM payments')).rows[0].n, 0);
    const now = (await get(base, s, `/api/bill-groups/${g.id}`)).amount_due;
    const ok = await post(base, s, `/api/bill-groups/${g.id}/pay`, { legs: [{ method: 'Card', amount: now }], expected_due: now });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal((await orderRow(db, a)).status, 'paid');
  });
});

test('N4: a test that clears sales leaves no archive schema behind', async () => {
  let schema;
  await withDb(async db => {
    schema = (await db.query('SELECT current_schema() s')).rows[0].s;
    const base = await startApp();
    const s = await setup(base, { shift: false });
    // Something to clear: a bill paid with shifts off.
    await fetch(`${base}/api/features`, { method: 'PATCH', headers: s.h, body: JSON.stringify({ shifts: false, kitchen: false }) });
    const id = await openCard(base, s, 1, one(s.roti));
    assert.equal((await post(base, s, `/api/orders/${id}/pay`, { method: 'Card' })).status, 200);
    assert.equal((await post(base, s, '/api/admin/sales/clear', { pin: '1234', confirm: 'CLEAR' })).status, 200);
  });
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: require('../helper').TEST_DATABASE_URL });
  const left = (await admin.query(
    "SELECT nspname FROM pg_namespace WHERE obj_description(oid, 'pg_namespace') LIKE $1", [`%cleared from ${schema};%`])).rows;
  await admin.end();
  assert.deepEqual(left, []);
});
