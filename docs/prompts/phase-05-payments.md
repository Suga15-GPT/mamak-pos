# Phase 05 — Payments: split bills, multi-tender, discounts

Read `docs/prompts/_CONVENTIONS.md` and `docs/REBUILD-PLAN.md` §3 first.
**Model:** Sonnet 5 at **high** effort. **Expect ~50k tokens.** Depends on phase 02.

## Why

Audit #24–25. Today an order has exactly one `pay_method` and one total. A table of
six paying separately, a customer paying half cash half card, a staff meal, a
manager comping a burnt roti — none of these have any path through the system, so
they get rung up as cash and reconciled as a shortfall.

## Files

Read: `src/lib/money.js`, `src/routes/orders.js`, `src/services/orders.js`,
`public/js/pos.js`. Create: `migrations/005_payments.sql`,
`src/services/billing.js`, `test/unit/billing.test.js`.

## Do

**1. `migrations/005_payments.sql`** — payments become rows, not a column:

```sql
CREATE TABLE IF NOT EXISTS payments (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method       TEXT NOT NULL CHECK (method IN ('Cash','Card','DuitNow/eWallet')),
  amount_cents INT  NOT NULL CHECK (amount_cents > 0),
  tendered_cents INT,                    -- cash only, for change due
  taken_by     INT REFERENCES users(id),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);

CREATE TABLE IF NOT EXISTS discounts (
  id            SERIAL PRIMARY KEY,
  order_id      INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('percent','amount','comp')),
  value         INT NOT NULL,            -- basis points, or cents, or 0 for comp
  amount_cents  INT NOT NULL,            -- resolved cash value, snapshotted
  reason        TEXT NOT NULL,
  approved_by   INT NOT NULL REFERENCES users(id),
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS seat INT;

-- backfill existing paid orders into the new table
INSERT INTO payments (order_id, method, amount_cents, taken_by, at)
SELECT id, pay_method, COALESCE(total_cents, pay_total_cents), paid_by, paid_at
  FROM orders WHERE status='paid' AND pay_method IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id);
```

**2. `src/services/billing.js`:**

```js
amountDue(orderId)        // total_cents − Σ payments.amount_cents
addPayment(orderId, {method, amountCents, tenderedCents, userId})
addDiscount(orderId, {kind, value, reason, userId})
splitEvenly(orderId, ways)        // → array of cent amounts summing exactly to total
splitBySeat(orderId)              // → { seat: cents }
```

**`splitEvenly` must not lose or invent a sen.** Divide, floor, then distribute the
remainder one sen at a time across the first N shares. `assert(Σ shares === total)`.
This is the classic split-bill bug; unit-test it on totals that do not divide (e.g.
RM 10.00 three ways → 334/333/333).

**3. Partial payment.** An order becomes `paid` only when `amountDue === 0`. Until
then it stays open with payments recorded against it and the POS shows
"RM X.XX remaining". Over-payment is rejected except for cash, where
`tendered_cents > amount_cents` yields **change due** — display it prominently, it
is the number the cashier needs in the next two seconds.

**4. Discounts.** Applied to the subtotal before tax (per §3, tax is computed on the
undiscounted subtotal — do not change that ordering without re-reading §3). `comp`
zeroes the order. Every discount requires a reason and an **admin** approval; a
`staff` user requesting one gets a PIN prompt that authenticates an admin for that
single action (`POST /api/discounts/authorize` with name+pin, returning a
short-lived one-use token). Every discount writes an `audit_log` row.

**5. Recompute on every change.** Adding a line, voiding a line, or applying a
discount recomputes and re-stores the order's money columns via `computeBill`.
An order that has any payment against it may not have lines added — return 409.

**6. UI.** Payment modal: amount due, method buttons, a numeric keypad for cash
tendered with change due, a payments-so-far list, and "Split → evenly / by seat /
by amount". Seat assignment is an optional per-line field in the cart.

## Tests — `test/unit/billing.test.js`

- `splitEvenly(1000, 3)` → `[334,333,333]`, sums to 1000. Also 7 ways, 6 ways.
- Two partial payments settling exactly → order becomes `paid`, `amountDue` 0.
- Payment exceeding due by cash → change due correct; by card → 400.
- Adding a line to an order with a payment → 409.
- Percent discount 10% on RM 20.00 → 200 cents off; tax still computed per §3.
- Comp → total 0, order closes with a zero payment recorded, audit row written.

## Verify

```bash
npm test
```

Then by hand: split a RM 10.00 bill three ways and confirm the shares are
3.34/3.33/3.33 and the order closes exactly at zero.
