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

async function insertJob(printerId, kind, orderId, payload, status = 'queued', lastError = null) {
  const r = await pool.query(
    `INSERT INTO print_jobs (printer_id, kind, order_id, payload, status, last_error, attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [printerId, kind, orderId, payload, status, lastError, status === 'failed' ? MAX_ATTEMPTS : 0]);
  return r.rows[0].id;
}

// Routes a print job to every enabled printer with the given role — a printer's
// own configured width (42 for 80mm, 32 for 58mm) decides how row()/line() wrap,
// so the payload is built once per printer, not once per job kind. A printer
// being offline, or none configured at all, must never block or fail the order
// that triggered this: with nothing to print to, the job is recorded failed
// immediately (order_id still set, so it's visible in the jobs list) rather
// than silently dropped.
async function enqueueForRole(kind, orderId, role, buildPayload) {
  const printers = await findEnabledPrinters(role);
  if (!printers.length) {
    await insertJob(null, kind, orderId, Buffer.alloc(0), 'failed', `no enabled '${role}' printer configured`);
    return;
  }
  for (const printer of printers) {
    const payload = await buildPayload(printer.width);
    await insertJob(printer.id, kind, orderId, payload);
  }
  setImmediate(() => processQueue().catch(e => console.error('print queue error:', e.message)));
}

/* ===== templates ===== */

async function loadOrderForPrint(orderId) {
  const o = await pool.query(
    `SELECT o.*, t.name AS table_name, u.name AS opened_by_name
     FROM orders o JOIN tables t ON t.id = o.table_id
     LEFT JOIN users u ON u.id = o.opened_by
     WHERE o.id = $1`, [orderId]);
  if (!o.rows[0]) throw AppError('order not found', 404);
  return o.rows[0];
}

async function loadItems(orderId, itemIds = null) {
  const r = await pool.query(
    itemIds
      ? 'SELECT * FROM order_items WHERE order_id = $1 AND id = ANY($2::int[]) ORDER BY id'
      : 'SELECT * FROM order_items WHERE order_id = $1 AND voided_at IS NULL ORDER BY id',
    itemIds ? [orderId, itemIds] : [orderId]);
  const items = r.rows;
  if (!items.length) return [];
  const mods = await pool.query(
    'SELECT * FROM order_item_mods WHERE order_item_id = ANY($1::int[]) ORDER BY id', [items.map(i => i.id)]);
  const byItem = {};
  items.forEach(i => { i.mods = []; byItem[i.id] = i; });
  mods.rows.forEach(m => byItem[m.order_item_id]?.mods.push(m));
  return items;
}

function chitLine(p, item) {
  p.doubleHeight(true).bold(true).text(`${item.qty}x ${item.name}\n`).bold(false).doubleHeight(false);
  for (const m of item.mods) p.text(`   + ${m.name}\n`);
  if (item.note) p.bold(true).text(`   NOTE: ${item.note}\n`).bold(false);
}

// Kitchen chit — big and skimmable, not pretty: order #, table, time, staff,
// double-height qty-first item lines, modifiers indented, notes in bold, no
// prices (the kitchen doesn't care, and it wastes paper). One chit per order;
// an appended batch prints a new chit headed ADDITION instead of repeating the
// whole order (itemIds names just the newly appended lines).
async function buildChit(orderId, width, { addition = false, itemIds = null } = {}) {
  const order = await loadOrderForPrint(orderId);
  const items = await loadItems(orderId, itemIds);
  const p = createPrinter(width);
  p.init().align(1).bold(true).text(`${addition ? '*** ADDITION ***' : 'KITCHEN CHIT'}\n`).bold(false);
  p.align(0);
  p.text(`Order #${order.id}  Table ${order.table_name}\n`);
  p.text(`${nowKL()}\n`);
  p.text(`Staff: ${order.opened_by_name || '-'}\n`);
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
  p.text(`Order #${order.id}  Table ${order.table_name}\n`);
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
  p.text(`Order #${order.id}  Table ${order.table_name}\n`);
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

// The public entry point named by the phase prompt. Never throws: a print
// failure — no printer, a bad payload, whatever — must never block or fail
// the order that's asking for a chit/receipt to be queued.
async function enqueue(kind, orderId, opts = {}) {
  try {
    if (kind === 'chit') return await enqueueForRole('chit', orderId, 'kitchen', width => buildChit(orderId, width, opts));
    if (kind === 'void') return await enqueueForRole('void', orderId, 'kitchen', width => buildVoidChit(orderId, width, opts.itemId));
    if (kind === 'receipt') return await enqueueForRole('receipt', orderId, 'receipt', width => buildReceipt(orderId, width));
    throw new Error(`unknown print kind '${kind}'`);
  } catch (e) {
    console.error(`printing.enqueue(${kind}, ${orderId}) failed:`, e.message);
  }
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

module.exports = { enqueue, testPrint, reprintReceipt, processQueue, buildChit, buildVoidChit, buildReceipt };
