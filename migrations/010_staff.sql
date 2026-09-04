ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS must_change_pin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_changed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- a deactivated "Ali" must not block hiring a new Ali, so the uniqueness
-- constraint applies only to active staff, and matches login's case handling
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_name_active
  ON users (lower(name)) WHERE active;

-- the seeded admin is still on the default PIN until proven otherwise
UPDATE users SET must_change_pin = true WHERE pin_changed_at IS NULL;
