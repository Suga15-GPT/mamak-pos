-- Master redesign, phase B + C: what full Admin CRUD needs from the schema.

-- A table that is no longer in use (a booth removed in a refit) must not
-- disappear: old bills still name it, and its QR token must stay resolvable
-- long enough for the sticker to be thrown away. Deactivate, never delete.
ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sort   INT     NOT NULL DEFAULT 0;

-- Existing tables keep their id order as their display order.
UPDATE tables SET sort = id WHERE sort = 0;

-- Only an active table's name has to be unique — reusing "T4" after the old T4
-- was retired is a normal thing for a restaurant to do.
ALTER TABLE tables DROP CONSTRAINT IF EXISTS tables_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tables_name_active ON tables (lower(name)) WHERE active;

-- Food options are presented to staff as an ordered list, so they need an order.
ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS sort INT NOT NULL DEFAULT 0;
UPDATE modifier_groups SET sort = id WHERE sort = 0;

-- Recorded by scripts/backup.sh after a successful run, so Admin -> System can
-- report a real last-backup time instead of claiming health it cannot see.
INSERT INTO settings (key, value) VALUES ('last_backup_at', '') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('last_backup_note', '') ON CONFLICT (key) DO NOTHING;
