ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Issued once at login (phase 11) and compared with crypto.timingSafeEqual on
-- every mutating request. Nullable: a session created before this migration
-- simply has no CSRF token and fails that check until its owner logs in again.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT;
