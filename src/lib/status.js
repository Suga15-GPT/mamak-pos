const { AppError } = require('./errors');

/* The closed order statuses, in one place. A closed order is off the floor,
   frees its card, and never changes again (migrations 015, 017 and 019 refuse
   it in the database too; paid -> refunded is the one way out). 'merged' is a
   card whose bill was combined into another card's: its lines, rounds and
   kitchen tickets now live on that bill, and it is neither a sale nor a
   cancellation. Every "is this bill still open?" check reads these. */
const CLOSED_STATUSES = ['paid', 'cancelled', 'refunded', 'merged'];

const isClosed = status => CLOSED_STATUSES.includes(status);

// SQL: the order is still open. `col` is its status column, alias included.
const openSql = (col = 'status') => `${col} NOT IN ('paid','cancelled','refunded','merged')`;

/* The refusal for acting on a closed bill. A merged one says where its items
   went — following later merges to the bill they are on now — so staff know
   which card to open instead. `order` needs status and merged_into_order_id. */
async function closedBillError(client, order, fallback, httpStatus = 409) {
  if (order.status !== 'merged' || !order.merged_into_order_id) return AppError(fallback, httpStatus);
  const r = await client.query(
    `WITH RECURSIVE chain AS (
       SELECT id, merged_into_order_id, 1 AS depth FROM orders WHERE id = $1
       UNION ALL
       SELECT o.id, o.merged_into_order_id, c.depth + 1
         FROM orders o JOIN chain c ON o.id = c.merged_into_order_id
        WHERE c.depth < 20
     )
     SELECT COALESCE('Card ' || cd.number, t.name, 'Order #' || o.id) AS label
       FROM chain c JOIN orders o ON o.id = c.id
       LEFT JOIN cards cd ON cd.id = o.card_id LEFT JOIN tables t ON t.id = o.table_id
      WHERE c.merged_into_order_id IS NULL
      LIMIT 1`, [order.merged_into_order_id]);
  const label = r.rows[0]?.label || `Order #${order.merged_into_order_id}`;
  return Object.assign(AppError(`This bill was combined into ${label} — use ${label}'s bill instead.`, 409), { code: 'merged' });
}

module.exports = { CLOSED_STATUSES, isClosed, openSql, closedBillError };
