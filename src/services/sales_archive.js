const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { lockBills } = require('../lib/billlock');
const { openSql } = require('../lib/status');
const { writeAudit } = require('./orders');
const rounds = require('./rounds');

/* ===== Clear sales data =====
   A shop that trained on the till, or ran a trial day, starts its figures
   from RM0 without losing anything: every sales row moves out of the shop's
   schema into a new schema, archive_YYYYMMDD_HHMMSS (shop time), in one
   transaction under the bill lock. Copy first, then remove; nothing is
   deleted outright, and docs/RUNBOOK.md (scripts/restore-sales-archive.js)
   puts it back.

   What moves is every table that records a sale — bills, their lines,
   options, rounds and kitchen tickets, payments, discounts, refunds, combined
   bills, shifts and their cash movements, print jobs — with their idempotency
   keys, which are columns on orders and order_items. What stays is what the
   shop is: menu, stations, staff and their logins, cards and tables,
   printers, settings and feature switches, and the audit log (plus one row
   saying this happened).

   Sequences are not touched: the next bill number carries on from the last
   one, so an archived bill and a new one can never share a number, and an
   archive can be restored beside new trading.

   Migrations 015/017/019 put a trigger on orders that refuses to change a
   closed bill. It fires on UPDATE only, and this never updates a bill: it
   copies (INSERT ... SELECT into the archive) and deletes, so the trigger
   stays exactly as strict for every other path. The foreign keys between
   sales tables (refunds -> payments, orders -> bill_groups and shifts,
   order_items -> order_sends, print_jobs -> orders, ...) are satisfied by
   deleting children before parents, in SALES_TABLES order; nothing outside
   the list points into it. */

// Children before parents: the order rows leave the shop's schema in.
const SALES_TABLES = [
  'print_jobs', 'refunds', 'payments', 'discounts', 'cash_movements',
  'order_item_mods', 'order_send_tickets', 'order_items', 'order_sends',
  'orders', 'bill_groups', 'shifts',
];

// Everything else in the schema stays. A table a later migration adds has to
// be named in one list or the other: a unit test compares both with the
// schema, so a new sales table can't be left behind by accident.
const KEPT_TABLES = [
  'users', 'sessions', 'categories', 'items', 'modifier_groups', 'modifier_options',
  'item_modifier_groups', 'prep_stations', 'tables', 'cards', 'printers',
  'settings', 'audit_log', 'schema_migrations',
];

const ARCHIVE_NAME = /^archive_\d{8}_\d{6}(_\d+)?$/;
const ident = s => `"${String(s).replace(/"/g, '""')}"`;
const literal = s => `'${String(s).replace(/'/g, "''")}'`;
const qualified = (schema, table) => `${ident(schema)}.${ident(table)}`;

async function currentSchema(client) {
  return (await client.query('SELECT current_schema() AS s')).rows[0].s;
}

function nameList(labels, max = 6) {
  const shown = labels.slice(0, max).join(', ');
  return labels.length > max ? `${shown} and ${labels.length - max} more` : shown;
}

/* Why sales can't be cleared right now — one sentence each, empty when they
   can. Checked under the bill lock by clearSales, which every bill write,
   shift change and kitchen tap takes too. */
async function blockers(client) {
  const reasons = [];
  const open = (await client.query(
    `SELECT COALESCE('Card ' || cd.number, t.name, 'Takeaway #' || o.id) AS label
       FROM orders o LEFT JOIN cards cd ON cd.id = o.card_id LEFT JOIN tables t ON t.id = o.table_id
      WHERE ${openSql('o.status')} ORDER BY o.id`)).rows.map(r => r.label);
  const groups = (await client.query('SELECT count(*)::int n FROM bill_groups WHERE closed_at IS NULL')).rows[0].n;
  if (open.length) {
    reasons.push(`${open.length === 1 ? 'A bill is' : `${open.length} bills are`} still open (${nameList(open)}). Take payment on ${open.length === 1 ? 'it' : 'them'} or cancel ${open.length === 1 ? 'it' : 'them'} first.`);
  } else if (groups) {
    reasons.push('A combined bill is still open. Take payment on it, or take its cards apart, first.');
  }
  if ((await client.query('SELECT 1 FROM shifts WHERE closed_at IS NULL LIMIT 1')).rows[0]) {
    reasons.push('A shift is still open. Close it on 🕐 Shift first.');
  }
  const tickets = await rounds.boardUnfinishedCount(client);
  if (tickets) {
    reasons.push(`The kitchen still has ${tickets === 1 ? 'a ticket' : `${tickets} tickets`} to finish. Finish or clear the kitchen board first.`);
  }
  return reasons;
}

// What the sales history adds up to. total_cents is the money kept:
// payments less refunds.
async function totals(client, schema) {
  const t = name => qualified(schema, name);
  const r = (await client.query(
    `SELECT (SELECT count(*) FROM ${t('orders')})::int AS bills,
            (SELECT count(*) FROM ${t('orders')} WHERE status IN ('paid','refunded'))::int AS paid_bills,
            (SELECT COALESCE(SUM(total_cents), 0) FROM ${t('orders')} WHERE status IN ('paid','refunded'))::bigint AS sales_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM ${t('payments')})::bigint AS payments_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM ${t('refunds')})::bigint AS refunds_cents,
            (SELECT count(*) FROM ${t('shifts')})::int AS shifts`)).rows[0];
  const n = k => Number(r[k]);
  return {
    bills: r.bills, paid_bills: r.paid_bills, shifts: r.shifts,
    sales_cents: n('sales_cents'), payments_cents: n('payments_cents'), refunds_cents: n('refunds_cents'),
    total_cents: n('payments_cents') - n('refunds_cents'),
  };
}

async function rowCounts(client, schema) {
  const counts = {};
  for (const table of SALES_TABLES) {
    counts[table] = (await client.query(`SELECT count(*)::int n FROM ${qualified(schema, table)}`)).rows[0].n;
  }
  return counts;
}

// For Admin -> System: what clearing would move, and anything in the way.
async function preview() {
  const client = await pool.connect();
  try {
    const schema = await currentSchema(client);
    const rows = await rowCounts(client, schema);
    return {
      ...(await totals(client, schema)),
      rows: Object.values(rows).reduce((s, n) => s + n, 0),
      reasons: await blockers(client),
    };
  } finally { client.release(); }
}

/* Moves every sales row into a new archive schema. Refused (409) while a bill
   is open, a shift is open or the kitchen has a ticket to finish, and when
   there is nothing to clear. The caller has checked who is asking. */
async function clearSales({ userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockBills(client);
    const schema = await currentSchema(client);
    // Every bill write is queued behind the bill lock already. This also
    // holds back the few writes that don't take it — the print queue above
    // all — so no row can appear or vanish between the copy and the delete.
    // Readers carry on. (A receipt queued for a bill paid a moment before is
    // then refused by its foreign key, and only logged: printing never throws.)
    await client.query(`LOCK TABLE ${SALES_TABLES.map(t => qualified(schema, t)).join(', ')} IN EXCLUSIVE MODE`);

    const reasons = await blockers(client);
    if (reasons.length) throw Object.assign(AppError(reasons.join(' '), 409), { reasons });
    const rows = await rowCounts(client, schema);
    if (!Object.values(rows).some(n => n > 0)) throw AppError('There are no sales to clear — every figure is already RM0.', 409);
    const sums = await totals(client, schema);

    // Shop time, to the second. Two clears in one second can only happen with
    // nothing sold in between, which is refused just above; a clash is still
    // numbered rather than lost.
    const stamp = (await client.query(
      "SELECT to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYYMMDD_HH24MISS') AS s")).rows[0].s;
    let archive = `archive_${stamp}`;
    for (let n = 2; (await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [archive])).rows[0]; n++) {
      archive = `archive_${stamp}_${n}`;
    }
    await client.query(`CREATE SCHEMA ${ident(archive)}`);
    await client.query(`COMMENT ON SCHEMA ${ident(archive)} IS ${literal(`Mamak POS sales cleared from ${schema}; restore with scripts/restore-sales-archive.js`)}`);

    for (const table of SALES_TABLES) {
      await client.query(`CREATE TABLE ${qualified(archive, table)} AS SELECT * FROM ${qualified(schema, table)}`);
    }
    for (const table of SALES_TABLES) {
      const gone = (await client.query(`DELETE FROM ${qualified(schema, table)}`)).rowCount;
      if (gone !== rows[table]) throw AppError(`${table}: archived ${rows[table]} rows but removed ${gone}; nothing was changed`, 500);
    }

    await writeAudit(client, {
      userId, action: 'sales.clear', entityType: 'system', entityId: null,
      detail: { archive, ...sums, rows },
    });
    await client.query('COMMIT');
    return { archive, ...sums, rows };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* Puts an archive back: its rows go into the shop's tables, parents first,
   under the bill lock, in one transaction. Only columns both sides have are
   copied (a column a later migration added takes its default). Refused when
   the archive's bills are already there. The archive schema itself is left
   in place; drop it once the restore is checked. */
async function restoreArchive(archive, { userId = null } = {}) {
  if (!ARCHIVE_NAME.test(String(archive))) throw AppError('that is not the name of a sales archive (archive_YYYYMMDD_HHMMSS)', 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockBills(client);
    const schema = await currentSchema(client);
    const tables = new Set((await client.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [archive])).rows.map(r => r.table_name));
    if (!tables.size) throw AppError(`there is no archive called ${archive}`, 404);

    if (tables.has('orders')) {
      const clash = (await client.query(
        `SELECT count(*)::int n FROM ${qualified(archive, 'orders')} a JOIN ${qualified(schema, 'orders')} o ON o.id = a.id`)).rows[0].n;
      if (clash) throw AppError(`${archive} looks restored already: ${clash} of its bills are in the shop's records`, 409);
    }

    const restored = {};
    for (const table of [...SALES_TABLES].reverse()) {
      if (!tables.has(table)) continue;
      const cols = (await client.query(
        `SELECT c.column_name FROM information_schema.columns c
          WHERE c.table_schema = $1 AND c.table_name = $3
            AND EXISTS (SELECT 1 FROM information_schema.columns a
                         WHERE a.table_schema = $2 AND a.table_name = $3 AND a.column_name = c.column_name)
          ORDER BY c.ordinal_position`, [schema, archive, table])).rows.map(r => ident(r.column_name)).join(', ');
      restored[table] = (await client.query(
        `INSERT INTO ${qualified(schema, table)} (${cols}) SELECT ${cols} FROM ${qualified(archive, table)}`)).rowCount;
    }

    await writeAudit(client, {
      userId, action: 'sales.restore', entityType: 'system', entityId: null,
      detail: { archive, rows: restored, ...(await totals(client, archive)) },
    });
    await client.query('COMMIT');
    return { archive, rows: restored };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

module.exports = { SALES_TABLES, KEPT_TABLES, preview, clearSales, restoreArchive, blockers };
