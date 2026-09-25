-- Card mode: numbered customer cards replace tables as the way a dine-in order
-- is identified, and several cards can be combined into one bill.
--
-- A mamak's seating is not a fixed floor plan: customers sit where there is
-- room, share tables, and move. A numbered card handed over at the counter is
-- what actually follows a party around. Tables are NOT dropped — old bills name
-- their table, and a table order still open at deploy time must stay visible
-- and payable until it closes.

/* ===== cards ===== */

CREATE TABLE IF NOT EXISTS cards (
  id       SERIAL PRIMARY KEY,
  number   INT NOT NULL UNIQUE CHECK (number > 0),
  active   BOOLEAN NOT NULL DEFAULT true,
  -- Same role a table's qr_token had: the entire identity of a customer phone
  -- that scanned this card's QR.
  qr_token TEXT NOT NULL UNIQUE
);

INSERT INTO cards (number, qr_token)
SELECT n, substr(md5(random()::text || clock_timestamp()::text || n::text), 1, 16)
  FROM generate_series(1, 50) n
ON CONFLICT (number) DO NOTHING;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_id INT REFERENCES cards(id);

-- A card is in use exactly while it has an open order, and frees itself the
-- moment that order closes — the database, not application code, is what
-- stops two tills opening the same card.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_order_per_card
  ON orders (card_id) WHERE status NOT IN ('paid','cancelled','refunded');

-- A dine-in order names a card (new) or a table (history, and table orders
-- still open at upgrade time); a takeaway names neither.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_table_matches_type;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_location_matches_type;
ALTER TABLE orders ADD CONSTRAINT orders_location_matches_type CHECK (
  (order_type = 'dine_in'  AND (card_id IS NOT NULL OR table_id IS NOT NULL)) OR
  (order_type = 'takeaway' AND card_id IS NULL AND table_id IS NULL)
);

/* ===== combined bills ===== */

-- Nothing moves between orders when cards are combined: each card keeps its
-- own order, rounds, tickets and per-order tax. The group only says "these are
-- settled together".
CREATE TABLE IF NOT EXISTS bill_groups (
  id         SERIAL PRIMARY KEY,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at  TIMESTAMPTZ
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_group_id INT REFERENCES bill_groups(id);
CREATE INDEX IF NOT EXISTS idx_orders_bill_group ON orders (bill_group_id) WHERE bill_group_id IS NOT NULL;

/* ===== QR mode ===== */

-- qr_ordering_enabled was a plain on/off. It becomes a mode; 'shop' (one
-- poster, customer types their card number) is new and starts unused.
INSERT INTO settings (key, value)
SELECT 'qr_mode', CASE WHEN value = '0' THEN 'off' ELSE 'per_card' END
  FROM settings WHERE key = 'qr_ordering_enabled'
ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('qr_mode', 'per_card') ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value)
VALUES ('qr_shop_token', substr(md5(random()::text || clock_timestamp()::text), 1, 16))
ON CONFLICT (key) DO NOTHING;
