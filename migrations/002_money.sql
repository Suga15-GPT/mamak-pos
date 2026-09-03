ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS subtotal_cents       INT,
  ADD COLUMN IF NOT EXISTS service_charge_cents INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_cents            INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_cents       INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rounding_cents       INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cents          INT,
  ADD COLUMN IF NOT EXISTS tax_rate_bp          INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS svc_rate_bp          INT NOT NULL DEFAULT 0;

-- backfill already-paid orders so historical rows stay reproducible
UPDATE orders SET subtotal_cents = pay_total_cents,
                  total_cents    = pay_total_cents
 WHERE status = 'paid' AND total_cents IS NULL;

INSERT INTO settings (key, value) VALUES ('tax_rate_bp','600'), ('svc_rate_bp','0')
  ON CONFLICT (key) DO NOTHING;
