const net = require('net');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { subscriberCount } = require('../lib/events');
const { qrHealth } = require('../lib/baseurl');

/* Admin -> System.

   Every row here corresponds to something actually measured. Nothing reports
   "healthy" because a feature exists: a printer is only green after a socket
   opened to it just now, the last backup time is only shown if a backup wrote
   it, and disk state is omitted entirely on a platform that cannot report it.
   A dashboard that lies is worse than no dashboard. */

const PROBE_TIMEOUT_MS = 1500;

function probePrinter(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const done = (ok, error) => { socket.destroy(); resolve({ ok, error }); };
    const timer = setTimeout(() => done(false, `no answer within ${PROBE_TIMEOUT_MS}ms`), PROBE_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timer); done(true, null); });
    socket.once('error', e => { clearTimeout(timer); done(false, e.code || e.message); });
  });
}

async function checkDatabase() {
  const started = Date.now();
  try {
    const r = await pool.query('SELECT version() AS v, now() AS at');
    return {
      ok: true, latency_ms: Date.now() - started,
      detail: String(r.rows[0].v).split(',')[0],
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - started, detail: e.message };
  }
}

async function checkPrinters() {
  const printers = (await pool.query('SELECT id, name, host, port, role, enabled FROM printers ORDER BY id')).rows;
  const jobs = (await pool.query(`
    SELECT DISTINCT ON (printer_id) printer_id, status, last_error, created_at
      FROM print_jobs WHERE printer_id IS NOT NULL ORDER BY printer_id, id DESC`)).rows;
  const lastByPrinter = Object.fromEntries(jobs.map(j => [j.printer_id, j]));

  const results = await Promise.all(printers.map(async p => {
    if (!p.enabled) return { ...p, reachable: null, note: 'disabled' };
    const probe = await probePrinter(p.host, p.port);
    const last = lastByPrinter[p.id];
    return {
      id: p.id, name: p.name, host: p.host, port: p.port, role: p.role, enabled: p.enabled,
      reachable: probe.ok, error: probe.error,
      last_job: last ? { status: last.status, at: last.created_at, error: last.last_error } : null,
    };
  }));

  const failed = (await pool.query("SELECT count(*)::int n FROM print_jobs WHERE status = 'failed'")).rows[0].n;
  return { printers: results, failed_jobs: failed };
}

async function checkKitchen() {
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE t.status IN ('sent','preparing'))::int AS active,
      COUNT(*) FILTER (WHERE t.status IN ('sent','preparing') AND s.sent_at < now() - interval '10 minutes')::int AS late,
      COALESCE(MAX(FLOOR(EXTRACT(epoch FROM (now() - s.sent_at)) / 60)) FILTER (WHERE t.status IN ('sent','preparing')), 0)::int AS oldest_minutes
    FROM order_send_tickets t JOIN order_sends s ON s.id = t.send_id
   WHERE s.approval_state = 'approved' AND t.status <> 'cancelled'`);
  const stations = (await pool.query('SELECT code, name FROM prep_stations WHERE active ORDER BY sort')).rows;
  return { ...r.rows[0], stations };
}

async function checkBackup() {
  const r = await pool.query("SELECT key, value FROM settings WHERE key IN ('last_backup_at','last_backup_note')");
  const v = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
  const at = v.last_backup_at || null;
  const ageHours = at ? (Date.now() - new Date(at).getTime()) / 3_600_000 : null;
  return {
    // No recorded backup is reported as unknown, not as failure and certainly
    // not as success — the honest answer is "this has never told us".
    at, note: v.last_backup_note || null,
    age_hours: ageHours == null ? null : Math.round(ageHours),
    ok: ageHours != null && ageHours < 48,
    off_device: process.env.BACKUP_REMOTE_TARGET ? { configured: true, target_kind: describeTarget(process.env.BACKUP_REMOTE_TARGET) } : { configured: false },
  };
}

// Never echo the target back verbatim: a remote destination string can carry a
// token or a password, and this response is rendered in a browser.
function describeTarget(target) {
  const t = String(target);
  if (t.startsWith('s3://')) return 'S3-compatible object storage';
  if (t.startsWith('rsync://') || t.includes('@')) return 'remote host over SSH/rsync';
  if (t.startsWith('/')) return 'mounted path (NAS or external disk)';
  return 'configured destination';
}

function checkDisk() {
  // fs.statfs is Node 18+ and not implemented on every platform; report nothing
  // rather than a number that might be wrong.
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const st = fs.statfsSync(process.cwd());
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    if (!total) return null;
    return {
      free_bytes: free, total_bytes: total,
      free_percent: Math.round((free / total) * 100),
      ok: free / total > 0.1,
    };
  } catch { return null; }
}

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
  } catch { return 'unknown'; }
}

async function systemHealth(req) {
  const [database, printing, kitchen, backup, settingsRows] = await Promise.all([
    checkDatabase(), checkPrinters(), checkKitchen(), checkBackup(),
    pool.query("SELECT key, value FROM settings WHERE key IN ('qr_ordering_enabled','qr_require_approval')"),
  ]);
  const s = Object.fromEntries(settingsRows.rows.map(r => [r.key, r.value]));

  return {
    checked_at: new Date().toISOString(),
    version: appVersion(),
    uptime_seconds: Math.round(process.uptime()),
    database,
    realtime: { ok: true, connected_screens: subscriberCount() },
    kitchen,
    printing,
    qr_url: qrHealth(req),
    qr_ordering: {
      enabled: s.qr_ordering_enabled !== '0',
      approval_required: s.qr_require_approval === '1',
    },
    backup,
    disk: checkDisk(),
  };
}

module.exports = { systemHealth, probePrinter };
