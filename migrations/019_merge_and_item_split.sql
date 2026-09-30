-- Combining cards merges their bills, and a bill can be split by items.
--
-- Combine used to group cards (bill_groups) while each kept its own order.
-- The owner's rule is simpler: on Card 1, Combine -> Card 4 moves Card 4's
-- rounds, lines and kitchen tickets onto Card 1's bill there and then, and
-- Card 4 is free for the next group. Existing bill groups keep working; new
-- combines no longer create them.
--
-- Card 4's emptied order is closed with its own terminal status, 'merged'.
-- It is not a sale (sales read 'paid'/'refunded') and not a cancellation
-- ('cancelled'), so no report has to learn to leave it out, and the row stays:
-- its id, its idempotency key (a retried create still finds it rather than
-- opening Card 4 again with the same food), its audit trail and its print
-- jobs all keep pointing at something. Forward-only: nothing here rewrites an
-- existing row.

/* ===== 'merged' is a closed status ===== */

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('sent','preparing','ready','served','paid','cancelled','refunded','merged'));

-- Where a merged order's lines went.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merged_into_order_id INT REFERENCES orders(id);

-- A merged order frees its card at once, exactly like a paid one.
DROP INDEX IF EXISTS one_open_order_per_card;
CREATE UNIQUE INDEX one_open_order_per_card
  ON orders (card_id) WHERE status NOT IN ('paid','cancelled','refunded','merged');
DROP INDEX IF EXISTS one_open_order_per_table;
CREATE UNIQUE INDEX one_open_order_per_table
  ON orders (table_id) WHERE status NOT IN ('paid','cancelled','refunded','merged');

-- 015/017's safety net, with 'merged' as closed as the other three: it can
-- never change status again, and its location, money and merged_into_order_id
-- are frozen. paid -> refunded is still the only way out of a closed status.
CREATE OR REPLACE FUNCTION orders_closed_stays_closed() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('paid', 'cancelled', 'refunded', 'merged') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'paid' AND NEW.status = 'refunded') THEN
      RAISE EXCEPTION 'order % is % and cannot become %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.card_id IS DISTINCT FROM OLD.card_id
       OR NEW.table_id IS DISTINCT FROM OLD.table_id
       OR NEW.order_type IS DISTINCT FROM OLD.order_type THEN
      RAISE EXCEPTION 'order % is % and cannot be moved or change type', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
       OR NEW.service_charge_cents IS DISTINCT FROM OLD.service_charge_cents
       OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents
       OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents
       OR NEW.rounding_cents IS DISTINCT FROM OLD.rounding_cents
       OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
       OR NEW.tax_rate_bp IS DISTINCT FROM OLD.tax_rate_bp
       OR NEW.svc_rate_bp IS DISTINCT FROM OLD.svc_rate_bp THEN
      RAISE EXCEPTION 'order % is % and its bill cannot change', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.merged_into_order_id IS DISTINCT FROM OLD.merged_into_order_id THEN
      RAISE EXCEPTION 'order % is % and where it was merged cannot change', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

/* ===== a round remembers the card a merge brought it from ===== */

-- NULL on every round ordered on its own bill. A merged round keeps the card,
-- order and round number it was first ordered as, so the kitchen and the till
-- can say "Card 1 (from 4) · Round 1", and "Separate Card 4" knows exactly
-- which rounds go back. merged_at is when it joined the bill it is on now.
ALTER TABLE order_sends
  ADD COLUMN IF NOT EXISTS merged_from_card_id  INT REFERENCES cards(id),
  ADD COLUMN IF NOT EXISTS merged_from_order_id INT REFERENCES orders(id),
  ADD COLUMN IF NOT EXISTS merged_from_seq_no   INT,
  ADD COLUMN IF NOT EXISTS merged_at            TIMESTAMPTZ;

/* ===== split by items ===== */

-- The lines a "Split by items" share paid for, so the next share knows what
-- is still to pay and the last one takes whatever is left. NULL on every
-- other payment. order_items rows are never deleted (a void only marks one).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS item_ids INT[];

/* order_items.seat stays (forward-only); the till no longer sets it. */
