const { pool } = require('../db');
const { AppError } = require('../lib/errors');

/* ===== kitchen rounds =====
   A "round" (order_sends) is one batch of items sent to preparation. Every
   order_items row belongs to exactly one round. Preparation state lives on a
   per-station ticket (order_send_tickets), never on the dining order — which is
   the whole point: round 2 starts at 'sent' no matter what round 1 is doing.

   orders.status is kept as a *derived* rollup of those tickets so payments,
   reports, the one-open-order-per-table index and the Z report all keep working
   against the column they already read. */

const TICKET_STATUSES = ['sent', 'preparing', 'ready', 'served'];

// Operational priority (master spec §14): the floor needs to know the most
// urgent thing happening at this table, not an average.
const ROLLUP_ORDER = ['sent', 'preparing', 'ready', 'served'];

const TERMINAL_ORDER_STATUSES = ['paid', 'cancelled', 'refunded'];

// Same shape as routes/orders.js's TRANSITIONS, applied one station ticket at a
// time. Backward moves exist so a mis-tap is recoverable.
const TICKET_TRANSITIONS = {
  sent: ['preparing', 'cancelled'],
  preparing: ['ready', 'sent', 'cancelled'],
  ready: ['served', 'preparing'],
  served: ['ready'],
};
const BACKWARD_TICKET = new Set(['preparing>sent', 'ready>preparing', 'served>ready']);

async function listStations(client = pool) {
  const r = await client.query('SELECT code, name, sort, active FROM prep_stations ORDER BY sort, code');
  return r.rows;
}

/* Opens the next round on an order. seq_no is allocated from the rounds that
   already exist rather than a counter column, so a concurrent double-submit
   collides on the (order_id, seq_no) unique index instead of silently
   producing two "round 2"s. */
async function createSend(client, orderId, { source = 'staff', userId = null, approvalState = 'approved', publicRef = null } = {}) {
  const r = await client.query(
    `INSERT INTO order_sends (order_id, seq_no, source, sent_by, approval_state, public_ref)
     VALUES ($1, COALESCE((SELECT max(seq_no) FROM order_sends WHERE order_id = $1), 0) + 1, $2, $3, $4, $5)
     RETURNING id, seq_no`,
    [orderId, source, userId, approvalState, publicRef]);
  return r.rows[0];
}

/* One ticket per distinct station in the round. A round awaiting staff approval
   deliberately gets no tickets at all — nothing reaches a station display or a
   printer until someone accepts it. */
async function openTickets(client, sendId, stationCodes) {
  const codes = [...new Set(stationCodes)].filter(Boolean);
  for (const code of codes) {
    await client.query(
      'INSERT INTO order_send_tickets (send_id, station_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [sendId, code]);
  }
  const r = await client.query('SELECT * FROM order_send_tickets WHERE send_id = $1 ORDER BY station_code', [sendId]);
  return r.rows;
}

/* Recomputes orders.status from the order's live station tickets. Terminal
   statuses are never overwritten — a paid order does not reopen because a
   ticket was corrected afterwards. An order with no live tickets (every round
   still awaiting approval) reads as 'sent': it is open, and nothing is
   cooking. */
async function deriveOrderStatus(client, orderId) {
  const cur = await client.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  if (!cur.rows[0]) return null;
  if (TERMINAL_ORDER_STATUSES.includes(cur.rows[0].status)) return cur.rows[0].status;

  const r = await client.query(
    `SELECT DISTINCT t.status
       FROM order_send_tickets t
       JOIN order_sends s ON s.id = t.send_id
      WHERE s.order_id = $1 AND s.approval_state = 'approved' AND t.status <> 'cancelled'`, [orderId]);
  const live = new Set(r.rows.map(x => x.status));
  const next = ROLLUP_ORDER.find(st => live.has(st)) || 'sent';
  if (next !== cur.rows[0].status) {
    await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [next, orderId]);
  }
  return next;
}

/* The status of the station ticket a given order line is actually on — what
   "has the kitchen started this yet?" means once one bill can hold several
   rounds at different stages. */
async function ticketStatusForLine(client, orderItemId) {
  const r = await client.query(
    `SELECT t.status
       FROM order_items oi
       JOIN order_send_tickets t ON t.send_id = oi.send_id AND t.station_code = oi.station_code
      WHERE oi.id = $1`, [orderItemId]);
  return r.rows[0]?.status || null;
}

function ticketTransitionError(from, to, role) {
  if (!(TICKET_TRANSITIONS[from] || []).includes(to)) return AppError(`cannot go ${from} -> ${to}`, 400);
  // Kitchen only ever moves a ticket forward; undoing a mis-tap is a
  // staff/admin correction.
  if (BACKWARD_TICKET.has(`${from}>${to}`) && role === 'kitchen') return AppError('staff/admin only', 403);
  return null;
}

const STAMP = {
  preparing: ['preparing_at', 'preparing_by'],
  ready: ['ready_at', 'ready_by'],
  served: ['served_at', 'served_by'],
};

/* Advances one station ticket and re-derives its order's rollup. Returns the
   order id so the caller can publish/print against it. */
async function advanceTicket(ticketId, status, { userId, role }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(
      `SELECT t.*, s.order_id FROM order_send_tickets t JOIN order_sends s ON s.id = t.send_id
        WHERE t.id = $1 FOR UPDATE OF t`, [ticketId]);
    if (!t.rows[0]) throw AppError('ticket not found', 404);
    const err = ticketTransitionError(t.rows[0].status, status, role);
    if (err) throw err;

    const stamp = STAMP[status];
    if (stamp) {
      await client.query(
        `UPDATE order_send_tickets SET status = $1, ${stamp[0]} = now(), ${stamp[1]} = $2 WHERE id = $3`,
        [status, userId || null, ticketId]);
    } else {
      await client.query('UPDATE order_send_tickets SET status = $1 WHERE id = $2', [status, ticketId]);
    }
    const orderStatus = await deriveOrderStatus(client, t.rows[0].order_id);
    await client.query('COMMIT');
    return { order_id: t.rows[0].order_id, send_id: t.rows[0].send_id, from: t.rows[0].status, to: status, order_status: orderStatus };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* Attaches rounds (with their tickets and line ids) to already-loaded orders,
   in one round trip regardless of how many orders were passed. */
async function attachSends(orders) {
  if (!orders.length) return orders;
  const ids = orders.map(o => o.id);
  const sends = (await pool.query(
    `SELECT s.*, u.name AS sent_by_name, d.name AS decided_by_name
       FROM order_sends s
       LEFT JOIN users u ON u.id = s.sent_by
       LEFT JOIN users d ON d.id = s.decided_by
      WHERE s.order_id = ANY($1::int[]) ORDER BY s.order_id, s.seq_no`, [ids])).rows;
  const sendIds = sends.map(s => s.id);
  const tickets = sendIds.length ? (await pool.query(
    `SELECT t.*, ps.name AS station_name,
            pu.name AS preparing_by_name, ru.name AS ready_by_name, su.name AS served_by_name
       FROM order_send_tickets t
       JOIN prep_stations ps ON ps.code = t.station_code
       LEFT JOIN users pu ON pu.id = t.preparing_by
       LEFT JOIN users ru ON ru.id = t.ready_by
       LEFT JOIN users su ON su.id = t.served_by
      WHERE t.send_id = ANY($1::int[]) ORDER BY ps.sort, t.station_code`, [sendIds])).rows : [];

  const byOrder = new Map();
  const bySend = new Map();
  sends.forEach(s => {
    const shaped = {
      id: s.id, seq_no: s.seq_no, source: s.source, sent_at: s.sent_at,
      sent_by: s.sent_by, sent_by_name: s.sent_by_name || null,
      approval_state: s.approval_state, decided_at: s.decided_at, decided_by_name: s.decided_by_name || null,
      tickets: [], item_ids: [],
    };
    bySend.set(s.id, shaped);
    if (!byOrder.has(s.order_id)) byOrder.set(s.order_id, []);
    byOrder.get(s.order_id).push(shaped);
  });
  tickets.forEach(t => bySend.get(t.send_id)?.tickets.push({
    id: t.id, station: t.station_code, station_name: t.station_name, status: t.status,
    preparing_at: t.preparing_at, preparing_by_name: t.preparing_by_name || null,
    ready_at: t.ready_at, ready_by_name: t.ready_by_name || null,
    served_at: t.served_at, served_by_name: t.served_by_name || null,
  }));

  orders.forEach(o => {
    o.sends = byOrder.get(o.id) || [];
    const byId = new Map(o.sends.map(s => [s.id, s]));
    (o.items || []).forEach(li => {
      const s = byId.get(li.send_id);
      if (s) s.item_ids.push(li.id);
      // The line's own round/station state, so the bill view can say
      // "Round 1 · Served" per line without a second lookup.
      li.round = s ? s.seq_no : null;
      li.round_status = s ? (s.tickets.find(t => t.station === li.station)?.status || null) : null;
    });
  });
  return orders;
}

/* The kitchen/drinks display: live tickets for one station, oldest first, with
   just the lines that station is responsible for. Recently-served tickets are
   included (bounded to the last two hours) so the display can show a "recently
   served" column without a second query; the caller decides how many to keep. */
async function listStationTickets(stationCode) {
  const r = await pool.query(
    `SELECT t.id, t.status, t.station_code, t.preparing_at, t.ready_at, t.served_at,
            s.id AS send_id, s.seq_no, s.sent_at, s.source, s.approval_state,
            u.name AS sent_by_name,
            o.id AS order_id, o.order_type, o.status AS order_status, tb.name AS table_name
       FROM order_send_tickets t
       JOIN order_sends s ON s.id = t.send_id
       JOIN orders o ON o.id = s.order_id
       LEFT JOIN tables tb ON tb.id = o.table_id
       LEFT JOIN users u ON u.id = s.sent_by
      WHERE t.station_code = $1
        AND s.approval_state = 'approved'
        AND t.status <> 'cancelled'
        AND o.status NOT IN ('cancelled','refunded')
        AND (t.status <> 'served' OR t.served_at > now() - interval '2 hours')
      ORDER BY s.sent_at ASC`, [stationCode]);
  if (!r.rows.length) return [];

  const sendIds = [...new Set(r.rows.map(x => x.send_id))];
  const items = (await pool.query(
    `SELECT oi.id, oi.send_id, oi.station_code, oi.name, oi.qty, oi.note, oi.voided_at, oi.void_reason
       FROM order_items oi WHERE oi.send_id = ANY($1::int[]) ORDER BY oi.id`, [sendIds])).rows;
  const modRows = items.length ? (await pool.query(
    'SELECT order_item_id, name FROM order_item_mods WHERE order_item_id = ANY($1::int[]) ORDER BY id',
    [items.map(i => i.id)])).rows : [];
  const modsByItem = new Map();
  modRows.forEach(m => { if (!modsByItem.has(m.order_item_id)) modsByItem.set(m.order_item_id, []); modsByItem.get(m.order_item_id).push(m.name); });

  const tickets = r.rows.map(row => ({
    id: row.id, status: row.status, station: row.station_code,
    send_id: row.send_id, round: row.seq_no, sent_at: row.sent_at, source: row.source,
    sent_by_name: row.sent_by_name || null,
    order_id: row.order_id, order_type: row.order_type, order_status: row.order_status,
    table: row.table_name || null,
    is_addon: row.seq_no > 1,
    items: items
      .filter(i => i.send_id === row.send_id && i.station_code === row.station_code)
      .map(i => ({
        id: i.id, name: i.name, qty: i.qty, note: i.note,
        voided: !!i.voided_at, void_reason: i.void_reason || null,
        mods: modsByItem.get(i.id) || [],
      })),
  })).filter(t => t.items.length);

  return tickets;
}

/* Rounds still waiting for a staff decision, for the QR approval queue. */
async function listPendingSends() {
  const r = await pool.query(
    `SELECT s.id, s.seq_no, s.sent_at, s.source, s.order_id, o.order_type, tb.name AS table_name
       FROM order_sends s
       JOIN orders o ON o.id = s.order_id
       LEFT JOIN tables tb ON tb.id = o.table_id
      WHERE s.approval_state = 'pending' AND o.status NOT IN ('paid','cancelled','refunded')
      ORDER BY s.sent_at ASC LIMIT 100`);
  if (!r.rows.length) return [];
  const items = (await pool.query(
    `SELECT send_id, id, name, qty, note, station_code FROM order_items WHERE send_id = ANY($1::int[]) ORDER BY id`,
    [r.rows.map(x => x.id)])).rows;
  return r.rows.map(s => ({
    id: s.id, round: s.seq_no, sent_at: s.sent_at, source: s.source,
    order_id: s.order_id, order_type: s.order_type, table: s.table_name || null,
    items: items.filter(i => i.send_id === s.id).map(i => ({ id: i.id, name: i.name, qty: i.qty, note: i.note, station: i.station_code })),
  }));
}

module.exports = {
  TICKET_STATUSES, TERMINAL_ORDER_STATUSES, TICKET_TRANSITIONS, BACKWARD_TICKET,
  listStations, createSend, openTickets, deriveOrderStatus, ticketStatusForLine,
  ticketTransitionError, advanceTicket, attachSends, listStationTickets, listPendingSends,
};
