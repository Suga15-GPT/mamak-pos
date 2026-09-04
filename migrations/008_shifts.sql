CREATE TABLE IF NOT EXISTS shifts (
  id                SERIAL PRIMARY KEY,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by         INT NOT NULL REFERENCES users(id),
  float_cents       INT NOT NULL DEFAULT 0,
  closed_at         TIMESTAMPTZ,
  closed_by         INT REFERENCES users(id),
  counted_cents     INT,
  expected_cents    INT,
  variance_cents    INT,
  note              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts ((true)) WHERE closed_at IS NULL;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS shift_id INT REFERENCES shifts(id);
ALTER TABLE orders   ADD COLUMN IF NOT EXISTS shift_id INT REFERENCES shifts(id);

CREATE TABLE IF NOT EXISTS cash_movements (
  id         SERIAL PRIMARY KEY,
  shift_id   INT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('payin','payout')),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  reason     TEXT NOT NULL,
  user_id    INT NOT NULL REFERENCES users(id),
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 05 backfilled every paid order into `payments`; reports.js and
-- billing.js no longer read or write these legacy columns, so they can go.
ALTER TABLE orders DROP COLUMN IF EXISTS pay_method;
ALTER TABLE orders DROP COLUMN IF EXISTS pay_total_cents;
