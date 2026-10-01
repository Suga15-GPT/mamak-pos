-- Expenses: what the restaurant spends — groceries, gas, rent, wages — so the
-- owner can see sales against costs. Kept apart from sales: Clear sales data
-- never touches these tables, and no sales figure reads them.
--
-- A receipt photo is kept (downscaled on the phone first) in the database
-- itself, so the nightly pg_dump backs it up with everything else. An expense
-- is never deleted: a mistake is voided, with a reason, as bill lines are.

CREATE TABLE IF NOT EXISTS expense_categories (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  sort   INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO expense_categories (name, sort) VALUES
  ('Groceries & produce', 1), ('Meat, chicken & seafood', 2), ('Drinks & dairy', 3),
  ('Rice, flour & dry goods', 4), ('Spices & sauces', 5), ('Packaging & disposables', 6),
  ('Cleaning supplies', 7), ('Gas', 8), ('Electricity', 9), ('Water', 10), ('Rent', 11),
  ('Staff wages', 12), ('Repairs & maintenance', 13), ('Other', 99)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS expense_receipts (
  id         SERIAL PRIMARY KEY,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data       BYTEA NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A regular cost: rent on the 1st, the gas man every week. The till shows it
-- as due; somebody confirms it (and its amount) before it is recorded.
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  supplier        TEXT,
  category_id     INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  method          TEXT NOT NULL DEFAULT 'Bank transfer',
  every           TEXT NOT NULL CHECK (every IN ('month', 'week')),
  day             INTEGER NOT NULL,
  starts_on       DATE NOT NULL,
  last_done_for   DATE,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((every = 'month' AND day BETWEEN 1 AND 31) OR (every = 'week' AND day BETWEEN 1 AND 7))
);

CREATE TABLE IF NOT EXISTS expenses (
  id            SERIAL PRIMARY KEY,
  spent_on      DATE NOT NULL,
  supplier      TEXT,
  category_id   INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  description   TEXT,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  method        TEXT NOT NULL CHECK (method IN ('Cash', 'Card', 'Bank transfer', 'DuitNow/eWallet', 'Other')),
  items         JSONB,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'photo', 'voice', 'recurring')),
  receipt_id    INTEGER REFERENCES expense_receipts(id) ON DELETE SET NULL,
  recurring_id  INTEGER REFERENCES recurring_expenses(id) ON DELETE SET NULL,
  recurring_for DATE,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at     TIMESTAMPTZ,
  voided_by     INTEGER REFERENCES users(id),
  void_reason   TEXT
);
CREATE INDEX IF NOT EXISTS expenses_spent_on ON expenses (spent_on) WHERE voided_at IS NULL;
-- A receipt photo belongs to one (live) expense.
CREATE UNIQUE INDEX IF NOT EXISTS expenses_one_per_receipt
  ON expenses (receipt_id) WHERE receipt_id IS NOT NULL AND voided_at IS NULL;
-- One record per regular cost per due date: recording it twice is refused.
CREATE UNIQUE INDEX IF NOT EXISTS expenses_one_per_due
  ON expenses (recurring_id, recurring_for) WHERE recurring_id IS NOT NULL AND voided_at IS NULL;

-- A shop that already finished setup gets Expenses on — unless it chose
-- nothing at all (the "Small stall" preset, every module off): a missing
-- switch means on, and that shop would otherwise find a new screen it never
-- asked for. A fresh install has no setup yet; its wizard decides.
INSERT INTO settings (key, value)
SELECT 'feature_expenses',
       CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key LIKE 'feature\_%' AND key <> 'feature_expenses' AND value = '1')
            THEN '1' ELSE '0' END
 WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'setup_completed' AND value = '1')
ON CONFLICT (key) DO NOTHING;
