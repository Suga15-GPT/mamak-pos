# mamak-pos — code audit

Audit of commit `1be1d73` (the state before this branch). Every **Confirmed** item
below was reproduced against a live Postgres with a real browser, not read off the
source. Severity is business impact for a working restaurant, not CVSS.

## Fixed on this branch

| # | Severity | Finding | Evidence |
|---|----------|---------|----------|
| 1 | Critical | **Staff and kitchen users could not use the POS at all.** `loadAll()` fetched admin-only `/api/admin/tables` inside a `Promise.all`, so for any non-admin the whole call rejected — no tables, no menu. Only the `Admin` login could take an order. | staff login → 0 tables, 0 categories, toast `Failed to load data: forbidden` |
| 2 | Critical | **Re-sending a table's order double-billed the customer.** Opening a table loaded existing lines into the cart; "Send to Kitchen" posted the *whole* cart to `/orders/:id/items`, re-appending lines already on the order. | 2 roti entered → server recorded 3 → RM 6.00 instead of RM 4.00 |
| 3 | Critical | **Customer QR page was broken for every real customer.** `customer.html` linked `style.css`/`api.js` relatively; served at its real address `/t/:token` the browser resolved `/t/style.css`, which the `/t/:token` catch-all answered with the HTML page itself. Unstyled page + JS syntax error on every scan. | `curl /t/style.css` → `Content-Type: text/html` |
| 4 | High | **Table QR tokens were world-readable.** `GET /api/admin/tables/:id/qr.png` had no auth; sequential IDs leaked every table's `qr_token`, letting anyone place orders on any table remotely without visiting the shop. | unauthenticated `200` on `/api/admin/tables/1/qr.png` |
| 5 | High | **`.env` with live DB password + admin PIN committed to git.** Also copied into the Docker image (`COPY . .`, no `.dockerignore`). | tracked in `git ls-files` |
| 6 | High | **The 3-second live refresh never fired.** `refreshLive()` compared `.tab.active`'s id (`"tab-pos"`) against bare `"pos"`. Kitchen screens never updated on their own. | `id === 'pos'` → `false` |
| 7 | Medium | **No login rate limiting** on a 4-digit PIN; the limiter helper existed but was never applied to `/api/login`. | unlimited attempts |
| 8 | Medium | **Sessions never expired and logout was client-only** — a copied token worked forever. | token valid after "logout" |
| 9 | Medium | `GET /api/orders?mode=recent` returned 500 — the caller's where-clause already ended in `ORDER BY … LIMIT`, and the function appends its own `ORDER BY`. | `syntax error at or near "ORDER"` |
| 10 | Medium | Internal DB error text returned to unauthenticated callers. | `awaitH` echoed `e.message` |
| 11 | Low | Names interpolated into `onclick` attributes; `esc()` turns `'` into `&#39;`, which the browser decodes back to a quote *before* parsing the attribute as JS. A table named `Ali's` broke its handler. | static |
| 12 | Low | `npm ci` in the Dockerfile silently fell back to `npm install` — no lockfile was committed. | `npm ci \|\| npm install` |

## Outstanding — must fix in the rebuild

Ordered by business impact. These are the backlog that `docs/REBUILD-PLAN.md` schedules.

| # | Severity | Finding |
|---|----------|---------|
| 13 | **Critical** | **The SST toggle is theatre.** `sst_on` is stored, and the admin panel proudly says "SST (8%) is ON", but no code path anywhere multiplies anything by anything. Tax is *never* charged. A merchant who switches it on believes they are collecting tax and is not. (Separately: Malaysian F&B service tax is **6%**, not 8% — the 2024 rise to 8% excluded F&B. The label is wrong too.) |
| 14 | **Critical** | **No staff attribution on orders or payments.** `user_id` exists only on `sessions`. Nobody can tell who took an order, who voided it, or who took the cash. For a cash-heavy restaurant this is the single biggest theft vector, and it makes disputes unresolvable. |
| 15 | High | **Nothing enforces one open order per table.** Two tablets can open the same table and create two orders; `checkOpenOrder()` then silently picks the first, and the second bill is invisible until someone finds it. Needs a DB-level partial unique index, not client logic. |
| 16 | High | **No void/comp path.** Once a line is sent it cannot be removed — the only escape is an admin cancelling the entire order. Real service needs per-line void with a reason and an audit row. |
| 17 | High | **No receipt and no kitchen ticket printing.** A mid-tier restaurant cannot operate without a kitchen chit and a customer receipt. |
| 18 | High | **No shift / cash-drawer / X-Z reporting.** No way to open a shift, declare a float, count the drawer, or reconcile cash at close. |
| 19 | High | **No offline tolerance.** One wifi hiccup and staff cannot take orders. The whole app is live-fetch with no queue. |
| 20 | Medium | **Modifiers aren't linked to items.** There is no `item_modifier_groups` table; the client hardcodes "if `kandar` is true, show the one radio group and the one checkbox group". You cannot give satay a sauce choice without code changes. |
| 21 | Medium | **Modifier rules unenforced server-side.** `mode: 'radio'` is advisory — the API happily accepts three "kuah" options on one item, and accepts any option on any item. |
| 22 | Medium | **Dashboard month/year buckets mix `timestamp` and `timestamptz`.** `date_trunc('month', lt)` (already local) is compared against `date_trunc('month', d::timestamptz)` (re-interpreted in server TZ), so figures can land in the wrong bucket near month boundaries. |
| 23 | Medium | **Polling, not push.** Every client re-fetches the full order tree every 3s; each poll is 3 queries. At 8 devices that is ~160 queries/min to learn nothing. |
| 24 | Medium | **No split bill, no table transfer/merge, no multi-tender.** Standard restaurant operations with no path in the data model. |
| 25 | Medium | **No discounts.** No staff meal, no comp, no promo — so they get rung up as cash shortfalls. |
| 26 | Medium | Rate limiter keys on `req.ip` with no `trust proxy`. Behind any reverse proxy every request shares one IP and the limiter locks out the whole restaurant. |
| 27 | Medium | No `helmet`, no CSP, no security headers. Session token lives in `localStorage` (XSS-exfiltratable) rather than an httpOnly cookie. |
| 28 | Medium | **No tests, no CI.** Nothing stops the next change from re-breaking any of items 1–12. |
| 29 | Low | `/api/orders` is unbounded and unpaginated; forgotten open orders accumulate into every poll. |
| 30 | Low | `rl` rate-limit `Map` is never evicted — one entry per IP, forever. |
| 31 | Low | Dockerfile runs as root, no `HEALTHCHECK`, single-stage. |
| 32 | Low | Kitchen status taps are one-way; a mis-tap to "Ready" cannot be undone. |
| 33 | Low | Table tile colours are inverted — a table with food cooking renders green/`open`, a served table renders `busy`. |
| 34 | Low | 440 lines of inline JS in `index.html`, duplicated CSS between `style.css` and `customer.html`, `api.js` calling a global `showLogin()` that does not exist on the customer page. |
| 35 | Low | No sold-out ("86") daily reset, no item images, no BM/English toggle, no order-level note UI for staff, no QR token rotation. |
| 37 | **Critical** | **Voiding or discounting a partially-paid order leaves the shop owing the customer.** Reproduced on `main` after phase 05: a RM 21.20 order paid RM 15.00, then voided, ends at `total_cents 0 / paid 1500 / amount_due −1500`, stuck open forever because settling requires a zero balance. `hasPayments()` guards adding items but was never applied to void or discount. Fixed in phase 05b. |
| 38 | Medium | **The order screen labels the pre-tax subtotal "Total".** The cart panel sums lines client-side and excludes tax, while the payment modal shows the real tax-inclusive total — so staff quote RM 20.00 and the till charges RM 21.20. Phase 05b. |
| 39 | Medium | **No refund mechanism.** Once a payment is recorded there is no way to reverse it, which is why phase 05b can only refuse a void that would over-refund rather than handle it. Needs its own phase: refund rows against a payment, reason and approver, effect on the shift's cash reconciliation. |
| 40 | Low | **Discounts have no UI.** The backend and its admin-approval flow are implemented and tested, but nothing in the staff app reaches them. Phase 05b. |
| 36 | **High** | **No staff management and no way to change a PIN.** The API can create and delete users but never update one, and the Admin tab has no user screen at all — so the only way to change the admin PIN today is to delete every user row and let the app re-seed. That workaround stops working the moment phase 03 lands, because orders will reference the staff who took them. There is also no deactivation: a departing waiter can only be deleted, which would erase the name attached to their past bills. Restaurants have constant staff turnover; scheduled into phase 11. |

## Not bugs (checked, working as intended)

- Order status machine correctly refuses transitions out of `paid`/`cancelled`.
- Item/price data is snapshotted onto `order_items` at order time, so editing the
  menu never rewrites historical bills. This is the one genuinely well-designed
  part of the schema — keep it.
- Cash rounding to the nearest 5 sen is correct Malaysian practice.
- Double-tapping a payment is safely rejected by the status check.
- PIN hashing uses `scrypt` with a per-user salt and `timingSafeEqual`. Fine.
