# Phase 08 — Kitchen chits and receipts (ESC/POS)

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~35k tokens.** Depends on phases 02, 05.

## Why

Audit #17. A mid-tier restaurant cannot run without a printed kitchen chit and a
customer receipt. A screen in a hot, wet kitchen is a nice supplement to paper, not
a replacement for it, and Malaysian customers expect a printed bill.

## Files

Read: `src/services/orders.js`, `src/services/billing.js`, `src/lib/money.js`.
Create: `src/services/printing.js`, `src/lib/escpos.js`,
`migrations/007_printers.sql`, `test/unit/escpos.test.js`.

## Do

**1. `migrations/007_printers.sql`:**

```sql
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
```

**2. `src/lib/escpos.js`** — raw byte building, no dependency. A thermal printer is
a socket that accepts bytes; a library is not worth the supply chain.

```js
init()                      // ESC @        1B 40
text(s)                     // CP437-safe ASCII; strip anything above 0x7F
align(a)                    // ESC a n      0 left 1 centre 2 right
bold(on) / doubleHeight(on) // ESC E n / GS ! n
line(char='-')              // width chars
row(left, right)            // pad to width: "Roti Canai        2.00"
cut()                       // GS V 66 0
drawer()                    // ESC p 0 25 250 — cash drawer kick
```

`row()` is the one to get right: it is every line of every receipt. Truncate a long
left side rather than wrapping into the price column, and unit-test it at both 42
and 32 characters.

**3. Templates** in `src/services/printing.js`:

- **Kitchen chit** — big and skimmable, not pretty. Order #, table, time, staff
  name, then **double-height item lines with qty first**, modifiers indented,
  notes in bold. No prices — the kitchen does not care and it wastes paper.
  One chit per order; appended items print a new chit marked **ADDITION**.
- **Void chit** — the same, headed `*** VOID ***`, listing only the voided line
  and its reason, so the cook stops cooking it.
- **Receipt** — restaurant name/address/SST number, order #, table, date/time,
  staff, item lines with prices, then the **full money breakdown from phase 02**
  (subtotal, service charge if non-zero, SST 6%, discount, rounding, total), the
  payments with change due, and a thank-you. Print the SST registration number
  when one is configured — it is a legal requirement for a registered business.

**4. Dispatch.** `enqueue(kind, orderId)` writes a `print_jobs` row and a worker
drains the queue: open a TCP socket to `host:port`, write, close, mark `done`. On
failure mark `failed`, increment `attempts`, retry up to 3 times with backoff.
**A printer being offline must never block or fail an order** — the order is
already committed; printing is best-effort and asynchronous.

**5. Triggers.** Chit on order create and on append; void chit on void; receipt on
payment complete plus a manual "Reprint receipt" button (which writes an audit row
— reprinted receipts are a known fraud vector).

**6. Admin UI.** Printer CRUD, a **Test print** button per printer, and a jobs list
showing failures with their error so a jammed printer is visible.

## Tests — `test/unit/escpos.test.js`

- `row('Roti Canai', 'RM 2.00')` at width 42 and 32 → exact expected strings.
- A 60-character item name truncates, never wraps into the price.
- Receipt bytes contain the correct total and end with the cut sequence.
- Non-ASCII in an item name does not emit a byte above 0x7F.
- Enqueue with no printer configured → job recorded `failed`, order unaffected.

## Verify

```bash
npm test
```

Without hardware, verify by pointing a printer row at `localhost:9100` and running
`nc -l 9100 | hexdump -C` to inspect the bytes. Confirm an order still completes
normally with every printer disabled.
