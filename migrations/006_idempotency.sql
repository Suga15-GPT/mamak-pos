ALTER TABLE orders      ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_idem
  ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_items_idem
  ON order_items (idempotency_key) WHERE idempotency_key IS NOT NULL;
