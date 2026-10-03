-- 021 gained the expenses_receipt index after it had already run on some test
-- and development databases. Migrations run once, by file name, so those never
-- got it. IF NOT EXISTS makes this a no-op wherever 021 already created it.
CREATE INDEX IF NOT EXISTS expenses_receipt ON expenses (receipt_id) WHERE receipt_id IS NOT NULL;
