const crypto = require('crypto');
const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { cents2rm } = require('../lib/money');
const { writeAudit } = require('./orders');

/* ===== card mode =====
   A numbered card is what identifies a dine-in party. A card is "in use"
   exactly while it has an open order (the one_open_order_per_card index), so
   there is no in-use flag to keep in step and no manual release: the card frees
   itself the moment its order is paid, cancelled or refunded. */

const OPEN = "status NOT IN ('paid','cancelled','refunded')";

// SQL for what staff call a dine-in order out as — "Card 7" for a card order,
// the table's own name for a pre-card-mode table order. Callers LEFT JOIN
// cards as `cd` and tables as `tb` (or pass their own aliases).
function locationSql(cardAlias = 'cd', tableAlias = 'tb') {
  return `COALESCE('Card ' || ${cardAlias}.number, ${tableAlias}.name)`;
}

/* Every card, with what the floor needs to draw it: in use or free, and for an
   in-use card how long it has been open, how many items and the running total. */
async function listCards({ includeInactive = false } = {}) {
  const r = await pool.query(
    `SELECT c.id, c.number, c.active,
            o.id AS order_id, o.status, o.created_at, o.updated_at, o.total_cents, o.bill_group_id, o.source,
            (SELECT COALESCE(SUM(oi.qty), 0)::int FROM order_items oi
              WHERE oi.order_id = o.id AND oi.voided_at IS NULL) AS item_count,
            (SELECT COUNT(*)::int FROM order_sends s
              WHERE s.order_id = o.id AND s.approval_state = 'pending') AS pending_rounds
       FROM cards c
       LEFT JOIN orders o ON o.card_id = c.id AND o.${OPEN}
      ${includeInactive ? '' : 'WHERE c.active'}
      ORDER BY c.number`);
  return r.rows.map(c => ({
    id: c.id, number: c.number, active: c.active, in_use: !!c.order_id,
    order: c.order_id ? {
      id: c.order_id, status: c.status, created_at: c.created_at, updated_at: c.updated_at,
      item_count: c.item_count, total: cents2rm(c.total_cents || 0), bill_group_id: c.bill_group_id,
      source: c.source, pending_rounds: c.pending_rounds,
    } : null,
  }));
}

/* Raising the count activates (or creates) numbers up to it; lowering it
   deactivates the top numbers — refused while any of them still has a bill
   open, because that party is still holding the card. */
function parseCardCount(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw AppError('count must be a whole number from 1 to 999', 400);
  return n;
}

// Inside the caller's transaction, so the setup wizard's Finish can change
// the card count together with everything else it saves, or not at all.
async function setCardCountTx(client, count, userId) {
  const n = parseCardCount(count);
  // Locks the cards being retired, so a card cannot be opened between the
  // in-use check and the deactivation (opening takes FOR SHARE on its card).
  const retiring = (await client.query(
    'SELECT id, number FROM cards WHERE number > $1 AND active ORDER BY number FOR UPDATE', [n])).rows;
  if (retiring.length) {
    const busy = (await client.query(
      `SELECT c.number FROM orders o JOIN cards c ON c.id = o.card_id
        WHERE o.card_id = ANY($1::int[]) AND o.${OPEN} ORDER BY c.number`, [retiring.map(c => c.id)])).rows;
    if (busy.length) {
      throw AppError(`Card ${busy.map(b => b.number).join(', ')} still has an open bill. Settle it before lowering the count.`, 409);
    }
    await client.query('UPDATE cards SET active = false WHERE number > $1 AND active', [n]);
  }
  await client.query('UPDATE cards SET active = true WHERE number <= $1 AND NOT active', [n]);
  for (let num = 1; num <= n; num++) {
    await client.query(
      'INSERT INTO cards (number, qr_token) VALUES ($1, $2) ON CONFLICT (number) DO NOTHING',
      [num, crypto.randomBytes(8).toString('hex')]);
  }
  await writeAudit(client, {
    userId, action: 'cards.count', entityType: 'cards', entityId: null, detail: { count: n },
  });
  return { count: n };
}

async function setCardCount(count, userId) {
  const n = parseCardCount(count);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await setCardCountTx(client, n, userId);
    await client.query('COMMIT');
    return r;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* ===== QR self-ordering =====
   qr_mode decides what a scanned token means:
     per_card — the token is one card's own; the order goes onto that card.
     shop     — one shop-wide token; the customer types their card number.
     off      — nothing public resolves at all. */

async function qrSettings() {
  const r = await pool.query("SELECT key, value FROM settings WHERE key IN ('qr_mode','qr_require_approval','qr_shop_token')");
  const v = Object.fromEntries(r.rows.map(row => [row.key, row.value]));
  const mode = ['per_card', 'shop', 'off'].includes(v.qr_mode) ? v.qr_mode : 'per_card';
  return {
    mode,
    enabled: mode !== 'off',
    // In shop mode anyone can type any card number, so a person has to look at
    // the order before it reaches a station — whatever the approval switch says.
    approval_required: mode === 'shop' || v.qr_require_approval === '1',
    shop_token: v.qr_shop_token || null,
  };
}

const QR_OFF = () => Object.assign(AppError('Please order at the counter', 404), { code: 'qr_off' });

/* Resolves a public token (and, in shop mode, a typed card number) to a card.
   `requireCard: false` is the customer page's first look: the shop poster
   resolves before a number is typed, and an unknown token is a 404 page rather
   than the 400 an order submission gets. Throws 404 when QR ordering is off. */
async function resolveQr(token, cardNumber, { requireCard = true } = {}) {
  const settings = await qrSettings();
  if (!settings.enabled) throw QR_OFF();
  const tok = String(token || '');
  const unknown = () => AppError('unknown QR code', requireCard ? 400 : 404);
  if (settings.mode === 'per_card') {
    const c = (await pool.query('SELECT id, number FROM cards WHERE qr_token = $1 AND active', [tok])).rows[0];
    if (!c) throw unknown();
    return { settings, card: c };
  }
  if (!settings.shop_token || tok !== settings.shop_token) throw unknown();
  if (cardNumber == null || cardNumber === '') {
    if (requireCard) throw AppError('Please enter the number on your card', 400);
    return { settings, card: null };
  }
  const c = (await pool.query('SELECT id, number FROM cards WHERE number = $1 AND active', [Number(cardNumber) || 0])).rows[0];
  if (!c) throw AppError('That card number is not in use here. Please check your card.', 400);
  return { settings, card: c };
}

module.exports = { listCards, parseCardCount, setCardCount, setCardCountTx, qrSettings, resolveQr, locationSql };
