ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS opened_by INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS paid_by   INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS closed_by INT REFERENCES users(id);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS added_by    INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by   INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     INT REFERENCES users(id),
  action      TEXT NOT NULL,          -- order.create | order.append | order.void_line
                                      -- order.status | order.pay | order.cancel
                                      -- discount.apply | shift.open | shift.close
  entity_type TEXT NOT NULL,
  entity_id   INT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);

-- The unique index below assumes at most one open order per table. If this
-- database already has live duplicates (from before this constraint existed),
-- keep the most recently created open order per table and cancel the rest,
-- leaving an audit trail, before the index is created.
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT id, table_id FROM (
      SELECT id, table_id,
             row_number() OVER (PARTITION BY table_id ORDER BY created_at DESC, id DESC) AS rn
      FROM orders
      WHERE status NOT IN ('paid', 'cancelled')
    ) ranked
    WHERE rn > 1
  LOOP
    UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = dup.id;
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, detail)
      VALUES (NULL, 'order.cancel', 'order', dup.id,
        jsonb_build_object('reason', 'auto-cancelled: duplicate open order for table', 'table_id', dup.table_id));
  END LOOP;
END $$;

-- one open order per table, enforced by the database, not by the client
CREATE UNIQUE INDEX IF NOT EXISTS one_open_order_per_table
  ON orders (table_id) WHERE status NOT IN ('paid','cancelled');
