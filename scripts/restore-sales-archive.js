/* Puts sales cleared by Admin -> System -> Clear sales data back into the
   shop's records. See docs/RUNBOOK.md, "Restore cleared sales data".

     node scripts/restore-sales-archive.js --list
     node scripts/restore-sales-archive.js archive_20260930_220501

   Connects as the app does: DATABASE_URL, or else the PG* variables
   docker-compose.yml gives it. One transaction under the bill lock: it
   restores everything or nothing, and refuses an archive already restored. */
const { pool } = require('../src/db');
const { restoreArchive } = require('../src/services/sales_archive');

async function list() {
  const r = await pool.query(
    `SELECT n.nspname AS archive, obj_description(n.oid, 'pg_namespace') AS note
       FROM pg_namespace n WHERE n.nspname LIKE 'archive\\_%' ORDER BY n.nspname`);
  if (!r.rows.length) { console.log('No sales archives in this database.'); return; }
  for (const a of r.rows) {
    const c = (await pool.query(
      `SELECT (SELECT count(*) FROM "${a.archive}".orders)::int AS bills,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM "${a.archive}".payments)::bigint
            - (SELECT COALESCE(SUM(amount_cents), 0) FROM "${a.archive}".refunds)::bigint AS cents`)).rows[0];
    console.log(`${a.archive}  ${c.bills} bills  RM ${(Number(c.cents) / 100).toFixed(2)}`);
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scripts/restore-sales-archive.js --list | archive_YYYYMMDD_HHMMSS');
    process.exitCode = 2;
    return;
  }
  if (arg === '--list') return list();
  const r = await restoreArchive(arg);
  console.log(`Restored ${r.archive}:`);
  for (const [table, n] of Object.entries(r.rows)) console.log(`  ${table}: ${n}`);
  console.log(`Check the figures, then drop the archive if you no longer need it: DROP SCHEMA "${r.archive}" CASCADE;`);
}

main()
  .catch(e => { console.error(`Not restored: ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
