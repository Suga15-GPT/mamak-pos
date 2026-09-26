-- Switchable feature modules and the first-run setup wizard.
--
-- A shop that has already taken orders is upgraded with every module on and
-- setup marked done, so nothing it uses disappears and nobody is sent through
-- a wizard in the middle of service. A fresh database gets neither row: the
-- modules read as on (a missing feature_* row means on) and the missing
-- setup_completed is what sends the first admin through the wizard.
--
-- Settings rows only. No data is added to, altered in or removed from any
-- other table.

INSERT INTO settings (key, value)
SELECT k, '1'
  FROM unnest(ARRAY[
    'feature_kitchen', 'feature_stations', 'feature_printing', 'feature_shifts', 'feature_discounts',
    'feature_refunds', 'feature_split_combine', 'feature_qr', 'feature_voice', 'feature_dashboard',
    'setup_completed'
  ]) AS k
 WHERE EXISTS (SELECT 1 FROM orders)
ON CONFLICT (key) DO NOTHING;
