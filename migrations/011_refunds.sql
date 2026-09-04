-- Phase 12: revenue recognition at settlement, and refunds.

-- orders.shift_id (kept, unchanged) is stamped when the order is *opened*.
-- closed_shift_id is stamped when it *settles* (payment, or a void/discount
-- that lands the total on what's already paid) — the sales side of a Z report
-- now reads this column so it agrees with the cash side, which was already
-- scoped by payments.shift_id (the shift that actually took the money).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS closed_shift_id INT REFERENCES shifts(id);

-- Snapshotted at close(), same reasoning as shifts.expected_cents/counted_cents/
-- variance_cents (migration 008): a still-open order's count/value at the
-- moment of close, so a Z report stays byte-identical no matter when it's
-- re-read later, even after that order eventually settles in a future shift.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS carried_forward_count INT;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS carried_forward_cents INT;

-- Backfill every already-paid order from the shift of its last payment. An
-- order closed by a 100% comp has no payment row at all, so it can't be
-- backfilled this way — it simply carries no closed_shift_id, same as any
-- other pre-phase-12 gap in a column that didn't used to exist.
UPDATE orders o SET closed_shift_id = last_pay.shift_id
FROM (
  SELECT DISTINCT ON (order_id) order_id, shift_id
  FROM payments
  ORDER BY order_id, at DESC
) last_pay
WHERE o.id = last_pay.order_id AND o.status = 'paid' AND o.closed_shift_id IS NULL;

CREATE TABLE IF NOT EXISTS refunds (
  id           SERIAL PRIMARY KEY,
  payment_id   INT NOT NULL REFERENCES payments(id),
  order_id     INT NOT NULL REFERENCES orders(id),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  reason       TEXT NOT NULL,
  approved_by  INT NOT NULL REFERENCES users(id),
  shift_id     INT REFERENCES shifts(id),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds (payment_id);

-- A fully-refunded order is done, distinctly from 'paid' — the till gave money
-- back, which a Z report needs to be able to tell apart from a sale that
-- simply stands.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('sent','preparing','ready','served','paid','cancelled','refunded'));

-- one_open_order_per_table (migration 003) must free a table once its order is
-- refunded, exactly as it already does for 'paid'/'cancelled' — otherwise a
-- fully-refunded table could never take a new order again.
DROP INDEX IF EXISTS one_open_order_per_table;
CREATE UNIQUE INDEX one_open_order_per_table ON orders (table_id) WHERE status NOT IN ('paid','cancelled','refunded');
