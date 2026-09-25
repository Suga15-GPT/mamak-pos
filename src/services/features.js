const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { lockBills } = require('../lib/billlock');

/* ===== switchable feature modules =====
   A small stall runs order-and-pay; a full restaurant switches everything on.
   Each optional module is one settings row, feature_<name> = '1' | '0'.

   A MISSING row means ON. That is deliberate: an existing shop, and every
   install before this change, behaves exactly as it always has until somebody
   writes a '0'. The setup wizard writes all ten explicitly.

   The core — menu, cards, taking orders, payment, tax, staff, the audit log,
   the offline queue, Help and every money guard — is never listed here, so it
   cannot be switched off. */

const MODULES = [
  'kitchen', 'stations', 'printing', 'shifts', 'discounts',
  'refunds', 'split_combine', 'qr', 'voice', 'dashboard',
];

// A child is only ever on while its parent is. Turning a parent off turns its
// child off; turning a parent on leaves the child as the owner set it.
const PARENT = { stations: 'kitchen', voice: 'qr' };

const PRESETS = {
  lite: [],
  medium: ['kitchen', 'printing', 'shifts', 'discounts', 'split_combine'],
  advanced: MODULES,
};

const KEYS = [...MODULES.map(m => `feature_${m}`), 'setup_completed'];

// Read on nearly every request, so kept in memory; reloaded after every write
// that goes through save(). One in-flight load is shared by concurrent callers.
// The cache gates routes and the screens. A bill write that depends on a flag
// reads it with flagsTx() instead (see there).
let cache = null;

// settings rows → { flags, setupCompleted }; a missing feature row is on.
function fromRows(rows) {
  const v = Object.fromEntries(rows.map(row => [row.key, row.value]));
  const raw = Object.fromEntries(MODULES.map(m => [m, v[`feature_${m}`] !== '0']));
  return { flags: resolve(raw), setupCompleted: v.setup_completed === '1' };
}

function load() {
  cache = pool.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [KEYS]).then(r => fromRows(r.rows));
  cache.catch(() => { cache = null; });
  return cache;
}

// Applies the parent rule to a set of requested flags. Returns the effective
// flags and the children that were switched off because their parent was.
function resolve(raw, switchedOff = []) {
  const out = { ...raw };
  for (const [child, parent] of Object.entries(PARENT)) {
    if (!out[parent] && out[child]) { out[child] = false; switchedOff.push(child); }
  }
  return out;
}

async function state() { return cache || load(); }
async function all() { return (await state()).flags; }
async function isOn(name) { return !!(await all())[name]; }
async function reload() { cache = null; return load(); }

/* The flags as committed, read in the caller's transaction after it has taken
   the bill lock. Every flag change takes that lock too (save), so a bill write
   reading here lands wholly before or wholly after a switch — the cache, only
   reloaded once a change has committed, can briefly lag one. Used wherever a
   flag decides what a bill write does: the shift a payment lands in, whether
   a ticket is born served, which station a line goes to, and whether a
   combine or a customer round may still happen at all. */
async function flagsTx(client) {
  const r = await client.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [KEYS]);
  return fromRows(r.rows).flags;
}
async function isOnTx(client, name) { return !!(await flagsTx(client))[name]; }

// requireFeature's answer, for a request that passed the middleware just
// before its module was switched off and then waited on the bill lock.
async function requireOnTx(client, name) {
  if (!(await isOnTx(client, name))) throw AppError('feature_disabled', 404);
}

/* Merges `changes` ({kitchen:false, ...}) onto the current flags, applies the
   parent rule, and writes all ten rows inside `client`'s transaction. The
   caller reloads the cache once it has committed. Nothing any module owns is
   touched: switching a module off hides it, it never deletes or rewrites its
   rows.

   Bill lock first (lib/billlock): the refusals in guardTurnOff read what
   opening a shift, sending and tapping tickets, combining and customer rounds
   write under that lock, and bill writes read their flags under it (flagsTx),
   so nothing can slip in between a check and its commit. `before` is read
   under the lock as well, for the audit row. */
async function save(client, changes) {
  await lockBills(client);
  const current = await flagsTx(client);
  const merged = { ...current };
  for (const m of MODULES) if (changes[m] !== undefined) merged[m] = !!changes[m];
  const switchedOff = [];
  const next = resolve(merged, switchedOff);
  await guardTurnOff(client, current, next);
  for (const m of MODULES) {
    await client.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [`feature_${m}`, next[m] ? '1' : '0']);
  }
  return { before: current, features: next, switched_off: switchedOff };
}

/* Four modules own something in flight that nothing else can finish.
   Switching one off mid-way would strand it, so the switch is refused until
   the thing is finished — the data itself is still never touched. Each check
   runs under the bill lock (save), which whatever it guards takes too: paying
   and opening a shift, sending and tapping tickets, combining, and customer
   rounds. */
async function guardTurnOff(client, current, next) {
  // Cash taken with shifts off carries no shift, so it would never reach the
  // cash-up of a shift left open across the switch: a false over/short.
  if (current.shifts && !next.shifts && await shiftOpen(client)) {
    throw AppError('Close the open shift before switching shifts off.', 409);
  }
  // Tickets part-way through would sit on a board nobody can see, and be
  // cooked again when the kitchen screen came back.
  if (current.kitchen && !next.kitchen) {
    const live = await client.query(
      `SELECT 1 FROM order_send_tickets t
         JOIN order_sends s ON s.id = t.send_id
         JOIN orders o ON o.id = s.order_id
        WHERE s.approval_state = 'approved' AND t.status NOT IN ('served', 'cancelled')
          AND o.status NOT IN ('paid', 'cancelled', 'refunded')
        LIMIT 1`);
    if (live.rows[0]) throw AppError('Finish or clear the kitchen board before switching the kitchen screen off.', 409);
  }
  if (current.split_combine && !next.split_combine) {
    const g = await client.query('SELECT count(*)::int n FROM bill_groups WHERE closed_at IS NULL');
    if (g.rows[0].n) throw AppError('Some cards are on a combined bill right now. Take payment on it, or take the cards apart, before switching off Split and combine.', 409);
  }
  if (current.qr && !next.qr) {
    const p = await client.query(
      `SELECT count(*)::int n FROM order_sends s JOIN orders o ON o.id = s.order_id
        WHERE s.approval_state = 'pending' AND o.status NOT IN ('paid','cancelled','refunded')`);
    if (p.rows[0].n) throw AppError('Some QR orders are still waiting for approval. Accept or reject them before switching off QR ordering.', 409);
  }
}

// 404, not 403: a switched-off module does not exist at this shop, for staff
// and for a customer's phone alike.
function requireFeature(...names) {
  return (req, res, next) => {
    all().then(f => {
      if (names.every(n => f[n])) return next();
      res.status(404).json({ error: 'feature_disabled' });
    }, next);
  };
}

// Whether a shift is open. With shifts on and none open, payments are refused
// until someone opens one — the Features screen and the wizard say so.
async function shiftOpen(client = pool) {
  return !!(await client.query('SELECT 1 FROM shifts WHERE closed_at IS NULL LIMIT 1')).rows[0];
}

/* The shift a payment, refund or order belongs to. Called inside the bill
   lock, never before it: closing a shift takes that lock, so a payment can't
   land in a shift whose cash has just been frozen without it, and the shifts
   switch is read under it too (flagsTx). With shifts switched off nothing is
   attributed to a shift at all (shift_id NULL, a state the schema has always
   allowed) and no open shift is required. */
async function moneyShift(client, refusal) {
  if (!(await isOnTx(client, 'shifts'))) return null;
  const id = (await client.query('SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1')).rows[0]?.id || null;
  if (!id && refusal) throw AppError(refusal, 400);
  return id;
}

module.exports = {
  MODULES, PARENT, PRESETS, state, all, isOn, reload, save, requireFeature, moneyShift, shiftOpen,
  flagsTx, isOnTx, requireOnTx,
};
