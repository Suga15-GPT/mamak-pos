# Phase 03 — Order integrity: attribution, voids, audit

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5 at **high** effort (Opus if available). **Expect ~50k tokens.**

## Why

Three findings that together make the current system unusable for a real business:

- **#14** Nothing records *who* did anything. No staff id on an order, a payment, or
  a cancellation. In a cash restaurant this is the primary theft control, and
  without it no dispute can ever be settled.
- **#15** Nothing stops two tablets opening the same table and creating two orders.
  The client then silently shows only the first; the second bill is discovered at
  closing, if ever.
- **#16** A sent line cannot be removed. The only escape is an admin cancelling the
  whole order, so a single mis-tap destroys the whole ticket.

## Files

Read: `src/services/orders.js`, `src/routes/orders.js`, `src/lib/auth.js`,
`public/js/pos.js`, `public/js/kitchen.js`.
Create: `migrations/003_integrity.sql`, `test/unit/orders.test.js`.

## Do

**1. `migrations/003_integrity.sql`:**

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS opened_by INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS paid_by   INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS closed_by INT REFERENCES users(id);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS added_by    INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by   INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- one open order per table, enforced by the database, not by the client
CREATE UNIQUE INDEX IF NOT EXISTS one_open_order_per_table
  ON orders (table_id) WHERE status NOT IN ('paid','cancelled');

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     INT REFERENCES users(id),
  action      TEXT NOT NULL,          -- order.create | order.append | order.void_line
                                      -- order.status | order.pay | order.cancel
                                      -- discount.apply | shift.open | shift.close
  entity_type TEXT NOT NULL,
  entity_id   INT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);
```

The partial unique index may fail to create if the database already contains two
open orders for one table. Handle that in the migration: close the older duplicate
by setting it to `cancelled` with an `audit_log` row explaining why, then create
the index.

**2. Attribution.** Every mutating route records `req.user.id`: `opened_by` on
create, `added_by` on each appended line, `paid_by` on pay, `closed_by` on cancel.

**3. Voids, not deletes.** `POST /api/orders/:id/items/:lineId/void`, body
`{ reason }`. It sets `voided_at`/`voided_by`/`void_reason` — **never** `DELETE`.
Rules:
- `reason` is required, 3–200 chars.
- Role: `staff` may void a line while the order is still `sent`; once the kitchen
  has moved it past `sent`, only `admin` may void. Enforce server-side.
- Voided lines are excluded from every total (`computeBill` must filter
  `voided_at IS NULL`), still returned by the API with their void metadata, shown
  struck-through on the bill, and shown on the kitchen display as a **VOID** ticket
  so the line cook stops cooking it.

**4. Handle the race properly.** When `POST /api/orders` violates
`one_open_order_per_table` (Postgres error code `23505`), do not 500 — return
`409` with the existing open order's id, and have the client load that order
instead. Add a unit test that fires two concurrent creates for one table and
asserts exactly one order exists and the loser got a 409.

**5. Audit log.** Write a row for every action in the `action` list above. `detail`
carries what changed (line id, qty, amount, reason, old/new status). Add
`GET /api/admin/audit?limit=100&entity_id=` (admin only, paginated) and a simple
Admin-tab table showing time, user, action, detail.

**6. Undo for the kitchen.** Extend `TRANSITIONS` so a mis-tap is recoverable:
`preparing → sent`, `ready → preparing`, `served → ready`. Backward moves are
`staff`/`admin` only (not `kitchen`), and each writes an audit row.

## Tests — `test/unit/orders.test.js`

- Two concurrent `POST /api/orders` for one table → one 201, one 409, one row.
- Voided line is excluded from the total but still returned by the API.
- Void without a reason → 400. Void by `kitchen` role → 403.
- `staff` voids a `sent` line → 200; `staff` voids a `preparing` line → 403;
  `admin` voids a `preparing` line → 200.
- Every mutation writes exactly one `audit_log` row with the right `user_id`.
- Backward transition by `kitchen` → 403; by `staff` → 200.

## Verify

```bash
npm test
```

Then by hand: open one table in two browser windows and confirm the second joins
the same order rather than creating a second one; void a line and confirm the bill
total drops, the line shows struck-through, and the kitchen shows a VOID ticket.
