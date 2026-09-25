const { pool } = require('../db');
const { AppError } = require('../lib/errors');

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

// Read on nearly every order, so kept in memory; reloaded after every write
// that goes through save(). One in-flight load is shared by concurrent callers.
let cache = null;

function load() {
  cache = pool.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [KEYS]).then(r => {
    const v = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
    const raw = Object.fromEntries(MODULES.map(m => [m, v[`feature_${m}`] !== '0']));
    return { flags: resolve(raw), setupCompleted: v.setup_completed === '1' };
  });
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

/* Merges `changes` ({kitchen:false, ...}) onto the current flags, applies the
   parent rule, and writes all ten rows inside `client`'s transaction. The
   caller reloads once it has committed. Nothing any module owns is touched:
   switching a module off hides it, it never deletes or rewrites its rows. */
async function save(client, changes) {
  const current = await all();
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
  return { features: next, switched_off: switchedOff };
}

/* Two modules own a piece of in-flight money that nothing else can finish.
   Switching them off mid-way would strand a bill, so it is refused until the
   thing is finished — the data itself is still never touched. */
async function guardTurnOff(client, current, next) {
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

// The shift a payment, refund or order belongs to. With shifts switched off
// nothing is attributed to a shift at all (shift_id NULL, a state the schema
// has always allowed) and no open shift is required.
async function moneyShift(client = pool, refusal) {
  if (!(await isOn('shifts'))) return null;
  const id = (await client.query('SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1')).rows[0]?.id || null;
  if (!id && refusal) throw AppError(refusal, 400);
  return id;
}

module.exports = {
  MODULES, PARENT, PRESETS, state, all, isOn, reload, save, requireFeature, moneyShift,
};
