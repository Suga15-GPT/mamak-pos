# Phase 09 — Shifts, cash drawer, X/Z reports

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~40k tokens.** Depends on phases 03, 05.

## Why

Audit #18 and #22. There is no way to open a shift, declare a float, count the
drawer, or reconcile at close — so nobody can tell at 1am whether the cash is right.
Meanwhile the dashboard's month/year buckets mix `timestamp` and `timestamptz` and
can land takings in the wrong period.

## Files

Read: `src/routes/reports.js`, `src/services/billing.js`, `public/js/dashboard.js`.
Create: `migrations/008_shifts.sql`, `src/services/shifts.js`,
`public/js/shift.js`, `test/unit/shifts.test.js`.

## Do

**1. `migrations/008_shifts.sql`:**

```sql
CREATE TABLE IF NOT EXISTS shifts (
  id                SERIAL PRIMARY KEY,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by         INT NOT NULL REFERENCES users(id),
  float_cents       INT NOT NULL DEFAULT 0,
  closed_at         TIMESTAMPTZ,
  closed_by         INT REFERENCES users(id),
  counted_cents     INT,
  expected_cents    INT,
  variance_cents    INT,
  note              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts ((true)) WHERE closed_at IS NULL;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS shift_id INT REFERENCES shifts(id);
ALTER TABLE orders   ADD COLUMN IF NOT EXISTS shift_id INT REFERENCES shifts(id);

CREATE TABLE IF NOT EXISTS cash_movements (
  id         SERIAL PRIMARY KEY,
  shift_id   INT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('payin','payout')),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  reason     TEXT NOT NULL,
  user_id    INT NOT NULL REFERENCES users(id),
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The `one_open_shift` partial index means the database enforces a single open shift
— do not enforce it in application code.

**2. `src/services/shifts.js`:**

```js
open({userId, floatCents})
current()
addMovement({kind, amountCents, reason, userId})   // petty cash in/out
close({userId, countedCents, note})
report(shiftId, {final})                           // X (interim) or Z (final)
```

Every order and payment stamps the open shift's id. Refuse to take a payment when
no shift is open — that is the control that makes the whole thing work.

**Expected cash** = `float + Σ cash payments + Σ payins − Σ payouts`.
**Variance** = `counted − expected`. Store all three; never recompute a closed
shift's numbers on read, or last week's Z report will change when today's data does.

**3. Report contents** (X = interim snapshot, Z = final, written once at close):
gross sales, discounts, comps, voids (count + value), net sales, service charge,
SST, rounding; payment mix by method; order count and average check; sales by
category and top 10 items; cash reconciliation (float, cash sales, pay in/out,
expected, counted, variance); staff breakdown of sales and voids.

Voids and discounts by staff member is the report an owner actually reads — make it
prominent, not a footnote.

**4. Fix the timezone bug (#22).** Do all bucketing in one timezone consistently:

```sql
WITH p AS (SELECT total_cents, (paid_at AT TIME ZONE 'Asia/Kuala_Lumpur') AS lt
             FROM orders WHERE status='paid')
SELECT date_trunc('month', lt) AS bucket, SUM(total_cents) FROM p GROUP BY 1
```

`lt` is a local `timestamp` — never compare it against a `timestamptz`. Add a test
that a payment at 23:30 KL on the last day of a month lands in that month, and one
at 00:30 KL on the first lands in the next.

**5. Report off `payments`/`total_cents`, not `pay_total_cents`.** Drop
`orders.pay_method`/`pay_total_cents` in this migration now that phase 05 backfilled
`payments` — but only after confirming no code reads them.

**6. UI.** A Shift tab: open with float, current takings, pay in/out, X report, and
a close flow with a **denomination counter** (how many RM50, RM10, RM1, 50sen…)
that totals as you type — cashiers count notes, not a single number. Show variance
in red or green at close and require a note when it is non-zero. Z report is
printable via phase 08 and exportable as CSV.

## Tests — `test/unit/shifts.test.js`

- Opening a second shift while one is open → 409 (the DB index enforces it).
- Payment with no open shift → 400.
- Expected cash = float + cash sales + payins − payouts; card sales excluded.
- Variance sign: counted less than expected → negative.
- A closed shift's stored figures do not change when later orders are added.
- Month-boundary test at 23:30 and 00:30 Asia/Kuala_Lumpur.

## Verify

```bash
npm test
```

Then by hand: open a shift with RM 200 float, ring one cash and one card sale, pay
out RM 20, close counting the exact expected amount, and confirm variance is 0 and
the Z report's figures tie out.
