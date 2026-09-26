-- An existing shop is one with users, not one with orders.
--
-- 016 treated a database as an existing shop only when it already had an
-- order. A shop that was installed and set up but had not taken an order yet
-- got no rows, so its admin was sent through the mandatory setup wizard after
-- upgrading. Users are the right test: migrations run before seeding
-- (src/seed.js runs migrate() first), so a fresh install has no users yet,
-- and an installed shop always has at least its admin.
--
-- Forward-only: 016 may already have run on databases of the setup branch,
-- so it is corrected here rather than edited. Like 016 it only inserts rows
-- that are missing (ON CONFLICT DO NOTHING): no switch a shop has set, and no
-- finished setup, changes. A setup-branch database whose admin never finished
-- the wizard is treated as an existing shop too: every module on and no
-- wizard, as before feature modules; the wizard stays in Admin -> Features &
-- setup.
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
 WHERE EXISTS (SELECT 1 FROM users)
ON CONFLICT (key) DO NOTHING;
