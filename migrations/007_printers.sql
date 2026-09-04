CREATE TABLE IF NOT EXISTS printers (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL,
  host     TEXT NOT NULL,
  port     INT  NOT NULL DEFAULT 9100,
  role     TEXT NOT NULL CHECK (role IN ('kitchen','receipt','bar')),
  width    INT  NOT NULL DEFAULT 42,     -- chars per line: 42 for 80mm, 32 for 58mm
  enabled  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id         SERIAL PRIMARY KEY,
  printer_id INT REFERENCES printers(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('chit','receipt','void','report')),
  order_id   INT REFERENCES orders(id) ON DELETE SET NULL,
  payload    BYTEA NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','printing','done','failed')),
  attempts   INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs (status, id);
