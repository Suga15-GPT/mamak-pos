const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDb } = require('../helper');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

const SRC_DIR = path.join(__dirname, '..', '..', 'src') + path.sep;
const DB_MODULE = require.resolve('../../src/db');
const SERVER_MODULE = require.resolve('../../src/server');

function randomPort() {
  return 20000 + Math.floor(Math.random() * 30000);
}

// server.js now pulls in a tree of route/service/lib modules under src/, each
// of which captures `pool` from src/db.js at require time. withDb() already
// refreshes src/db.js's cache entry for the current test's schema; clearing
// every *other* src/ module here forces them to re-require it and pick up
// that same fresh pool, instead of running against a previous test's (by now
// ended) pool.
function clearSrcCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR) && key !== DB_MODULE) delete require.cache[key];
  }
}

async function waitReady(base, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      await fetch(`${base}/api/menu`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`server at ${base} never became ready`);
}

// Starts the real app (seed + routes) against the withDb-scoped schema, on an
// ephemeral port so tests never fight each other or the dev server.
async function startApp() {
  const port = randomPort();
  process.env.PORT = String(port);
  process.env.ADMIN_PIN = '1234';
  clearSrcCache();
  require(SERVER_MODULE);
  const base = `http://localhost:${port}`;
  await waitReady(base);
  return base;
}

test('migrate() is idempotent', async () => {
  // withDb() already ran migrate() once to set up the schema; confirm that
  // applied the baseline, then re-run it here as the "second run".
  await withDb(async db => {
    const fileCount = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).length;
    const { rows } = await db.query('SELECT version FROM schema_migrations');
    assert.equal(rows.length, fileCount, 'withDb setup should have applied every migration file');

    const second = await db.migrate();
    assert.equal(second, 0, 're-running migrate() must apply zero versions');
  });
});

test('seeded admin can log in; a wrong PIN returns 401', async () => {
  await withDb(async () => {
    const base = await startApp();

    const wrong = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', pin: '0000' }),
    });
    assert.equal(wrong.status, 401);

    const right = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', pin: '1234' }),
    });
    assert.equal(right.status, 200);
    const body = await right.json();
    assert.ok(body.token, 'login response should include a session token');
  });
});

test('GET /api/orders?mode=recent returns 200 (audit #9)', async () => {
  await withDb(async () => {
    const base = await startApp();

    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', pin: '1234' }),
    });
    const { token } = await login.json();

    const recent = await fetch(`${base}/api/orders?mode=recent`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(recent.status, 200);
    const orders = await recent.json();
    assert.ok(Array.isArray(orders));
  });
});
