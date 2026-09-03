# mamak-pos — rebuild plan

Target: a best-in-class POS for a **mid-tier Malaysian restaurant** — 20–60 covers,
5–15 staff, 2–4 order terminals, 1 kitchen display, QR self-ordering, cash-heavy,
running on a cheap mini-PC in the shop with unreliable wifi.

This document makes **every architectural decision up front** so the executing model
never has to deliberate. Deliberation is where small models burn tokens and go wrong.

---

## 1. The core decision: evolve, do not rewrite

**Keep** Node 20 + Express + Postgres + dependency-free frontend.
**Reject** React/Next/Vue/Tailwind/Prisma/an ORM/a bundler.

Why, concretely:

- The box in the shop is a RM1,500 mini-PC. `docker compose up` on Node+Postgres is
  the whole ops story. A build pipeline is a thing that breaks at 7pm on a Friday.
- A POS is ~15 screens of forms and lists. A framework buys little and costs a
  build step, a dependency tree, and hydration bugs on a cheap Android tablet.
- **Token economics.** A greenfield React rewrite is ~40–60 prompts where every
  prompt re-establishes context. Evolving this codebase is ~25 prompts that each
  touch 2–3 small files. For a Sonnet-class model that difference is the whole
  project.
- The existing schema's best idea — snapshotting item name/price onto `order_items`
  — already exists and would have to be re-derived in a rewrite.

**What does change:** the 500-line `server.js` and the 640-line `index.html` are
split into small modules (target ≤200 lines each). Not for elegance — so that a
prompt can say "read these two files, edit this one" and stay under ~4k tokens of
context. **File size is a token budget, and that is the main reason for the split.**

## 2. Frozen technical decisions

Executing model: implement these exactly. Do not substitute.

| Concern | Decision |
|---|---|
| Runtime | Node 20 LTS, CommonJS on the server, native ES modules in the browser (`<script type="module">`, no bundler) |
| DB | Postgres 16. Plain `pg`. Hand-written SQL. No ORM. |
| Migrations | Numbered files `migrations/NNN_name.sql`, applied in order by a `schema_migrations` table. `schema.sql` is deleted — migrations become the only truth. |
| Money | **Integer cents everywhere.** Floats never touch a total. All arithmetic in `src/lib/money.js`. |
| Auth | httpOnly + SameSite=Lax cookie session, CSRF token on mutations. Drop the `localStorage` bearer token. |
| Real-time | Server-Sent Events on `/api/stream`, in-process `EventEmitter` fan-out. No WebSocket, no Redis. |
| Offline | Service worker + IndexedDB outbox, server-side idempotency keys. |
| Printing | ESC/POS over TCP to network thermal printers. |
| Tests | Node's built-in `node:test` + `fetch` against a throwaway Postgres schema. Playwright for 6 E2E journeys only. |
| Styling | Keep the existing terracotta design system in `style.css`. It is genuinely good — do not replace it, extend it. |
| i18n | English + Bahasa Malaysia, a flat `{key: {en, ms}}` dictionary. Menu item names stay as entered (never machine-translate food names). |

## 3. Money and tax — the specification

Item 13 in the audit (tax charged: none) is the most expensive bug in the codebase.
It is specified here in full so it is implemented once, correctly.

**Malaysian F&B bill order of operations:**

```
subtotal        = Σ (unit_price + Σ modifier_prices) × qty     [cents]
service_charge  = round(subtotal × svc_rate_bp / 10000)         [0 if disabled]
service_tax     = round((subtotal + service_charge) × tax_rate_bp / 10000)
gross           = subtotal + service_charge + service_tax − discount
rounding        = (cash only) nearest 5 sen adjustment of gross
total           = gross + rounding
```

Rules the executing model must not deviate from:

- **Service tax on F&B is 6%** (`tax_rate_bp = 600`). The 2024 increase to 8%
  excluded food & beverage. The current UI label "SST (8%)" is wrong.
- **Service charge is optional and restaurant-set** (commonly 10%, `svc_rate_bp = 1000`),
  applied to the subtotal **before** tax. Many mamak shops charge none — default 0.
- **Tax applies to the service charge.** This ordering is not negotiable.
- **Round once per component**, half-up, in cents. Never round the subtotal.
- **5-sen rounding is cash-only** and applies to the final gross. Card and e-wallet
  are charged exact. (The existing `roundCashCents` is correct — keep it.)
- **Snapshot the rates onto the order at payment time** (`tax_rate_bp`,
  `svc_rate_bp` columns). When the rate changes next year, last year's receipts
  must not silently change. This is the mistake to avoid above all others.
- Store all five components on the order — `subtotal_cents`, `service_charge_cents`,
  `tax_cents`, `discount_cents`, `rounding_cents`, `total_cents`. A receipt must be
  reproducible from the row alone, without recomputation.

## 4. Target file layout

```
migrations/            001_baseline.sql, 002_money.sql, …   (numbered, forward-only)
src/
  server.js            app wiring only, ~60 lines
  db.js                pool + query helpers + migration runner
  lib/
    money.js           cents math, tax/service/rounding, formatting
    auth.js            session cookie, CSRF, requireRole middleware
    events.js          SSE hub
    errors.js          AppError + the two async wrappers
  routes/
    auth.js  menu.js  orders.js  payments.js  admin.js  reports.js  public.js  stream.js
  services/
    orders.js          order lifecycle, void, transfer, one-open-order rule
    billing.js         totals, split, tender
    printing.js        ESC/POS templates + dispatch
public/
  index.html           shell only, no inline logic
  js/
    api.js  pos.js  kitchen.js  dashboard.js  admin.js  shift.js  i18n.js  sw.js
  customer/
    index.html  customer.js
  style.css            shared design system (unchanged)
test/
  unit/ money.test.js  orders.test.js  billing.test.js
  e2e/  journeys.spec.js
docs/
  AUDIT.md  REBUILD-PLAN.md  MAP.md  prompts/
```

## 5. Phases

Each phase is one prompt file in `docs/prompts/`, is independently shippable, and
leaves the app working. **Run them in order** — later phases assume earlier schema.

| # | Phase | Why it is here | Effort |
|---|---|---|---|
| 00 | Safety net: migration runner, test harness, CI, `MAP.md` | Nothing else is safe to change without this | Sonnet 5, medium |
| 01 | Module split (server + frontend), no behaviour change | Makes every later prompt cheap. Pure mechanical move | Sonnet 5, medium |
| 02 | **Money & tax** — `money.js`, order total columns, receipt-accurate bills | Audit #13. Highest business impact | Sonnet 5, **high** |
| 03 | **Order integrity** — staff attribution, per-line void with reason, one-open-order index, audit log | Audit #14–16. Theft prevention | Sonnet 5, **high** |
| 04 | Menu model — `item_modifier_groups`, server-side modifier rules, 86 list w/ daily reset | Audit #20–21 | Sonnet 5, medium |
| 05 | Payments — split bill, multi-tender, change due, discounts/comps | Audit #24–25 | Sonnet 5, **high** |
| 06 | Real-time SSE + kill the 3s poll | Audit #23 | Sonnet 5, medium |
| 07 | Offline — service worker, IndexedDB outbox, idempotency keys | Audit #19. Trickiest correctness | Sonnet 5, **high** |
| 08 | Printing — kitchen chit + receipt over ESC/POS | Audit #17 | Sonnet 5, medium |
| 09 | Shifts & reports — open/close, float, drawer count, X/Z, CSV export | Audit #18 | Sonnet 5, medium |
| 10 | UX pass — POS ergonomics, kitchen display, customer QR, BM/EN | Layout & function polish | Sonnet 5, medium |
| 11 | Hardening — cookies+CSRF, helmet/CSP, trust proxy, non-root Docker, backups | Audit #26–27, #31 | Sonnet 5, medium |

**Where to spend a bigger model.** If there is budget for Opus on only three phases,
spend it on **02 (money), 03 (order integrity), and 07 (offline sync)** — the three
places where a plausible-looking wrong answer costs the restaurant real money and
is not caught by looking at the screen. Everything else is well-specified CRUD and
layout work that Sonnet 5 at medium effort does reliably.

## 6. Token strategy for a Sonnet-class executor

The plan is designed around five rules. They are restated in
`docs/prompts/_CONVENTIONS.md`, which every prompt references instead of repeating.

1. **Never explore.** `docs/MAP.md` states what every file does. The prompt names
   the exact files to read. Searching a repo is the single largest token sink.
2. **Read ≤3 files, ≤400 lines per task.** This is why phase 01 exists.
3. **No design decisions at execution time.** Every formula, column name, index,
   and status value is written out in the prompt. If the model is choosing, the
   prompt has failed.
4. **Every task ends in a command that proves it.** `npm test` plus a named
   assertion. The model must not report success off a code read.
5. **One concern per prompt. Refactoring anything not named is forbidden** — an
   unscoped "while I'm here" edit is how a small model turns a 3-file diff into a
   20-file diff nobody can review.

Expected cost per phase with these constraints: roughly 25k–60k tokens, phases 02,
03 and 07 at the top of that range. A phase that runs past ~100k has gone
off-script — stop it and re-scope rather than letting it continue.

## 7. Definition of "best in class"

The bar this rebuild is aiming at, so scope arguments have an answer:

- **Order entry in ≤3 taps** for a regular item, ≤5 with modifiers.
- **Never loses an order** — offline entry queues and reconciles, no double-send.
- **The bill is always defensible** — every cent traceable to a line, a rate, and
  the staff member who rang it.
- **Kitchen sees an order within 1 second**, no refresh, no tapping.
- **A shift closes in under 2 minutes** with a drawer count that reconciles.
- **A new waiter is productive in 10 minutes** without training material.
- **The shop can run for an hour with the internet down** and lose nothing.
