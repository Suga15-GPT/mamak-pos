const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb, getFreePort } = require('../helper');

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

async function setup(base) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', pin: '1234' }),
  });
  const body = await json(r);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], 'x-csrf-token': body.csrf_token, 'content-type': 'application/json' };
}

async function waitFor(fn, { timeoutMs = 20000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, everyMs));
  }
  return null;
}

/* Master spec §59.

   The failure is produced for real — a printer configured on a port with
   nothing listening — rather than by writing a 'failed' row by hand, so this
   also covers the queue actually giving up after its retries. */
test('a failed chit can be retried: one reprint, no new order, no new round, bill unchanged', async () => {
  await withDb(async db => {
    const base = await startApp();
    const h = await setup(base);

    // A port the OS just told us is free — nothing is listening on it.
    const deadPort = await getFreePort();
    await fetch(`${base}/api/admin/printers`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ name: 'Kitchen 1', host: '127.0.0.1', port: deadPort, role: 'kitchen', width: 42 }),
    });

    const tables = await json(await fetch(`${base}/api/tables`, { headers: h }));
    const menu = await json(await fetch(`${base}/api/menu`, { headers: h }));
    const roti = menu.items.find(i => i.name === 'Roti Canai');

    const order = await json(await fetch(`${base}/api/orders`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ table_id: tables[0].id, items: [{ item_id: roti.id, qty: 2 }] }),
    }));

    const failed = await waitFor(async () => {
      const jobs = await json(await fetch(`${base}/api/admin/print-jobs`, { headers: h }));
      return jobs.find(j => j.status === 'failed' && j.order_id === order.id) || null;
    });
    assert.ok(failed, 'the chit should end up marked failed once the printer never answers');
    assert.equal(failed.kind, 'chit');
    assert.equal(failed.round, 1, 'the jobs list says which round it was');
    assert.equal(failed.station_name, 'Kitchen');
    assert.equal(failed.order_label, tables[0].name);

    const beforeOrders = await json(await fetch(`${base}/api/orders?mode=recent`, { headers: h }));
    const beforeOrder = beforeOrders.find(o => o.id === order.id);
    const beforeJobs = (await db.query('SELECT count(*)::int n FROM print_jobs')).rows[0].n;

    const retried = await fetch(`${base}/api/admin/print-jobs/${failed.id}/retry`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(retried.status, 200);
    const { job_id: newJobId } = await json(retried);

    // Exactly one new job, carrying the exact original payload.
    const afterJobs = (await db.query('SELECT count(*)::int n FROM print_jobs')).rows[0].n;
    assert.equal(afterJobs, beforeJobs + 1, 'exactly one reprint job is created');
    const rows = (await db.query('SELECT * FROM print_jobs WHERE id = ANY($1::int[]) ORDER BY id', [[failed.id, newJobId]])).rows;
    assert.equal(rows[1].retry_of, failed.id);
    assert.equal(rows[1].kind, rows[0].kind);
    assert.equal(rows[1].order_id, rows[0].order_id);
    assert.equal(rows[1].send_id, rows[0].send_id);
    assert.ok(rows[0].payload.length > 0);
    assert.ok(rows[1].payload.equals(rows[0].payload), 'the reprint is byte-identical to what failed');

    // Nothing about the sale moved.
    const afterOrders = await json(await fetch(`${base}/api/orders?mode=recent`, { headers: h }));
    const afterOrder = afterOrders.find(o => o.id === order.id);
    assert.equal(afterOrders.length, beforeOrders.length, 'no new order');
    assert.equal(afterOrder.sends.length, beforeOrder.sends.length, 'no new kitchen round');
    assert.equal(afterOrder.subtotal, beforeOrder.subtotal, 'the bill is untouched');
    assert.equal(afterOrder.grand_total, beforeOrder.grand_total);
    assert.equal((await db.query('SELECT count(*)::int n FROM payments WHERE order_id = $1', [order.id])).rows[0].n, 0);

    // And it is on the record.
    const audit = await db.query("SELECT * FROM audit_log WHERE action = 'print.retry' AND entity_id = $1", [failed.id]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].detail.new_job_id, newJobId);
  });
});

test('only a failed job can be retried, and a job with no printer is refused', async () => {
  await withDb(async () => {
    const base = await startApp();
    const h = await setup(base);

    // With no printer configured at all, the chit is recorded failed
    // immediately — visible, but with nothing to reprint to.
    const tables = await json(await fetch(`${base}/api/tables`, { headers: h }));
    const menu = await json(await fetch(`${base}/api/menu`, { headers: h }));
    // Roti Canai specifically: a kandar item would be refused for missing its
    // required food options, and then there would be no chit to fail at all.
    const roti = menu.items.find(i => i.name === 'Roti Canai');
    await fetch(`${base}/api/orders`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ table_id: tables[0].id, items: [{ item_id: roti.id, qty: 1 }] }),
    });

    const job = await waitFor(async () => {
      const jobs = await json(await fetch(`${base}/api/admin/print-jobs`, { headers: h }));
      return jobs.find(j => j.status === 'failed') || null;
    });
    assert.ok(job);
    assert.match(job.last_error, /no enabled 'kitchen' printer configured/);

    const refused = await fetch(`${base}/api/admin/print-jobs/${job.id}/retry`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(refused.status, 400);
    assert.match((await json(refused)).error, /no printer/i);

    const missing = await fetch(`${base}/api/admin/print-jobs/999999/retry`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(missing.status, 404);
  });
});
