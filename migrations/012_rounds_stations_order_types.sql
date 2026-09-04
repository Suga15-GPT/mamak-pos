-- Master redesign, phase A + B schema.
--
-- Three separate concepts were previously collapsed into `orders.status`:
--   1. the customer's bill (the dining order),
--   2. one batch of items sent to preparation (a "round"),
--   3. how far a preparation station has got with that batch.
-- Collapsing them is what made an add-on inherit the original order's `served`
-- status and appear served the moment it was entered. This migration splits
-- (2) and (3) out; `orders.status` stays, but becomes a derived rollup of the
-- station tickets below (see src/services/rounds.js) so every existing
-- payment/report/index keeps working untouched.

/* ===== preparation stations ===== */

CREATE TABLE IF NOT EXISTS prep_stations (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  sort    INT  NOT NULL DEFAULT 0,
  active  BOOLEAN NOT NULL DEFAULT true,
  -- Which configured printer role this station's chits go to. 'bar' already
  -- exists as a printer role (migration 007) and is where a drinks station's
  -- chits belong; printing falls back to the kitchen printer when no printer
  -- with the station's own role is configured, so a shop with one printer
  -- keeps working.
  printer_role TEXT NOT NULL DEFAULT 'kitchen' CHECK (printer_role IN ('kitchen','bar','receipt'))
);

INSERT INTO prep_stations (code, name, sort, printer_role) VALUES
  ('kitchen', 'Kitchen', 0, 'kitchen'),
  ('drinks',  'Drinks',  1, 'bar')
ON CONFLICT (code) DO NOTHING;

-- Which station prepares this menu item. Defaulting to 'kitchen' preserves
-- today's behaviour exactly: every existing item keeps routing to the kitchen
-- printer/display until an admin says otherwise.
ALTER TABLE items ADD COLUMN IF NOT EXISTS station_code TEXT NOT NULL DEFAULT 'kitchen'
  REFERENCES prep_stations(code);

-- Drinks are the one routing an existing mamak menu obviously wants on day one,
-- and the seeded categories name them unambiguously. Only touches rows that are
-- still on the default, so re-running against a hand-configured menu is a no-op.
UPDATE items SET station_code = 'drinks'
 WHERE station_code = 'kitchen'
   AND category_id IN (SELECT id FROM categories WHERE name IN ('Minuman Panas', 'Minuman Ais'));

/* ===== kitchen rounds ===== */

CREATE TABLE IF NOT EXISTS order_sends (
  id             SERIAL PRIMARY KEY,
  order_id       INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq_no         INT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','qr')),
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by        INT REFERENCES users(id),
  -- 'approved' is the default because QR orders go straight to the kitchen
  -- unless an admin turns approval on; a staff-entered round is always
  -- approved by definition.
  approval_state TEXT NOT NULL DEFAULT 'approved' CHECK (approval_state IN ('pending','approved','rejected')),
  decided_at     TIMESTAMPTZ,
  decided_by     INT REFERENCES users(id),
  -- Opaque handle a QR customer can poll for their own round's progress
  -- without ever being handed an order id.
  public_ref     TEXT UNIQUE,
  UNIQUE (order_id, seq_no)
);
CREATE INDEX IF NOT EXISTS idx_order_sends_order ON order_sends (order_id, seq_no);

-- One row per (round, station): the round is what the customer and the floor
-- see, the ticket is what one station works. A round with a curry and a teh
-- tarik makes two tickets and one bill.
CREATE TABLE IF NOT EXISTS order_send_tickets (
  id            SERIAL PRIMARY KEY,
  send_id       INT NOT NULL REFERENCES order_sends(id) ON DELETE CASCADE,
  station_code  TEXT NOT NULL REFERENCES prep_stations(code),
  status        TEXT NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent','preparing','ready','served','cancelled')),
  preparing_at  TIMESTAMPTZ, preparing_by INT REFERENCES users(id),
  ready_at      TIMESTAMPTZ, ready_by     INT REFERENCES users(id),
  served_at     TIMESTAMPTZ, served_by    INT REFERENCES users(id),
  UNIQUE (send_id, station_code)
);
CREATE INDEX IF NOT EXISTS idx_send_tickets_status ON order_send_tickets (status);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS send_id      INT REFERENCES order_sends(id),
  -- Snapshot, same rule as name/price_cents: moving Teh Tarik to another
  -- station tomorrow must not rewrite where yesterday's order was cooked.
  ADD COLUMN IF NOT EXISTS station_code TEXT NOT NULL DEFAULT 'kitchen';
CREATE INDEX IF NOT EXISTS idx_order_items_send ON order_items (send_id);

-- A chit belongs to one round at one station; a failed job can then be retried
-- as exactly the ticket it was, and the jobs list can say "Table 3 · Round 2 ·
-- Kitchen" instead of just an order id.
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS send_id      INT REFERENCES order_sends(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS station_code TEXT,
  -- Set when this job is a retry of an earlier one, so a reprint is never
  -- mistaken for a second genuine ticket.
  ADD COLUMN IF NOT EXISTS retry_of     INT REFERENCES print_jobs(id) ON DELETE SET NULL;

/* ===== order types ===== */

-- Takeaway was previously faked as a table called "Takeaway", which made it a
-- single-slot resource (one takeaway order at a time, restaurant-wide) and
-- unreportable. A takeaway order now simply has no table.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'dine_in';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_check CHECK (order_type IN ('dine_in','takeaway'));
ALTER TABLE orders ALTER COLUMN table_id DROP NOT NULL;

-- A dine-in order must name a table; a takeaway order must not.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_table_matches_type;
ALTER TABLE orders ADD CONSTRAINT orders_table_matches_type CHECK (
  (order_type = 'dine_in'  AND table_id IS NOT NULL) OR
  (order_type = 'takeaway' AND table_id IS NULL)
);

-- one_open_order_per_table (migration 003/011) indexes table_id; NULLs are
-- distinct in a Postgres unique index, so any number of takeaway orders can be
-- open at once, which is the point.

/* ===== backfill ===== */

-- Every existing order becomes round 1, carrying that order's own source and
-- opener, so history reads the same way new orders will.
INSERT INTO order_sends (order_id, seq_no, source, sent_at, sent_by)
SELECT o.id, 1, o.source, o.created_at, o.opened_by
  FROM orders o
 WHERE NOT EXISTS (SELECT 1 FROM order_sends s WHERE s.order_id = o.id);

UPDATE order_items oi SET send_id = s.id
  FROM order_sends s
 WHERE s.order_id = oi.order_id AND s.seq_no = 1 AND oi.send_id IS NULL;

UPDATE order_items oi SET station_code = i.station_code
  FROM items i WHERE i.id = oi.item_id AND oi.station_code = 'kitchen';

-- Round 1's ticket inherits the order's current kitchen state, so an order the
-- restaurant is mid-way through when this deploys does not jump backwards.
-- A closed order (paid/cancelled/refunded) has no live preparation state left:
-- 'served' is the honest terminal reading of a bill that has already been
-- settled or written off.
INSERT INTO order_send_tickets (send_id, station_code, status)
SELECT s.id, 'kitchen',
       CASE WHEN o.status IN ('sent','preparing','ready','served') THEN o.status ELSE 'served' END
  FROM order_sends s JOIN orders o ON o.id = s.order_id
 WHERE NOT EXISTS (SELECT 1 FROM order_send_tickets t WHERE t.send_id = s.id)
ON CONFLICT DO NOTHING;

-- A pre-existing order whose lines span stations gets the extra station's
-- ticket too, at the same state, so nothing is invisible to a station display.
INSERT INTO order_send_tickets (send_id, station_code, status)
SELECT DISTINCT oi.send_id, oi.station_code,
       CASE WHEN o.status IN ('sent','preparing','ready','served') THEN o.status ELSE 'served' END
  FROM order_items oi
  JOIN order_sends s ON s.id = oi.send_id
  JOIN orders o ON o.id = s.order_id
 WHERE oi.send_id IS NOT NULL
ON CONFLICT DO NOTHING;

/* ===== QR ordering controls ===== */

INSERT INTO settings (key, value) VALUES
  ('qr_ordering_enabled', '1'),
  ('qr_require_approval', '0')
ON CONFLICT (key) DO NOTHING;
