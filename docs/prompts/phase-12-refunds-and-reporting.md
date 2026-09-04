# Phase 12 — Refunds, and making the Z report tie out

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5 at **high** effort. **Expect ~45k tokens.**

The twelve planned phases are done. These are the last three things standing between
this system and real money going through it. Both of the first two are about the
report an owner reads to decide whether they were stolen from.

## 1. A Z report's sales and payments do not agree

`src/services/shifts.js` scopes sales by `orders.shift_id` — the shift the order was
**opened** in (line ~98) — and cash and payment mix by `payments.shift_id`, the shift
that **collected** (line ~126). The phase 09 session documented this honestly as a
known limitation. Its consequence is worse than it reads.

An order opened 11:45pm and paid 12:15am puts its sales in the closing shift and its
cash in the next one. The owner reads the first Z report and sees:

```
Gross sales      RM 4,200.00
Payments received RM 3,900.00
```

…and concludes RM 300 is missing. Nothing is missing. **A mamak trades past midnight
every night, so this is not an edge case — it is most nights**, and it makes the one
report that exists to detect theft cry wolf until people stop reading it.

Fix: **recognise revenue at settlement.** Scope the sales side by the shift that
closed the order, not the one that opened it — matching how the cash side already
works, so the two agree by construction. This is what POS systems generally do, and
it is the only version where the report's own numbers are consistent.

- Keep `orders.shift_id` (opened-in) — it is genuinely useful for "which shift was
  this table sitting in", and phase 03's attribution depends on it. Add a separate
  `orders.closed_shift_id`, stamped when the order settles.
- Backfill it for existing paid orders from the shift of their last payment.
- Every sales figure in `report()` — gross, net, discounts, voids, categories, top
  items, average check, staff sales — moves to `closed_shift_id`.
- An order still open when a shift closes belongs to **no** shift's sales yet. It
  lands in whichever shift eventually settles it. Say so on the report: a line for
  "open orders carried forward: N, RM X" so the number is visible rather than
  mysteriously absent.
- A closed shift's stored figures still must never change afterwards (phase 09's
  rule). Verify a Z report re-read a day later is byte-identical.

Test: open shift A, ring an order, close shift A, open shift B, pay the order there.
Shift A's report shows the order as carried forward and **zero** sales for it; shift
B's shows both the sale and the cash; and on both reports gross sales minus
discounts equals the payment total.

## 2. There is no way to refund anything

Audit #39. Once `payments` has a row there is no path to reverse it. A card
double-charge, an overpayment, a customer sent away unhappy — all of them currently
require editing the database by hand. It is also why phase 05b can only *refuse* a
void that would over-refund rather than handle it, which leaves staff stuck: the
customer has paid, the food was wrong, and the system's only answer is "no".

```sql
-- migrations/011_refunds.sql
CREATE TABLE IF NOT EXISTS refunds (
  id           SERIAL PRIMARY KEY,
  payment_id   INT NOT NULL REFERENCES payments(id),
  order_id     INT NOT NULL REFERENCES orders(id),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  reason       TEXT NOT NULL,
  approved_by  INT NOT NULL REFERENCES users(id),
  shift_id     INT REFERENCES shifts(id),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds (order_id);
```

Rules:
- A refund is **always against a specific payment**, never free-floating — so it
  refunds by the method it was taken by, and the drawer maths stays honest.
- Total refunds against a payment may never exceed it. Enforce in the same
  transaction that inserts, not with a read-then-write.
- **Admin approval required**, reason mandatory, `audit_log` row every time. Reuse
  phase 05's `POST /api/discounts/authorize` PIN-approval pattern rather than
  inventing a second one.
- A **cash** refund reduces the drawer: expected cash becomes
  `float + cash payments − cash refunds + payins − payouts`. Update phase 09's
  calculation and its test. A card refund does not touch the drawer.
- Refunds appear on the Z report as their own line, split by method, and in the
  staff breakdown next to voids and discounts — same reasoning as voids: this is
  what an owner scans for.
- Once refunded to zero, an order's status becomes `refunded`, not `paid`. Add it to
  the `orders.status` CHECK constraint and to `TRANSITIONS` as a terminal state.
- Now that refunds exist, phase 05b's shortfall guard can offer a way out: when a
  void would drop the total below what was paid, the error should name the refund
  needed. Do not perform it automatically — that is the manager's decision.

Tests: refund exceeding its payment → 400. Cash refund reduces expected cash by
exactly its amount; card refund does not. Two partial refunds summing to the payment
→ allowed; a third cent → 400. Refunding everything sets status `refunded`. A
concurrent double-refund of the same payment does not over-refund.

## 3. Un-skip the void-a-line journey

`test/e2e/journeys.spec.js` still has an explicitly skipped void-a-line journey,
outstanding since phase 03. The functionality has existed for six phases. Enable it
and make it pass. If it fails, that is a real bug in void — fix the code, not the
test.

## Do not

Do not add partial-refund UI beyond one dialog on the payment modal. Do not touch
the tax formulas. Do not change how `orders.shift_id` is stamped — you are adding
`closed_shift_id` alongside it, not replacing it.

## Verify

```bash
npm test
npx playwright test          # all six journeys, none skipped
```

Then by hand, the scenario from item 1: order in shift A, close A, pay in shift B,
and confirm both Z reports internally balance. Then take a RM 20 cash payment, refund
RM 5 of it, and confirm expected cash drops by exactly RM 5.
