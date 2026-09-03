# Phase 02 — Money and tax

Read `docs/prompts/_CONVENTIONS.md` and `docs/REBUILD-PLAN.md` §3 first.
**Model:** Sonnet 5 at **high** effort (Opus if available — this phase decides what
customers are charged). **Expect ~50k tokens.**

## Why

Audit #13: the admin panel announces "SST (8%) is ON" and **no tax is ever charged
by any code path**. A merchant trusting that toggle is under-collecting on every
bill. Separately, the bill has no stored breakdown — `pay_total_cents` is a single
number that cannot be reproduced or explained to a customer or an auditor.

## Files

Read: `src/lib/money.js`, `src/routes/orders.js`, `src/services/orders.js`,
`src/routes/reports.js` (settings), `docs/REBUILD-PLAN.md` §3.
Create: `migrations/002_money.sql`, `test/unit/money.test.js`.

## The specification

Implement §3 of the rebuild plan exactly. Restated:

```
subtotal        = Σ (unit_price_cents + Σ modifier_price_cents) × qty
service_charge  = round_half_up(subtotal × svc_rate_bp / 10000)
service_tax     = round_half_up((subtotal + service_charge) × tax_rate_bp / 10000)
gross           = subtotal + service_charge + service_tax − discount
rounding        = cash only: nearest 5 sen adjustment of gross
total           = gross + rounding
```

Non-negotiable:
- **F&B service tax is 6% → `tax_rate_bp = 600`.** Not 8%. Fix the UI label.
- Service charge default **0** (`svc_rate_bp = 0`); mamak shops typically charge none.
- **Tax applies on top of the service charge**, in that order.
- Round **once per component**, half-up, in integer cents. Never round the subtotal.
- 5-sen rounding is **cash only**; card and e-wallet are charged exact.
- **Snapshot `tax_rate_bp` and `svc_rate_bp` onto the order at payment.** When the
  rate changes, historical receipts must not move. This is the single most
  important line in this prompt.

## Do

**1. `migrations/002_money.sql`:**

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS subtotal_cents       INT,
  ADD COLUMN IF NOT EXISTS service_charge_cents INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_cents            INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_cents       INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rounding_cents       INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cents          INT,
  ADD COLUMN IF NOT EXISTS tax_rate_bp          INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS svc_rate_bp          INT NOT NULL DEFAULT 0;

-- backfill already-paid orders so historical rows stay reproducible
UPDATE orders SET subtotal_cents = pay_total_cents,
                  total_cents    = pay_total_cents
 WHERE status = 'paid' AND total_cents IS NULL;

INSERT INTO settings (key, value) VALUES ('tax_rate_bp','600'), ('svc_rate_bp','0')
  ON CONFLICT (key) DO NOTHING;
```

Keep `pay_total_cents` for now; phase 09's reports migrate off it.

**2. `src/lib/money.js`** — pure functions, no DB, fully unit-testable:

```js
roundHalfUp(n)                        // 0.5 always away from zero; -0.5 → -1
lineTotal({price_cents, qty, mods})   // (price + Σ mods) × qty
computeBill({ lines, taxRateBp, svcRateBp, discountCents, method })
  // → { subtotal_cents, service_charge_cents, tax_cents,
  //     discount_cents, rounding_cents, total_cents }
formatRM(cents)                       // "RM 12.35"
```

`roundCashCents` stays and is used only for the `rounding_cents` component when
`method === 'Cash'`.

**3. Wire it into payment.** `POST /api/orders/:id/pay` reads the current
`tax_rate_bp`/`svc_rate_bp` from `settings`, calls `computeBill`, and writes all
eight columns. It must **not** trust any total sent by the client — recompute from
`order_items`/`order_item_mods` server-side, as it does today.

**4. Expose the breakdown.** `ordersWithItems` returns the components alongside
`total`. The payment modal shows Subtotal / Service charge (if non-zero) / SST 6% /
Rounding (cash) / **Total**, and for cash also change due. Replace the misleading
"SST (8%)" admin toggle with two rate fields (`tax_rate_bp`, `svc_rate_bp`) shown
as percentages, admin-only, with the current values.

**5. Retire the fake setting.** Remove `sst_on`, or migrate it: if it was `true`,
set `tax_rate_bp = 600`, else `0`.

## Tests — `test/unit/money.test.js`

These cases specifically; they are where rounding bugs hide:

| Case | Expectation |
|---|---|
| `roundHalfUp(2.5)` / `(-2.5)` | `3` / `-3` |
| subtotal 1000, tax 600bp, svc 0 | tax 60, total 1060 |
| subtotal 1000, tax 600bp, svc 1000bp | svc 100, tax 66, total 1166 (tax on 1100) |
| subtotal 333, tax 600bp | tax 20 (19.98 rounds up), total 353 |
| cash, gross 1063 | rounding −3, total 1060 |
| cash, gross 1067 | rounding +3, total 1070 |
| card, gross 1063 | rounding 0, total 1063 |
| tax 0, svc 0 | total == subtotal exactly |
| discount 500 on subtotal 1000, tax 600bp | tax computed on 1000, not 500; total 560 |
| 100 lines × qty 20 | no float drift; total is exact |

Plus one integration test: pay an order by cash, re-read it, and assert the stored
components sum to `total_cents` and that a later rate change does not alter it.

## Verify

```bash
node --test test/unit/money.test.js
npm test
```

Paste both. Then place a real RM 10.00 order and confirm the payment modal shows
`Subtotal RM 10.00 / SST 6% RM 0.60 / Total RM 10.60`, and that the stored row
reproduces exactly that.
