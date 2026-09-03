const { pool } = require('../db');
const { AppError } = require('../lib/errors');
const { cents2rm } = require('../lib/money');

async function buildOrderItems(client, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 60)
    throw AppError('invalid items', 400);

  const itemIds = [...new Set(rawItems.map(i => Number(i.item_id)))].filter(id => id > 0);
  const optIds = [...new Set(rawItems.flatMap(i => (i.modifier_option_ids || []).map(Number)))].filter(id => id > 0);

  const im = new Map(itemIds.length
    ? (await client.query('SELECT * FROM items WHERE id = ANY($1::int[])', [itemIds])).rows.map(x => [x.id, x])
    : []);

  const om = new Map(optIds.length
    ? (await client.query('SELECT * FROM modifier_options WHERE id = ANY($1::int[])', [optIds])).rows.map(x => [x.id, x])
    : []);

  return rawItems.map(li => {
    const it = im.get(Number(li.item_id));
    if (!it || !it.available) throw AppError('item unavailable', 400);
    const qty = Math.min(20, Math.max(1, parseInt(li.qty) || 1));
    const mods = (li.modifier_option_ids || []).slice(0, 12).map(id => {
      const o = om.get(Number(id));
      if (!o || !o.available) throw AppError('modifier unavailable', 400);
      return o;
    });
    return { item: it, qty, mods, note: String(li.note || '').slice(0, 200) };
  });
}

async function insertOrder(tableId, parsed, note, source, userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      'INSERT INTO orders (table_id, status, source, note, opened_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [tableId, 'sent', source, note || null, userId]);
    const orderId = o.rows[0].id;
    for (const l of parsed) {
      const oi = await client.query(
        'INSERT INTO order_items (order_id, item_id, name, price_cents, qty, note, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [orderId, l.item.id, l.item.name, l.item.price_cents, l.qty, l.note || null, userId]);
      for (const m of l.mods) {
        await client.query(
          'INSERT INTO order_item_mods (order_item_id, name, price_cents) VALUES ($1,$2,$3)',
          [oi.rows[0].id, m.name, m.price_cents]);
      }
    }
    await client.query('COMMIT');
    return orderId;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// Records one row per mutating action; `detail` is a plain object (serialised to jsonb by pg).
async function writeAudit(client, { userId, action, entityType, entityId, detail = {} }) {
  await client.query(
    'INSERT INTO audit_log (user_id, action, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [userId || null, action, entityType, entityId, detail]);
}

async function ordersWithItems(where, params, orderBy = 'ORDER BY o.created_at ASC') {
  const oq = await pool.query(
    `SELECT o.*, t.name AS table_name FROM orders o JOIN tables t ON t.id = o.table_id ${where} ${orderBy}`, params);
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
  return orders.map(o => ({
    id: o.id, table: o.table_name, table_id: o.table_id, status: o.status, source: o.source,
    note: o.note, created_at: o.created_at, updated_at: o.updated_at, paid_at: o.paid_at,
    pay_method: o.pay_method, total: cents2rm(totalCents(o)),
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
      id: i.id, item_id: i.item_id, name: i.name, qty: i.qty, price: cents2rm(i.price_cents), note: i.note,
      mods: i.mods.map(m => ({ name: m.name, price: cents2rm(m.price_cents) })),
      voided: !!i.voided_at, void_reason: i.void_reason || null,
    })),
  }));
}

module.exports = { buildOrderItems, insertOrder, ordersWithItems, writeAudit };
