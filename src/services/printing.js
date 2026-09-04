const net = require('net');
const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { formatRM } = require('../lib/money');
const { createPrinter } = require('../lib/escpos');
const { writeAudit } = require('./orders');

const MAX_ATTEMPTS = 3;
const KL_TZ = 'Asia/Kuala_Lumpur';

function nowKL() { return new Date().toLocaleString('en-MY', { timeZone: KL_TZ, hour12: false }); }

async function findEnabledPrinters(role) {
  const r = await pool.query('SELECT * FROM printers WHERE role = $1 AND enabled = true ORDER BY id', [role]);
  return r.rows;
}

async function insertJob(printerId, kind, orderId, payload, status = 'queued', lastError = null, meta = {}) {
  const r = await pool.query(
    `INSERT INTO print_jobs (printer_id, kind, order_id, payload, status, last_error, attempts, send_id, station_code, retry_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [printerId, kind, orderId, payload, status, lastError, status === 'failed' ? MAX_ATTEMPTS : 0,
     meta.sendId || null, meta.stationCode || null, meta.retryOf || null]);
  return r.rows[0].id;
}

// Routes a print job to every enabled printer with the given role — a printer's
// own configured width (42 for 80mm, 32 for 58mm) decides how row()/line() wrap,
// so the payload is built once per printer, not once per job kind. A printer
// being offline, or none configured at all, must never block or fail the order
// that triggered this: with nothing to print to, the job is recorded failed
// immediately (order_id still set, so it's visible in the jobs list) rather
// than silently dropped.
async function enqueueForRole(kind, orderId, role, buildPayload, meta = {}) {
  let printers = await findEnabledPrinters(role);
  // A shop with one printer must not lose its drinks chits because no 'bar'
  // printer exists: fall back to the kitchen, which is where those chits went
  // before stations existed.
  if (!printers.length && role !== 'kitchen' && role !== 'receipt') printers = await findEnabledPrinters('kitchen');
  if (!printers.length) {
    await insertJob(null, kind, orderId, Buffer.alloc(0), 'failed', `no enabled '${role}' printer configured`, meta);
    return;
  }
  for (const printer of printers) {
    const payload = await buildPayload(printer.width);
    await insertJob(printer.id, kind, orderId, payload, 'queued', null, meta);
  }
  setImmediate(() => processQueue().catch(e => console.error('print queue error:', e.message)));
}

/* ===== templates ===== */

async function loadOrderForPrint(orderId) {
  // LEFT JOIN tables: a takeaway order has no table (migration 012).
  const o = await pool.query(
    `SELECT o.*, t.name AS table_name, u.name AS opened_by_name
     FROM orders o LEFT JOIN tables t ON t.id = o.table_id
     LEFT JOIN users u ON u.id = o.opened_by
     WHERE o.id = $1`, [orderId]);
  if (!o.rows[0]) throw AppError('order not found', 404);
  return o.rows[0];
}

// What staff call this order out as. Takeaway has no table to name.
function orderLabel(order) {
  return order.order_type === 'takeaway' ? `TAKEAWAY #${order.id}` : `Table ${order.table_name}`;
}

async function withMods(items) {
  if (!items.length) return [];
  const mods = await pool.query(
    'SELECT * FROM order_item_mods WHERE order_item_id = ANY($1::int[]) ORDER BY id', [items.map(i => i.id)]);
  const byItem = {};
  items.forEach(i => { i.mods = []; byItem[i.id] = i; });
  mods.rows.forEach(m => byItem[m.order_item_id]?.mods.push(m));
  return items;
}

async function loadItems(orderId, itemIds = null) {
  const r = await pool.query(
    itemIds
      ? 'SELECT * FROM order_items WHERE order_id = $1 AND id = ANY($2::int[]) ORDER BY id'
      : 'SELECT * FROM order_items WHERE order_id = $1 AND voided_at IS NULL ORDER BY id',
    itemIds ? [orderId, itemIds] : [orderId]);
  return withMods(r.rows);
}

// The round, its order, and just the lines one station is responsible for.
async function loadSendForPrint(sendId, stationCode) {
  const s = await pool.query(
    `SELECT s.*, u.name AS sent_by_name, ps.name AS station_name
       FROM order_sends s
       LEFT JOIN users u ON u.id = s.sent_by
       CROSS JOIN LATERAL (SELECT name FROM prep_stations WHERE code = $2) ps
      WHERE s.id = $1`, [sendId, stationCode]);
  if (!s.rows[0]) throw AppError('round not found', 404);
  const order = await loadOrderForPrint(s.rows[0].order_id);
  const items = await withMods((await pool.query(
    `SELECT * FROM order_items WHERE send_id = $1 AND station_code = $2 AND voided_at IS NULL ORDER BY id`,
    [sendId, stationCode])).rows);
  return { send: s.rows[0], order, items };
}

function chitLine(p, item) {
  p.doubleHeight(true).bold(true).text(`${item.qty}x ${item.name}\n`).bold(false).doubleHeight(false);
  for (const m of item.mods) p.text(`   + ${m.name}\n`);
  if (item.note) p.bold(true).text(`   NOTE: ${item.note}\n`).bold(false);
}

// Kitchen/drinks chit — big and skimmable, not pretty: order #, table, round,
// time, who sent it, double-height qty-first item lines, modifiers indented,
// notes in bold, no prices (the station doesn't care, and it wastes paper).
//
// One chit per (round, station). Round 2 prints *only* round 2's lines for
// *that* station — the original order is never reprinted just because an add-on
// was sent, which is the behaviour a mamak kitchen depends on.
async function buildChit(sendId, stationCode, width) {
  const { send, order, items } = await loadSendForPrint(sendId, stationCode);
  const p = createPrinter(width);
  p.init().align(1).bold(true)
    .text(`${send.seq_no > 1 ? `*** ADD-ON · ROUND ${send.seq_no} ***` : 'KITCHEN CHIT'}\n`)
    .text(`${send.station_name.toUpperCase()}\n`).bold(false);
  p.align(0);
  p.text(`${orderLabel(order).toUpperCase()}   ORDER #${order.id}\n`);
  p.text(`Round ${send.seq_no}   ${nowKL()}\n`);
  // Every send records who sent it (master spec §13); a QR round says so
  // instead of naming a staff member who never touched it.
  p.text(`By: ${send.source === 'qr' ? 'CUSTOMER QR' : (send.sent_by_name || order.opened_by_name || '-')}\n`);
  p.line('=');
  items.forEach(item => chitLine(p, item));
  p.line('=');
  p.text('\n\n');
  p.cut();
  return p.toBuffer();
}

// Void chit — same shape, headed *** VOID ***, listing only the voided line
// and its reason, so the cook stops cooking it.
async function buildVoidChit(orderId, width, itemId) {
  const order = await loadOrderForPrint(orderId);
  const items = await loadItems(orderId, [itemId]);
  const p = createPrinter(width);
  p.init().align(1).bold(true).text('*** VOID ***\n').bold(false);
  p.align(0);
  p.text(`Order #${order.id}  ${orderLabel(order)}\n`);
  p.line('=');
  items.forEach(item => {
    chitLine(p, item);
    p.bold(true).text(`   REASON: ${item.void_reason || '-'}\n`).bold(false);
  });
  p.line('=');
  p.text('\n\n');
  p.cut();
  return p.toBuffer();
}

// Receipt — restaurant name/address/SST number, order #, table, date/time,
// staff, item lines with prices, then the full phase-02 money breakdown
// (subtotal, service charge if non-zero, SST, discount, rounding, total), the
// payments with change due, and a thank-you.
async function buildReceipt(orderId, width) {
  const order = await loadOrderForPrint(orderId);
  const items = await loadItems(orderId);
  const payments = (await pool.query('SELECT * FROM payments WHERE order_id = $1 ORDER BY at', [orderId])).rows;
  const settingsRows = (await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('restaurant_name','restaurant_address','sst_number')")).rows;
  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));

  const p = createPrinter(width);
  p.init().align(1);
  p.bold(true).text(`${settings.restaurant_name || 'Mamak POS'}\n`).bold(false);
  if (settings.restaurant_address) p.text(`${settings.restaurant_address}\n`);
  if (settings.sst_number) p.text(`SST Reg: ${settings.sst_number}\n`);
  p.align(0);
  p.line('-');
  p.text(`Order #${order.id}  ${orderLabel(order)}\n`);
  p.text(`${nowKL()}\n`);
  p.text(`Staff: ${order.opened_by_name || '-'}\n`);
  p.line('-');
  items.forEach(item => {
    p.row(`${item.qty}x ${item.name}`, formatRM(item.price_cents * item.qty));
    item.mods.forEach(m => p.row(`  + ${m.name}`, m.price_cents ? formatRM(m.price_cents * item.qty) : ''));
  });
  p.line('-');
  p.row('Subtotal', formatRM(order.subtotal_cents || 0));
  if (order.service_charge_cents) p.row('Service charge', formatRM(order.service_charge_cents));
  p.row('SST', formatRM(order.tax_cents || 0));
  if (order.discount_cents) p.row('Discount', `-${formatRM(order.discount_cents)}`);
  if (order.rounding_cents) p.row('Rounding', formatRM(order.rounding_cents));
  p.bold(true); p.row('TOTAL', formatRM(order.total_cents || 0)); p.bold(false);
  p.line('-');
  payments.forEach(pay => {
    p.row(pay.method, formatRM(pay.amount_cents));
    if (pay.tendered_cents != null && pay.tendered_cents > pay.amount_cents) {
      p.row('Change', formatRM(pay.tendered_cents - pay.amount_cents));
    }
  });
  p.line('-');
  p.align(1);
  p.text('Thank you!\n\n\n');
  p.cut();
  return p.toBuffer();
}

// X/Z report (phase 09) — same restaurant header as the receipt, then the
// shift's headline figures. `data` is the object services/shifts.js's
// report() already computed; this only formats it, never queries the DB.
async function buildZReport(shiftId, width, data) {
  const p = createPrinter(width);
  p.init().align(1);
  p.bold(true).text(`${data.restaurant.restaurant_name || 'Mamak POS'}\n`).bold(false);
  if (data.restaurant.restaurant_address) p.text(`${data.restaurant.restaurant_address}\n`);
  if (data.restaurant.sst_number) p.text(`SST Reg: ${data.restaurant.sst_number}\n`);
  p.align(0);
  p.line('=');
  p.bold(true).text(`${data.final ? 'Z REPORT' : 'X REPORT'} — Shift #${shiftId}\n`).bold(false);
  p.text(`${nowKL()}\n`);
  p.line('-');
  p.row('Gross sales', formatRM(data.gross_cents));
  p.row('Discounts', formatRM(data.discounts_cents));
  p.row('Comps', formatRM(data.comps_cents));
  p.row('Voids', `${data.voids_count} / ${formatRM(data.voids_cents)}`);
  p.row('Refunds', formatRM(data.refunds_cents));
  p.row('Net sales', formatRM(data.net_sales_cents));
  p.row('Service charge', formatRM(data.service_charge_cents));
  p.row('SST', formatRM(data.tax_cents));
  p.row('Rounding', formatRM(data.rounding_cents));
  p.row('Carried fwd', `${data.carried_forward.count} / ${formatRM(data.carried_forward.cents)}`);
  p.line('-');
  data.payment_mix.forEach(m => p.row(m.method, formatRM(m.cents)));
  p.line('-');
  data.refund_mix.forEach(m => p.row(`Refund: ${m.method}`, formatRM(m.cents)));
  p.line('-');
  p.row('Orders', String(data.order_count));
  p.row('Avg check', formatRM(data.avg_check_cents));
  p.line('-');
  p.bold(true).text('Cash reconciliation\n').bold(false);
  p.row('Float', formatRM(data.cash.float_cents));
  p.row('Cash sales', formatRM(data.cash.cash_sales_cents));
  p.row('Pay in', formatRM(data.cash.payins_cents));
  p.row('Pay out', formatRM(data.cash.payouts_cents));
  p.row('Expected', formatRM(data.cash.expected_cents));
  if (data.cash.counted_cents != null) p.row('Counted', formatRM(data.cash.counted_cents));
  if (data.cash.variance_cents != null) p.row('Variance', formatRM(data.cash.variance_cents));
  p.line('-');
  p.bold(true).text('Voids & discounts by staff\n').bold(false);
  data.staff_voids.forEach(v => p.row(v.staff, `${v.count} / ${formatRM(v.cents)}`));
  p.bold(true).text('Refunds by staff\n').bold(false);
  data.staff_refunds.forEach(v => p.row(v.staff, `${v.count} / ${formatRM(v.cents)}`));
  p.line('=');
  p.text('\n\n');
  p.cut();
  return p.toBuffer();
}

async function printShiftReport(shiftId, data) {
  return enqueueForRole('report', null, 'receipt', width => buildZReport(shiftId, width, data));
}

/* ===== dispatch ===== */

function sendToPrinter(host, port, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout connecting to printer')); }, timeoutMs);
    socket.once('connect', () => socket.end(payload));
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.once('error', e => { clearTimeout(timer); reject(e); });
  });
}

let draining = false;
// Opens a TCP socket to each queued job's printer, writes the payload, closes.
// On failure: increment attempts, retry with backoff up to MAX_ATTEMPTS, then
// give up and mark it failed — a jammed/offline printer never blocks the order
// that queued the job, only its own retry loop.
async function processQueue() {
  if (draining) return;
  draining = true;
  try {
    const jobs = (await pool.query(
      `SELECT j.*, p.host, p.port FROM print_jobs j JOIN printers p ON p.id = j.printer_id
       WHERE j.status = 'queued' ORDER BY j.id`)).rows;
    for (const job of jobs) {
      await pool.query("UPDATE print_jobs SET status = 'printing' WHERE id = $1", [job.id]);
      try {
        await sendToPrinter(job.host, job.port, job.payload);
        await pool.query("UPDATE print_jobs SET status = 'done' WHERE id = $1", [job.id]);
      } catch (e) {
        const attempts = job.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await pool.query("UPDATE print_jobs SET status = 'failed', attempts = $1, last_error = $2 WHERE id = $3",
            [attempts, String(e.message || e), job.id]);
        } else {
          await pool.query("UPDATE print_jobs SET status = 'queued', attempts = $1, last_error = $2 WHERE id = $3",
            [attempts, String(e.message || e), job.id]);
          const delay = Math.min(30000, 1000 * 2 ** attempts);
          setTimeout(() => processQueue().catch(() => {}), delay);
        }
      }
    }
  } finally {
    draining = false;
  }
}

/* One chit per (round, station), routed to that station's own printer role.
   Never throws: a print failure — no printer, a bad payload, whatever — must
   never block or fail the order that asked for the chit. */
async function enqueueRoundChits(sendId) {
  try {
    const send = (await pool.query('SELECT id, order_id FROM order_sends WHERE id = $1', [sendId])).rows[0];
    if (!send) return;
    const stations = (await pool.query(
      `SELECT DISTINCT oi.station_code, ps.printer_role
         FROM order_items oi JOIN prep_stations ps ON ps.code = oi.station_code
        WHERE oi.send_id = $1 AND oi.voided_at IS NULL`, [sendId])).rows;
    for (const st of stations) {
      await enqueueForRole('chit', send.order_id, st.printer_role,
        width => buildChit(sendId, st.station_code, width),
        { sendId, stationCode: st.station_code });
    }
  } catch (e) {
    console.error(`printing.enqueueRoundChits(${sendId}) failed:`, e.message);
  }
}

// The public entry point named by the phase prompt. Never throws, same reason.
async function enqueue(kind, orderId, opts = {}) {
  try {
    if (kind === 'void') {
      // A void chit belongs at the station that is cooking the line.
      const st = (await pool.query(
        `SELECT oi.station_code, ps.printer_role FROM order_items oi
           JOIN prep_stations ps ON ps.code = oi.station_code WHERE oi.id = $1`, [opts.itemId])).rows[0];
      return await enqueueForRole('void', orderId, st?.printer_role || 'kitchen',
        width => buildVoidChit(orderId, width, opts.itemId), { stationCode: st?.station_code || null });
    }
    if (kind === 'receipt') return await enqueueForRole('receipt', orderId, 'receipt', width => buildReceipt(orderId, width));
    throw new Error(`unknown print kind '${kind}'`);
  } catch (e) {
    console.error(`printing.enqueue(${kind}, ${orderId}) failed:`, e.message);
  }
}

/* Re-queues a failed job's *stored payload* verbatim (master spec §48): the
   exact bytes that failed to reach the printer, on the same printer, as a new
   job marked retry_of. It creates no order, no round, no charge, and touches
   no bill — the only thing it does is try the paper again. Always audited,
   for the same reason a receipt reprint is. */
async function retryJob(jobId, userId) {
  const job = (await pool.query('SELECT * FROM print_jobs WHERE id = $1', [jobId])).rows[0];
  if (!job) throw AppError('print job not found', 404);
  if (job.status !== 'failed') throw AppError('only a failed job can be retried', 400);
  if (!job.printer_id) throw AppError('this job has no printer to retry to — configure a printer first', 400);
  if (!job.payload || !job.payload.length) throw AppError('this job has no stored ticket to reprint', 400);

  const newId = await insertJob(job.printer_id, job.kind, job.order_id, job.payload, 'queued', null,
    { sendId: job.send_id, stationCode: job.station_code, retryOf: job.id });
  await writeAudit(pool, {
    userId, action: 'print.retry', entityType: 'print_job', entityId: job.id,
    detail: { new_job_id: newId, kind: job.kind, order_id: job.order_id, send_id: job.send_id, station: job.station_code },
  });
  setImmediate(() => processQueue().catch(e => console.error('print queue error:', e.message)));
  return newId;
}

// Admin "Test print" — targets one specific printer directly, no order context.
async function testPrint(printerId) {
  const printer = (await pool.query('SELECT * FROM printers WHERE id = $1', [printerId])).rows[0];
  if (!printer) throw AppError('printer not found', 404);
  const p = createPrinter(printer.width);
  p.init().align(1).bold(true).text('TEST PRINT\n').bold(false);
  p.text(`${printer.name}\n${nowKL()}\n\n\n`);
  p.cut();
  const jobId = await insertJob(printer.id, 'report', null, p.toBuffer());
  setImmediate(() => processQueue().catch(e => console.error('print queue error:', e.message)));
  return jobId;
}

// A reprinted receipt is a known fraud vector — always write an audit row.
async function reprintReceipt(orderId, userId) {
  await writeAudit(pool, { userId, action: 'receipt.reprint', entityType: 'order', entityId: orderId, detail: {} });
  return enqueue('receipt', orderId);
}

module.exports = {
  enqueue, enqueueRoundChits, retryJob, testPrint, reprintReceipt, processQueue,
  buildChit, buildVoidChit, buildReceipt, buildZReport, printShiftReport,
};
