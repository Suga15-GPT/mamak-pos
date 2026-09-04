const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { cents2rm } = require('../lib/money');
const rounds = require('./rounds');

// "Orderable" = available and not sold out today (sold_out_until resets itself
// at KL midnight rather than requiring an admin to remember to flip it back).
// A bare boolean expression — callers alias it in a SELECT list or use it
// directly in a WHERE clause.
const ORDERABLE_SQL = `(available AND (sold_out_until IS NULL OR sold_out_until < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))`;

async function buildOrderItems(client, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 60)
    throw AppError('invalid items', 400);

  const itemIds = [...new Set(rawItems.map(i => Number(i.item_id)))].filter(id => id > 0);
  const optIds = [...new Set(rawItems.flatMap(i => (i.modifier_option_ids || []).map(Number)))].filter(id => id > 0);

  const im = new Map(itemIds.length
    ? (await client.query(`SELECT *, ${ORDERABLE_SQL} AS orderable FROM items WHERE id = ANY($1::int[])`, [itemIds])).rows.map(x => [x.id, x])
    : []);

  const om = new Map(optIds.length
    ? (await client.query('SELECT * FROM modifier_options WHERE id = ANY($1::int[])', [optIds])).rows.map(x => [x.id, x])
    : []);

  // Groups actually attached to each referenced item, with their min/max rules —
  // the server, not the client, decides which options an item may offer.
  const igRows = itemIds.length
    ? (await client.query(
        `SELECT img.item_id, mg.id AS group_id, mg.name, mg.min_select, mg.max_select
         FROM item_modifier_groups img JOIN modifier_groups mg ON mg.id = img.group_id
         WHERE img.item_id = ANY($1::int[])`, [itemIds])).rows
    : [];
  const groupsByItem = new Map();
  igRows.forEach(r => {
    if (!groupsByItem.has(r.item_id)) groupsByItem.set(r.item_id, []);
    groupsByItem.get(r.item_id).push(r);
  });

  return rawItems.map(li => {
    const it = im.get(Number(li.item_id));
    if (!it || !it.orderable) throw AppError('item unavailable', 400);
    const qty = Math.min(20, Math.max(1, parseInt(li.qty) || 1));

    const mods = (li.modifier_option_ids || []).slice(0, 12).map(id => {
      const o = om.get(Number(id));
      if (!o || !o.available) throw AppError('modifier unavailable', 400);
      return o;
    });

    const attachedGroups = groupsByItem.get(it.id) || [];
    const attachedGroupIds = new Set(attachedGroups.map(g => g.group_id));
    for (const o of mods) {
      if (!attachedGroupIds.has(o.group_id)) throw AppError(`${o.name} is not offered on ${it.name}`, 400);
    }
    for (const g of attachedGroups) {
      const count = mods.filter(o => o.group_id === g.group_id).length;
      if (count < g.min_select || count > g.max_select) {
        const msg = g.min_select === g.max_select ? `${g.name}: choose exactly ${g.min_select}`
          : count < g.min_select ? `${g.name}: choose at least ${g.min_select}`
          : `${g.name}: choose at most ${g.max_select}`;
        throw AppError(msg, 400);
      }
    }

    const seat = li.seat == null || li.seat === '' ? null : Math.max(1, parseInt(li.seat) || 0) || null;
    return { item: it, qty, mods, note: String(li.note || '').slice(0, 200), seat };
  });
}

/* Writes one round's worth of lines. Every line carries the round it was sent
   in (send_id) and a snapshot of the station that prepared it — moving an item
   to another station tomorrow must not rewrite yesterday's ticket. */
async function insertSendLines(client, orderId, sendId, parsed, userId, idemKey = null) {
  const insertedIds = [];
  for (const [i, l] of parsed.entries()) {
    const oi = await client.query(
      `INSERT INTO order_items (order_id, item_id, name, price_cents, qty, note, added_by, seat, idempotency_key, send_id, station_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [orderId, l.item.id, l.item.name, l.item.price_cents, l.qty, l.note || null, userId, l.seat,
       idemKey ? `${idemKey}:${i}` : null, sendId, l.item.station_code || 'kitchen']);
    insertedIds.push(oi.rows[0].id);
    for (const m of l.mods) {
      await client.query('INSERT INTO order_item_mods (order_item_id, name, price_cents) VALUES ($1,$2,$3)',
        [oi.rows[0].id, m.name, m.price_cents]);
    }
  }
  return insertedIds;
}

/* Creates a dining order and its first kitchen round in one transaction.
   `tableId` is null for a takeaway order — the bill exists without a table. */
async function insertOrder(tableId, parsed, note, source, userId = null, idemKey = null, opts = {}) {
  const { orderType = 'dine_in', approvalState = 'approved', publicRef = null } = opts;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Stamps whichever shift is open right now, if any — orders may still be
    // taken with no shift open (only payment is refused for that), so this is
    // nullable.
    const openShift = await client.query('SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1');
    const shiftId = openShift.rows[0]?.id || null;
    const o = await client.query(
      `INSERT INTO orders (table_id, status, source, note, opened_by, idempotency_key, shift_id, order_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [tableId, 'sent', source, note || null, userId, idemKey, shiftId, orderType]);
    const orderId = o.rows[0].id;

    const send = await rounds.createSend(client, orderId, { source, userId, approvalState, publicRef });
    await insertSendLines(client, orderId, send.id, parsed, userId);
    if (approvalState === 'approved') {
      await rounds.openTickets(client, send.id, parsed.map(l => l.item.station_code || 'kitchen'));
    }
    await client.query('COMMIT');
    return { orderId, sendId: send.id, seqNo: send.seq_no };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* Appends a new round to an order that is already open. Returns the new round
   and the ids of the lines it holds, so the caller can print exactly those. */
async function appendSend(orderId, parsed, source, userId = null, idemKey = null, opts = {}) {
  const { approvalState = 'approved', publicRef = null, audit = null } = opts;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const send = await rounds.createSend(client, orderId, { source, userId, approvalState, publicRef });
    const insertedIds = await insertSendLines(client, orderId, send.id, parsed, userId, idemKey);
    if (audit) await writeAudit(client, audit);
    if (approvalState === 'approved') {
      await rounds.openTickets(client, send.id, parsed.map(l => l.item.station_code || 'kitchen'));
      // A fresh round is 'sent', so the order rolls back up to 'sent' even if
      // every earlier round was already served — this is the add-on bug fix.
      await rounds.deriveOrderStatus(client, orderId);
    }
    await client.query('UPDATE orders SET updated_at = now() WHERE id = $1', [orderId]);
    await client.query('COMMIT');
    return { sendId: send.id, seqNo: send.seq_no, insertedIds };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// Records one row per mutating action; `detail` is a plain object (serialised to jsonb by pg).
async function writeAudit(client, { userId, action, entityType, entityId, detail = {} }) {
  await client.query(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [userId || null, action, entityType, entityId, detail]);
}

async function ordersWithItems(where, params, orderBy = 'ORDER BY o.created_at ASC') {
  // LEFT JOIN: a takeaway order has no table at all (migration 012).
  const oq = await pool.query(
    `SELECT o.*, t.name AS table_name FROM orders o LEFT JOIN tables t ON t.id = o.table_id ${where} ${orderBy}`, params);
  const orders = oq.rows;
  if (!orders.length) return [];
  const ids = orders.map(o => o.id);
  const iq = await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id', [ids]);
  const itemIds = iq.rows.map(i => i.id);
  const mq = itemIds.length
    ? await pool.query('SELECT * FROM order_item_mods WHERE order_item_id = ANY($1::int[]) ORDER BY id', [itemIds])
    : { rows: [] };
  const byOrder = {}; orders.forEach(o => { o.items = []; byOrder[o.id] = o; });
  const byItem = {}; iq.rows.forEach(i => { i.mods = []; byItem[i.id] = i; byOrder[i.order_id].items.push(i); });
  mq.rows.forEach(m => byItem[m.order_item_id]?.mods.push(m));
  // Voided lines never count toward a total — paid or still open.
  const totalCents = o => o.items.filter(i => !i.voided_at).reduce((s, i) =>
    s + (i.price_cents + i.mods.reduce((a, m) => a + m.price_cents, 0)) * i.qty, 0);
  const shaped = orders.map(o => ({
    id: o.id, table: o.table_name, table_id: o.table_id, status: o.status, source: o.source,
    order_type: o.order_type,
    // A takeaway order has no table; the floor still needs something to read on
    // a tile, and "Takeaway #128" is what staff call it out as.
    label: o.table_name || `Takeaway #${o.id}`,
    note: o.note, created_at: o.created_at, updated_at: o.updated_at, paid_at: o.paid_at,
    total: cents2rm(totalCents(o)),
    // Bill breakdown is only meaningful once paid (snapshotted at payment time);
    // null on open orders rather than a live, still-changeable recomputation.
    subtotal: o.subtotal_cents == null ? null : cents2rm(o.subtotal_cents),
    service_charge: o.service_charge_cents == null ? null : cents2rm(o.service_charge_cents),
    tax: o.tax_cents == null ? null : cents2rm(o.tax_cents),
    discount: o.discount_cents == null ? null : cents2rm(o.discount_cents),
    rounding: o.rounding_cents == null ? null : cents2rm(o.rounding_cents),
    grand_total: o.total_cents == null ? null : cents2rm(o.total_cents),
    tax_rate_bp: o.tax_rate_bp, svc_rate_bp: o.svc_rate_bp,
    items: o.items.map(i => ({
      id: i.id, item_id: i.item_id, name: i.name, qty: i.qty, price: cents2rm(i.price_cents), note: i.note, seat: i.seat,
      send_id: i.send_id, station: i.station_code,
      mods: i.mods.map(m => ({ name: m.name, price: cents2rm(m.price_cents) })),
      voided: !!i.voided_at, void_reason: i.void_reason || null,
    })),
  }));
  // Rounds carry the preparation state now, so every order ships with them:
  // the bill view separates "already sent" from "new items" off `send_id`, and
  // each line learns its own round number and station state here.
  return rounds.attachSends(shaped);
}

module.exports = {
  buildOrderItems, insertOrder, appendSend, insertSendLines, ordersWithItems, writeAudit, ORDERABLE_SQL,
};
