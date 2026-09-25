const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../lib/auth');
const { awaitH, AppError } = require('../lib/errors');
const { writeAudit } = require('../services/orders');
const { publish } = require('../lib/events');
const features = require('../services/features');
const cards = require('../services/cards');

const router = express.Router();

// Every role reads the flags: the till, the kitchen screen and the nav all
// hide what the shop has switched off. The server refuses it regardless.
router.get('/api/features', requireRole(), awaitH(async (req, res) => {
  const s = await features.state();
  res.json({ features: s.flags, setup_completed: s.setupCompleted });
}));

async function saveFeatures(changes, userId, extra) {
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    const before = await features.all();
    result = await features.save(client, changes);
    if (extra) await extra(client);
    await writeAudit(client, {
      userId, action: 'features.update', entityType: 'settings', entityId: null,
      detail: { before, after: result.features, switched_off: result.switched_off },
    });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await features.reload();
  publish('features.updated', {});
  return result;
}

function pickFlags(body) {
  const b = body || {};
  const src = b.features && typeof b.features === 'object' ? b.features : b;
  return Object.fromEntries(features.MODULES.filter(m => src[m] !== undefined).map(m => [m, !!src[m]]));
}

/* Body: { features: { kitchen: false, ... } } — any subset. The response says
   which children were switched off with their parent, so the screen can tell
   the owner rather than leave a box silently unticked. */
router.patch('/api/features', requireRole('admin'), awaitH(async (req, res) => {
  const changes = pickFlags(req.body);
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'nothing to update' });
  res.json(await saveFeatures(changes, req.user.id));
}));

const pct = (v, key) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw AppError(`bad ${key}`, 400);
  return String(n);
};

/* The wizard's Finish. Everything it collected in one request:
   { restaurant_name, restaurant_address, sst_number, tax_rate_bp, svc_rate_bp,
     features: {...}, card_count, qr_mode: 'per_card' | 'shop' }.
   Validated before anything is written. The card count has its own
   transaction and in-use guard (a re-run can't retire a card with a bill on
   it); every settings row, the flags and setup_completed then commit together. */
router.post('/api/setup', requireRole('admin'), awaitH(async (req, res) => {
  const b = req.body || {};
  const rows = [];
  const text = { restaurant_name: 200, restaurant_address: 300, sst_number: 50 };
  for (const [key, max] of Object.entries(text)) {
    if (b[key] != null) rows.push([key, String(b[key]).trim().slice(0, max)]);
  }
  for (const key of ['tax_rate_bp', 'svc_rate_bp']) if (b[key] !== undefined) rows.push([key, pct(b[key], key)]);
  if (b.qr_mode !== undefined) {
    if (!['per_card', 'shop'].includes(b.qr_mode)) throw AppError('bad qr_mode', 400);
    rows.push(['qr_mode', b.qr_mode]);
  }
  if (b.card_count !== undefined) await cards.setCardCount(b.card_count, req.user.id);

  const result = await saveFeatures(pickFlags(b), req.user.id, async client => {
    for (const [key, value] of [...rows, ['setup_completed', '1']]) {
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    }
    await writeAudit(client, {
      userId: req.user.id, action: 'setup.complete', entityType: 'settings', entityId: null,
      detail: { settings: Object.fromEntries(rows), card_count: b.card_count ?? null },
    });
  });
  if (b.card_count !== undefined) publish('cards.updated', {});
  res.json({ ok: true, ...result, setup_completed: true });
}));

module.exports = router;
