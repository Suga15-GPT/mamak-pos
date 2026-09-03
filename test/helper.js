const crypto = require('crypto');
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
    await admin.end();
  }
}

module.exports = { withDb, TEST_DATABASE_URL };
