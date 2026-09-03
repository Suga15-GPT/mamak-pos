# Codebase map

**Read this instead of exploring.** Every prompt in `docs/prompts/` names the files
it needs; this file tells you what is in them and roughly where. Keep it accurate —
every phase updates the rows it touches.

## Current state (after phase 02 — money and tax)

| File | Lines | Contains |
|---|---|---|
| `src/server.js` | 47 | Express app wiring only: json/static middleware, mounts the five route routers, the `/t/:token` customer-page route, `/`, `/api/health`, and `boot()` (seed, session-cleanup interval, `app.listen`) |
| `src/db.js` | 44 | Migration runner. Exports `pool`, `query`, `migrate()`. `migrate()` applies `migrations/*.sql` in filename order inside a transaction per file, tracked in `schema_migrations`; re-running applies nothing |
| `src/lib/errors.js` | 14 | `AppError(message, status)`, `awaitH` (wraps an authenticated route handler), `publicH` (same, but hides internal error text on public routes) |
| `src/lib/auth.js` | 43 | `hashPin`/`verifyPin` (scrypt), `requireRole(...roles)` — a plain Express middleware factory (`router.get(path, requireRole('admin'), awaitH(...))`) that looks up the bearer session and checks `SESSION_TTL`, `rateLimit(key,max,windowMs)` — an in-memory sliding-window limiter |
| `src/lib/money.js` | 26 | `cents2rm`, `rm2cents`, `roundCashCents`, plus (phase 02) `roundHalfUp` (0.5 away from zero), `lineTotal`, `computeBill({lines,taxRateBp,svcRateBp,discountCents,method}) -> {subtotal_cents, service_charge_cents, tax_cents, discount_cents, rounding_cents, total_cents}` (subtotal → svc → tax-on-subtotal+svc → discount → cash-only 5-sen rounding), `formatRM`. Pure, no DB — fully unit-testable |
| `src/routes/auth.js` | 28 | `POST /api/login` (rate-limited), `POST /api/logout` |
| `src/routes/public.js` | 41 | `GET /api/menu`, `GET /api/t/:token`, `POST /api/public/orders` (rate-limited QR ordering) |
| `src/routes/orders.js` | 118 | `GET /api/orders[?mode=recent]`, `GET /api/tables` (staff/kitchen, names only), `POST /api/orders`, `POST /api/orders/:id/items`, `PATCH /api/orders/:id` (status, `TRANSITIONS` map lives here), `POST /api/orders/:id/pay` — (phase 02) recomputes the bill server-side from `order_items`/`order_item_mods` via `computeBill`, reads current `tax_rate_bp`/`svc_rate_bp` from `settings`, writes all eight money columns + snapshots the rates onto the order, returns `{ok, paid, bill: {subtotal, service_charge, tax, discount, rounding, total}}` |
| `src/routes/admin.js` | 113 | All `/api/admin/*`: menu CRUD, categories, modifier options, tables + QR PNG, users |
| `src/routes/reports.js` | 57 | `GET /api/summary` (dashboard SQL, `KL` timezone constant lives here), `GET|PATCH /api/settings` — (phase 02) now serves/accepts `{tax_rate_bp, svc_rate_bp}` (admin-only PATCH, validated 0-10000); the old fake `sst_on` boolean is retired (never read or written by any route) |
| `src/services/orders.js` | 92 | `buildOrderItems` (validates + prices a cart against the DB), `insertOrder`, `ordersWithItems` (joins orders+items+mods; `total` is still the live recomputed cart total for open orders) — shared by `routes/public.js` and `routes/orders.js`. (Phase 02) also returns the snapshotted bill breakdown (`subtotal`, `service_charge`, `tax`, `discount`, `rounding`, `grand_total`, `tax_rate_bp`, `svc_rate_bp`) — `null` until the order is paid, since that's when it's written |
| `src/seed.js` | 61 | `CATS`/`ITEMS` arrays and `seed()` (calls `migrate()`, then seeds categories/items/modifiers/tables/admin user if empty) |
| `migrations/001_baseline.sql` | 90 | The former `schema.sql`, verbatim, plus the `available` column `ALTER`. Applied by `src/db.js`'s `migrate()`. Idempotent — safe against a database that already has these tables |
| `migrations/002_money.sql` | 17 | Adds the eight bill columns to `orders` (`subtotal_cents`, `service_charge_cents`, `tax_cents`, `discount_cents`, `rounding_cents`, `total_cents`, `tax_rate_bp`, `svc_rate_bp`), backfills already-paid orders from `pay_total_cents`, seeds `settings` with `tax_rate_bp=600` / `svc_rate_bp=0` (`ON CONFLICT DO NOTHING`) |
| `public/index.html` | 210 | Staff app shell: markup only (4 tabs + 3 modals), a small inline `<style>` for dark mode / theme-toggle / layout tweaks not yet folded into `style.css`. Every interactive element carries `data-action` (+ `data-id` etc.) instead of `onclick`. Loads `api.js` (classic script, defines the global `API`) then `js/main.js` as `type="module"`. (Phase 02) the admin "SST Setting" toggle is now two rate inputs (`#tax-rate-input`, `#svc-rate-input`) + `#save-rates-btn`; the payment modal adds a breakdown div and a cash-received/change-due row (`#pay-cash-row`, `#cash-received-input`, `#pay-change-due`) |
| `public/js/state.js` | 25 | The shared `state` object (`menu`, `tables`, `cart`, `selTable`, `activeCat`, `kandarItem`, `pollTimer`, `pendingRemarkItem`) plus `$`, `fmt`, `esc`, `toast` |
| `public/js/pos.js` | 359 | Everything POS-tab: table select, menu/cart rendering, kandar + remark modals, send-to-kitchen, payment modal/flow. Owns the delegated click listeners for `#tab-pos`, `#modal-bg`, `#pay-modal`, `#remark-modal`. Exports `loadAll`, `renderTables`. (Phase 02) `openPayModal` fetches `/api/settings` and shows a client-side preview breakdown (Subtotal / Service charge if non-zero / SST / Rounding (cash) / Total for both Card-eWallet and Cash) purely for display — it duplicates `computeBill`'s formula inline (no bundler to share `money.js` with the browser) and is never trusted; `/api/orders/:id/pay` always recomputes server-side. Cash also gets a cash-received input wired to live change-due via `updateChangeDue` |
| `public/js/kitchen.js` | 51 | `refreshKitchen`, `setSt`; delegated click listener on `#tab-kitchen` |
| `public/js/dashboard.js` | 16 | `refreshDashboard` |
| `public/js/admin.js` | 65 | `refreshAdmin`, `toggleAvail`, `toggleModAvail`; delegated `change` listener on `#tab-admin` for availability toggles plus (phase 02) a `click` listener for `data-action="save-rates"` — `saveRates()` PATCHes `{tax_rate_bp, svc_rate_bp}` (percentages × 100, rounded) to `/api/settings`. Replaces the old `toggleSST`/`#sst-toggle` |
| `public/js/nav.js` | 45 | `buildNav`, `switchTab`, `refreshLive` (the 3s poll dispatcher); delegated click listener on `#nav` |
| `public/js/main.js` | 46 | Theme toggle, login/logout, `showApp`/`showLogin`, wires the poll timer, page init. Exposes `window.showLogin` because `api.js` (a classic script) calls it directly on a 401 |
| `public/customer/index.html` | 156 | QR self-order page shell. Local `<style>` holds only the rules that are genuinely different from `style.css` for this page (sticky category bar, customer item-btn layout, `#cart-bar` sub-selectors, mobile bottom-sheet modal, loading spinner) — everything duplicated with `style.css` (`.c-header`, `.c-wrap`, `.c-success*`, base `#cart-bar`, `.remark-presets`) was moved there instead. Does **not** load `api.js` (unused on this page; its 401 handler called a `showLogin()` that doesn't exist here) |
| `public/customer/customer.js` | 212 | Init from `/t/:token`, menu render, cart, kandar/remark modals, submit — `type="module"`, imports `$`/`fmt`/`esc` from `../js/state.js`. All interactive elements use `data-action`, one delegated listener on `document.body` |
| `public/api.js` | 57 | `API` fetch wrapper: bearer token in `localStorage`, `login`/`logout`, `get/post/patch/del`, `getBlobUrl` for authenticated QR PNGs. Loaded only by the staff app now |
| `public/style.css` | 410 | The terracotta design system: tokens, buttons, login, app shell, cards, table grid, POS layout, cart, kitchen, dashboard, admin, modal, `.remark-presets`, toast, customer-page extras (now the authoritative versions — see `public/customer/index.html` above), responsive. **Keep this — extend, don't replace** |
| `docker-compose.yml` | 34 | `db` (postgres:16-alpine) + `app`. Secrets via `${VAR}` from `.env` |
| `Dockerfile` | 7 | Single stage, runs as root, `CMD ["node", "src/server.js"]`. Hardened in phase 11 |
| `test/helper.js` | ~35 | `withDb(fn)`: creates a random `test_<hex>` schema against `TEST_DATABASE_URL`, points `src/db.js` at it via `PGOPTIONS` search_path, runs `migrate()`, calls `fn(db)`, then drops the schema. Tests never touch `public` |
| `test/unit/smoke.test.js` | 107 | Three regression tests (`node --test`): `migrate()` idempotency, admin login + wrong-PIN 401, `GET /api/orders?mode=recent` 200 (audit #9). `startApp()` clears the require-cache for every module under `src/` (except `db.js`, which `withDb()` already refreshed) before re-requiring `src/server.js`, so the route/service/lib tree picks up the current test's pool instead of a previous test's closed one. (Phase 02) the idempotency test counts `migrations/*.sql` on disk rather than hardcoding `1`, so it keeps working as later phases add migration files |
| `test/unit/money.test.js` | 190 | Phase 02: pure-function tests for `roundHalfUp`, `lineTotal`, `computeBill` (tax-on-subtotal+svc, discount, 100-line float-drift check), `formatRM`, plus one integration test — pay an order by cash, assert the stored `orders` row's components sum to `total_cents` (checked in integer cents via a direct `db.query`, not on the RM floats the API returns for display), and that changing the live `tax_rate_bp` afterwards does not alter the already-paid order. Two of the phase prompt's example cash-rounding numbers (gross 1063→1060, 1067→1070) are arithmetically impossible for "nearest 5 sen" (max adjustment magnitude is 2, not 3) and are replaced with the mathematically correct expected values for the same inputs — see the comment above those two tests |
| `playwright.config.js` | 36 | E2E config: single worker, `webServer` runs `node test/e2e/reset-db.js && node src/server.js` against a dedicated `mamak_e2e` database, `launchOptions.executablePath` points at a sandbox-preinstalled Chromium when present (falls back to Playwright's own resolution otherwise) |
| `test/e2e/reset-db.js` | 26 | Drops + recreates the `mamak_e2e` database before the app boots, so every E2E run starts from the same seeded, orders-empty state |
| `test/e2e/journeys.spec.js` | 76 | The six journeys named in `_CONVENTIONS.md`. **Implemented:** staff login → order → kitchen → pay; QR customer order. **Pending** (`test.skip`, with the phase that adds them): split bill (05), void a line (03), offline order reconciles (07), shift open → close (09) |
| `.github/workflows/ci.yml` | ~25 | Node 20 + `postgres:16-alpine` service, `npm ci && npm test`, on push and PR. Does not yet run the Playwright suite |

## Database tables

`users` (id, name, role∈admin/staff/kitchen, pin_hash) ·
`sessions` (token PK, user_id, created_at) ·
`categories` (id, name, sort) ·
`items` (id, category_id, name, price_cents, kandar, available, sort) ·
`modifier_groups` (id, name, mode∈radio/checkbox) ·
`modifier_options` (id, group_id, name, price_cents, available, sort) ·
`tables` (id, name, qr_token) ·
`orders` (id, table_id, status∈sent/preparing/ready/served/paid/cancelled, source∈staff/qr, note, created_at, updated_at, paid_at, pay_method, pay_total_cents, **(phase 02)** subtotal_cents, service_charge_cents, tax_cents, discount_cents, rounding_cents, total_cents, tax_rate_bp, svc_rate_bp — the last two are the rates *snapshotted at payment time*, independent of the live `settings` row) ·
`order_items` (id, order_id, item_id, name, price_cents, qty, note) ·
`order_item_mods` (id, order_item_id, name, price_cents) ·
`settings` (key PK, value) — holds `tax_rate_bp` (default `600` = 6% SST) and `svc_rate_bp`
(default `0`) as of phase 02; the previously-unused `sst_on` key is orphaned, unread by any route

**Design rule already in place — preserve it:** `order_items` and `order_item_mods`
snapshot `name` and `price_cents` at order time. Editing or deleting a menu item
never rewrites a historical bill. Every new table must follow the same principle.

## API surface

Public (no auth): `GET /api/menu` · `GET /api/t/:token` · `POST /api/public/orders`
(rate-limited 20 / 10 min / IP) · `GET /t/:token` (customer page) · `GET /api/health`

Authenticated: `POST /api/login` (rate-limited 10 / 10 min / IP) · `POST /api/logout` ·
`GET /api/tables` (all roles, names only) · `GET /api/orders[?mode=recent]` ·
`POST /api/orders` · `POST /api/orders/:id/items` · `PATCH /api/orders/:id` (status) ·
`POST /api/orders/:id/pay` · `GET /api/summary` · `GET|PATCH /api/settings`

Admin only: `GET /api/admin/menu` · `POST|PATCH|DELETE /api/admin/items` ·
`POST /api/admin/categories` · `POST|PATCH|DELETE /api/admin/modifier_options` ·
`GET|POST /api/admin/tables` · `GET /api/admin/tables/:id/qr.png` ·
`GET|POST|DELETE /api/admin/users`

## Conventions in the existing code

- `awaitH(fn)` wraps an authenticated route; `publicH(fn)` wraps a public one and
  hides internal error text. Thrown errors carrying `.status` become that response
  — throw them via `AppError(message, status)` (`src/lib/errors.js`).
- Auth is plain Express middleware: `router.get('/path', requireRole('admin'), awaitH(...))`.
  `requireRole(...roles)` (`src/lib/auth.js`) looks up the bearer session and 403s
  if the user's role isn't in the list; pass no roles to just require *a* session.
- Money is integer cents in the DB; `cents2rm`/`rm2cents` (`src/lib/money.js`)
  convert at the edges only.
- Client-side, every string rendered into HTML goes through `esc()` (`public/js/state.js`
  on the staff app, `../js/state.js` re-imported on the customer page). Dynamic
  markup uses `data-action`/`data-id` attributes plus one delegated `click` (or
  `change`) listener per container — never an inline `onclick`/`onchange`.
- Shared staff-app state (`menu`, `tables`, `cart`, `selTable`, `activeCat`, …) lives
  in the single `state` object exported by `public/js/state.js`; import and mutate
  `state.foo`, don't reassign a destructured local.

## Local development

```bash
docker compose up                      # full stack
# or against a local postgres:
DATABASE_URL=postgres://postgres:PASS@localhost:5432/postgres \
  ADMIN_PIN=1234 BASE_URL=http://localhost:3000 node src/server.js
```

Seeds on first boot: 6 categories, 25 items, 2 modifier groups, 14 tables, and an
`Admin` user with `ADMIN_PIN`. Boot runs `src/db.js`'s `migrate()` first, applying
`migrations/*.sql` in order.

```bash
npm test              # node --test against TEST_DATABASE_URL (default localhost:5432/postgres)
npx playwright test   # six E2E journeys against a dedicated mamak_e2e database (auto-booted)
```
