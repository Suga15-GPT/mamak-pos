# Phase 05b — Billing gaps left open by phase 05

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5 at **high** effort (item 1 is a money bug). **Expect ~25k tokens.**

Small follow-up phase. Phase 05 landed correctly and its own report flagged most of
this; item 2 was found afterwards by driving the app.

## 1. Void and discount can leave an order owing the customer money

**Reproduced on the current `main`:** order 10 × Roti Canai (RM 21.20 with tax),
customer pays RM 15.00 by card, staff voids the line. Result:

```
 id | status | total_cents | paid_cents | amount_due
  1 | sent   |           0 |       1500 |      -1500
```

The shop is holding RM 15.00 against an order worth nothing, and the order can never
close, because settling requires the balance to reach exactly zero. `hasPayments()`
already exists in `src/services/billing.js` and guards `POST /api/orders/:id/items`
— it was never applied to void or discount. A fully **paid** order is already
protected (status check); a **partially** paid one is not, because its status is
still `sent`.

Fix in `src/routes/orders.js` (void) and wherever `addDiscount` is exposed:

- Compute what the order's total *would become* before committing the change.
- If that total would fall **below the sum already paid**, reject with `409` and an
  error naming the shortfall: `"voiding this line would leave RM 15.00 already paid
  against a RM 0.00 bill — refund the payment first"`. Do not silently allow it.
- If the new total lands **exactly on** the amount already paid, settle the order:
  mark it `paid`, stamp `paid_at`/`closed_by`, and write the audit row. A void that
  brings the bill down to what the customer already handed over has closed the sale,
  and leaving it open makes a table look occupied all night.
- Anything above the paid amount proceeds as it does today.

Refunds themselves are **out of scope** — there is no refund mechanism yet and you
must not invent one. Add a `refunds` line to `docs/AUDIT.md` as an outstanding
finding so it gets scheduled.

Tests in `test/unit/billing.test.js`:
- Partial payment, then a void that would drop the total below it → 409, nothing
  changes, the line is still un-voided.
- Partial payment, then a void that lands the total exactly on the paid amount →
  order becomes `paid`, `amount_due` is 0.
- Partial payment, then a void that leaves the total above it → allowed, order stays
  open with the correct remaining balance.
- The same three cases for a discount.

## 2. The order screen calls the pre-tax subtotal "Total"

`public/index.html` shows one line, labelled **Total**, fed by a client-side sum of
the cart lines. That figure excludes tax. The payment modal separately shows the
real tax-inclusive `grand_total`. So the cart reads *Total RM 20.00* while the till
charges *RM 21.20* — a waiter reading the screen quotes the wrong number to the
customer, which is an argument at the counter every time.

The API already returns everything needed (`subtotal`, `grand_total` and the tax
components from `ordersWithItems`). Make the cart panel show the same breakdown the
payment modal does: **Subtotal**, **Service charge** (only when non-zero), **SST**,
**Total**. Only the final line is styled as the grand total. Use the server's
figures rather than recomputing tax on the client — there must be exactly one place
in this codebase that knows how tax works, and it is `money.js`.

## 3. No discount control in the staff app

`addDiscount` and its admin-approval flow are implemented and tested, but nothing in
the UI reaches them, so the feature does not exist for staff. Add to the payment
modal: a **Discount** button offering percent / fixed amount / comp, a required
reason field, and the admin-PIN approval prompt phase 05 specified. Show any applied
discount as its own line in the bill breakdown with the reason visible, and let an
admin remove one before payment completes. Every path already writes an audit row —
do not add a second one.

## 4. Un-skip the split-bill journey

`test/e2e/journeys.spec.js` has a `test.skip`'d split-bill journey that was waiting
for phase 05, which has now landed. Enable it and make it pass.

## Do not

Do not build refunds. Do not touch the tax formulas in `money.js` — they are correct
and tested. Do not restructure the payment modal beyond adding the rows and the
discount control.

## Verify

```bash
npm test
npx playwright test -g "split"
```

Then by hand, the exact scenario from item 1: order RM 21.20, pay RM 15.00, try to
void the line. You must get a refusal naming the shortfall, not a negative balance.
Then confirm the cart panel and the payment modal show the **same** total.
