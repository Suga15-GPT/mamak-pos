const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/mamak_e2e';

// Drops and recreates the e2e database before the app boots, so every
// `npx playwright test` run starts from the same seeded, orders-empty state.
// Run as a plain script (not a Playwright globalSetup hook) so it always
// finishes — and releases its own connection — before src/server.js opens
// its pool against the same database; a globalSetup hook races the
// webServer process instead of preceding it.
async function main() {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new Pool({ connectionString: adminUrl.toString() });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
