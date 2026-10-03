// Every test runs in the shop's own time zone, as docker-compose.yml runs the
// app. A suite that ran in UTC passed while regular costs broke in Malaysia
// time (review F1). Node reads TZ again when it changes.
process.env.TZ = 'Asia/Kuala_Lumpur';

const crypto = require('crypto');
const net = require('net');
const { Pool } = require('pg');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const DB_MODULE = require.resolve('../src/db');

// Runs fn(db) against a fresh, empty schema and drops it afterwards, so tests
// never read or write the shared `public` schema. `db` is a fresh require of
// src/db, scoped to the temp schema via search_path.
async function withDb(fn) {
  const schema = `test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);

  const prevUrl = process.env.DATABASE_URL;
  const prevOptions = process.env.PGOPTIONS;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.PGOPTIONS = `-c search_path=${schema}`;
  delete require.cache[DB_MODULE];
  const db = require(DB_MODULE);

  try {
    await db.migrate();
    return await fn(db);
  } finally {
    await db.pool.end();
    delete require.cache[DB_MODULE];
    if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl;
    if (prevOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = prevOptions;
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    // Clear sales data makes archive_YYYYMMDD_HHMMSS schemas beside the one
    // it cleared, labelled with that schema's name in their comment. Drop
    // this test's own, and only those: other test files run at the same time.
    const archives = (await admin.query(
      `SELECT nspname FROM pg_namespace
        WHERE nspname LIKE 'archive\\_%' AND obj_description(oid, 'pg_namespace') LIKE $1`,
      [`%cleared from ${schema};%`])).rows;
    for (const a of archives) await admin.query(`DROP SCHEMA "${a.nspname}" CASCADE`);
    await admin.end();
  }
}

// Binds to port 0 (the OS picks a free one), reads that port back, then
// releases it — replaces every test file's own `randomPort()` (a guess in
// 20000-49999), which collided under a full-suite run and failed with
// EADDRINUSE (an intermittent red build unrelated to the code under test).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { withDb, TEST_DATABASE_URL, getFreePort };
