CREATE TABLE IF NOT EXISTS payments (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method       TEXT NOT NULL CHECK (method IN ('Cash','Card','DuitNow/eWallet')),
  amount_cents INT  NOT NULL CHECK (amount_cents > 0),
  tendered_cents INT,                    -- cash only, for change due
  taken_by     INT REFERENCES users(id),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);

CREATE TABLE IF NOT EXISTS discounts (
  id            SERIAL PRIMARY KEY,
  order_id      INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('percent','amount','comp')),
  value         INT NOT NULL,            -- basis points, or cents, or 0 for comp
  amount_cents  INT NOT NULL,            -- resolved cash value, snapshotted
  reason        TEXT NOT NULL,
  approved_by   INT NOT NULL REFERENCES users(id),
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS seat INT;

-- backfill existing paid orders into the new table
INSERT INTO payments (order_id, method, amount_cents, taken_by, at)
SELECT id, pay_method, COALESCE(total_cents, pay_total_cents), paid_by, paid_at
  FROM orders WHERE status='paid' AND pay_method IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id);
