-- Clear sales data moves bills (and the idempotency keys stored on them) into
-- an archive schema. A till can still hold a write that landed before the
-- clear but whose answer it never got; replayed afterwards, its key would no
-- longer be found and the same food would open a second bill. The keys stay
-- behind here, so such a replay is answered "already done".
CREATE TABLE IF NOT EXISTS archived_idempotency_keys (
  key         TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('order', 'item')),
  order_id    INTEGER NOT NULL,
  archive     TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
