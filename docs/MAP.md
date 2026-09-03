# Codebase map

**Read this instead of exploring.** Every prompt in `docs/prompts/` names the files
it needs; this file tells you what is in them and roughly where. Keep it accurate —
every phase updates the rows it touches.

## Current state (after phase 04 — menu and modifier model)

| File | Lines | Contains |
|---|---|---|
| `src/server.js` | 47 | Express app wiring only: json/static middleware, mounts the five route routers, the `/t/:token` customer-page route, `/`, `/api/health`, and `boot()` (seed, session-cleanup interval, `app.listen`) |
| `src/db.js` | 44 | Migration runner. Exports `pool`, `query`, `migrate()`. `migrate()` applies `migrations/*.sql` in filename order inside a transaction per file, tracked in `schema_migrations`; re-running applies nothing |
| `src/lib/errors.js` | 14 | `AppError(message, status)`, `awaitH` (wraps an authenticated route handler), `publicH` (same, but hides internal error text on public routes) |
| `src/lib/auth.js` | 43 | `hashPin`/`verifyPin` (scrypt), `requireRole(...roles)` — a plain Express middleware factory (`router.get(path, requireRole('admin'), awaitH(...))`) that looks up the bearer session and checks `SESSION_TTL`, `rateLimit(key,max,windowMs)` — an in-memory sliding-window limiter |
| `src/lib/money.js` | 26 | `cents2rm`, `rm2cents`, `roundCashCents`, plus (phase 02) `roundHalfUp` (0.5 away from zero), `lineTotal`, `computeBill({lines,taxRateBp,svcRateBp,discountCents,method}) -> {subtotal_cents, service_charge_cents, tax_cents, discount_cents, rounding_cents, total_cents}` (subtotal → svc → tax-on-subtotal+svc → discount → cash-only 5-sen rounding), `formatRM`. Pure, no DB — fully unit-testable |
| `src/routes/auth.js` | 28 | `POST /api/login` (rate-limited), `POST /api/logout` |
| `src/routes/public.js` | 60 | `GET /api/menu`, `GET /api/t/:token`, `POST /api/public/orders` (rate-limited QR ordering) — (phase 03) returns `201` on success and catches the same `one_open_order_per_table` `23505` race as `routes/orders.js`, returning `409 {error, order_id}` (a QR order does not yet write an `audit_log` row — only staff-created orders do). (Phase 04) `GET /api/menu`'s items query uses `services/orders.js`'s `ORDERABLE_SQL` instead of a bare `available` filter, and each item gets a `modifier_group_ids` array (from `item_modifier_groups`); groups now carry `min_select`/`max_select` |
| `src/routes/orders.js` | 188 | `GET /api/orders[?mode=recent]`, `GET /api/tables` (staff/kitchen, names only), `POST /api/orders`, `POST /api/orders/:id/items`, `POST /api/orders/:id/items/:lineId/void`, `PATCH /api/orders/:id` (status, `TRANSITIONS`/`BACKWARD` maps live here), `POST /api/orders/:id/pay` — (phase 02) recomputes the bill server-side from `order_items`/`order_item_mods` via `computeBill`, reads current `tax_rate_bp`/`svc_rate_bp` from `settings`, writes all eight money columns + snapshots the rates onto the order, returns `{ok, paid, bill: {subtotal, service_charge, tax, discount, rounding, total}}`. (Phase 03) every mutating route writes attribution (`opened_by`/`added_by`/`paid_by`/`closed_by` = `req.user.id`) and one `audit_log` row via `writeAudit`; `POST /api/orders` returns `201` and catches the `one_open_order_per_table` unique-violation (pg code `23505`) to return `409 {error, order_id}` instead of 500; the new void route sets `voided_at`/`voided_by`/`void_reason` (never deletes) — `staff` only while the order is still `sent`, `admin` any time before it's `paid`/`cancelled`; `/pay` excludes voided lines (`WHERE voided_at IS NULL`) from the recomputed bill; `TRANSITIONS` gained backward moves (`preparing→sent`, `ready→preparing`, `served→ready`) blocked for the `kitchen` role via the `BACKWARD` set |
| `src/routes/admin.js` | 185 | All `/api/admin/*`: menu CRUD, categories, modifier options, tables + QR PNG, users, (phase 03) `GET /api/admin/audit?limit=&entity_id=` — paginated `audit_log` joined to `users` for display name. (Phase 04) `GET /api/admin/menu` also returns `item_modifier_groups`; `PATCH /api/admin/items/:id` accepts `sort` and `sold_out_today` (sets/clears `sold_out_until` via a KL-timezone SQL literal, no `available` change — "sold out indefinitely" is still the existing `available` flag); new `PATCH /api/admin/categories/:id` (`name`/`sort`), `POST /api/admin/modifier_groups` (defaults `min_select`/`max_select` by `mode`, mirroring the migration's own backfill), `PATCH /api/admin/modifier_groups/:id` (`name`/`min_select`/`max_select`), `POST /api/admin/item_modifier_groups` (attach, `ON CONFLICT DO NOTHING`) and `DELETE /api/admin/item_modifier_groups/:itemId/:groupId` (detach) |
| `src/routes/reports.js` | 57 | `GET /api/summary` (dashboard SQL, `KL` timezone constant lives here), `GET|PATCH /api/settings` — (phase 02) now serves/accepts `{tax_rate_bp, svc_rate_bp}` (admin-only PATCH, validated 0-10000); the old fake `sst_on` boolean is retired (never read or written by any route) |
| `src/services/orders.js` | 138 | `buildOrderItems` (validates + prices a cart against the DB), `insertOrder`, `ordersWithItems` (joins orders+items+mods; `total` is still the live recomputed cart total for open orders) — shared by `routes/public.js` and `routes/orders.js`. (Phase 02) also returns the snapshotted bill breakdown (`subtotal`, `service_charge`, `tax`, `discount`, `rounding`, `grand_total`, `tax_rate_bp`, `svc_rate_bp`) — `null` until the order is paid, since that's when it's written. (Phase 03) `insertOrder(tableId, parsed, note, source, userId)` stamps `opened_by`/`added_by`; `ordersWithItems`'s live total excludes voided lines and each returned item now carries `id` (the `order_items` row id — needed to target a void) plus `voided`/`void_reason`; new `writeAudit(client, {userId, action, entityType, entityId, detail})` inserts one `audit_log` row (plain-object `detail` is serialised to `jsonb` by `pg` automatically). (Phase 04) exports `ORDERABLE_SQL` (a bare boolean SQL expression: `available AND` not sold out today in KL time — alias it in a SELECT list, or use bare in a WHERE); `buildOrderItems` now also loads each referenced item's attached `item_modifier_groups` and, per line, rejects any selected option whose group isn't attached to that item, and rejects any attached group's selection count outside `[min_select, max_select]` (message names the group, e.g. `"Kuah: choose exactly 1"`) |
| `src/seed.js` | 70 | `CATS`/`ITEMS` arrays and `seed()` (calls `migrate()`, then seeds categories/items/modifiers/tables/admin user if empty). (Phase 04) the `Kuah`/`Extra Lauk` groups are now created with explicit `min_select`/`max_select` (1/1 and 0/99 — the same values `migrations/004_menu.sql` backfills onto pre-existing rows) instead of inheriting the generic column defaults (0/1), and every kandar item is attached to both groups right after seeding — this attachment can't come from the migration's own backfill, since on a fresh install `seed()` inserts items *after* `migrate()` already ran against an empty `items` table |
| `migrations/001_baseline.sql` | 90 | The former `schema.sql`, verbatim, plus the `available` column `ALTER`. Applied by `src/db.js`'s `migrate()`. Idempotent — safe against a database that already has these tables |
| `migrations/002_money.sql` | 17 | Adds the eight bill columns to `orders` (`subtotal_cents`, `service_charge_cents`, `tax_cents`, `discount_cents`, `rounding_cents`, `total_cents`, `tax_rate_bp`, `svc_rate_bp`), backfills already-paid orders from `pay_total_cents`, seeds `settings` with `tax_rate_bp=600` / `svc_rate_bp=0` (`ON CONFLICT DO NOTHING`) |
| `migrations/003_integrity.sql` | 52 | Adds `orders.opened_by`/`paid_by`/`closed_by` and `order_items.added_by`/`voided_at`/`voided_by`/`void_reason` (all `INT REFERENCES users(id)` where applicable); creates `audit_log` (`id`, `at`, `user_id`, `action`, `entity_type`, `entity_id`, `detail jsonb`) + its two indexes; a `DO $$ ... $$` block cancels any pre-existing duplicate open orders per table (keeping the newest, logging the rest to `audit_log`) before `CREATE UNIQUE INDEX one_open_order_per_table ON orders (table_id) WHERE status NOT IN ('paid','cancelled')` |
| `migrations/004_menu.sql` | 21 | Creates `item_modifier_groups` (`item_id`, `group_id`, `sort`, PK on the pair); adds `modifier_groups.min_select`/`max_select` (defaults 0/1 — only meaningful per-mode after the two backfill `UPDATE`s below) and `items.sold_out_until DATE`; backfills every kandar item onto both existing groups (`WHERE i.kandar`, `ON CONFLICT DO NOTHING`) and sets `min_select=1, max_select=1` for `radio` groups / `min_select=0, max_select=99` for `checkbox` groups. This backfill only reaches rows that exist *at migration time* — `src/seed.js` does the equivalent for a fresh install, since it creates items and the two demo groups itself, after `migrate()` has already run |
| `public/index.html` | 237 | Staff app shell: markup only (4 tabs + 3 modals), a small inline `<style>` for dark mode / theme-toggle / layout tweaks not yet folded into `style.css`. Every interactive element carries `data-action` (+ `data-id` etc.) instead of `onclick`. Loads `api.js` (classic script, defines the global `API`) then `js/main.js` as `type="module"`. (Phase 02) the admin "SST Setting" toggle is now two rate inputs (`#tax-rate-input`, `#svc-rate-input`) + `#save-rates-btn`; the payment modal adds a breakdown div and a cash-received/change-due row (`#pay-cash-row`, `#cash-received-input`, `#pay-change-due`). (Phase 03) admin tab gained an "Activity Log" card (`#audit-log`). (Phase 04) the old "Kandar modal" is now the generic `#modal-bg` modifier-group modal with `id="mod-confirm-btn"` (disabled until every attached group's minimum is met) and `data-action="close-mod-modal"`/`"confirm-mods"`; admin tab gained "Categories" (`#admin-categories`, up/down `data-action="cat-move"`) and "Modifier Groups" (`#admin-groups` + a `#new-group-name`/`#new-group-mode`/`data-action="create-group"` mini-form) cards; "Menu Items" (renamed from "Menu Availability") now shows attach/detach group chips, up/down sort buttons, and a "Sold out today" checkbox alongside the existing indefinite-availability switch |
| `public/js/state.js` | 25 | The shared `state` object (`menu`, `tables`, `cart`, `selTable`, `activeCat`, `modItem` — renamed from `kandarItem` in phase 04, since the modal it drives is no longer kandar-specific — `pollTimer`, `pendingRemarkItem`) plus `$`, `fmt`, `esc`, `toast` |
| `public/js/pos.js` | 426 | Everything POS-tab: table select, menu/cart rendering, the modifier-group + remark modals, send-to-kitchen, payment modal/flow. Owns the delegated click listeners for `#tab-pos`, `#modal-bg`, `#pay-modal`, `#remark-modal`. Exports `loadAll`, `renderTables`. (Phase 02) `openPayModal` fetches `/api/settings` and shows a client-side preview breakdown (Subtotal / Service charge if non-zero / SST / Rounding (cash) / Total for both Card-eWallet and Cash) purely for display — it duplicates `computeBill`'s formula inline (no bundler to share `money.js` with the browser) and is never trusted; `/api/orders/:id/pay` always recomputes server-side. Cash also gets a cash-received input wired to live change-due via `updateChangeDue`. (Phase 03) cart lines carry the `order_items` row `id` + `voided`/`void_reason`; `renderCart` shows voided lines struck-through (excluded from the total) with a `Void` button on un-voided sent lines — `voidLine()` prompts for a reason and calls the void route; `sendOrder()` now catches a `409` from `POST /api/orders` (another tablet won the `one_open_order_per_table` race) and retries as an append to the returned `order_id` instead of failing. (Phase 04) `addItem` routes to `openModifierModal` whenever `item.modifier_group_ids.length` (kandar is now display-only); `openModifierModal`/`confirmModifiers` (renamed from the kandar-specific pair) render every attached group by its actual `mode`/`min_select`/`max_select` — inputs carry `data-group="<id>"`; `updateModifierValidity()` (wired to the modal's `change` event) disables `#mod-confirm-btn` until each group's minimum is satisfied |
| `public/js/kitchen.js` | 51 | `refreshKitchen`, `setSt`; delegated click listener on `#tab-kitchen`. (Phase 03) a voided line on the active-orders ticket renders struck-through with a **VOID** marker so the line cook stops cooking it |
| `public/js/dashboard.js` | 16 | `refreshDashboard` |
| `public/js/admin.js` | 177 | `refreshAdmin`, `toggleAvail`, `toggleModAvail`; delegated `change` listener on `#tab-admin` for availability toggles plus (phase 02) a `click` listener for `data-action="save-rates"` — `saveRates()` PATCHes `{tax_rate_bp, svc_rate_bp}` (percentages × 100, rounded) to `/api/settings`. Replaces the old `toggleSST`/`#sst-toggle`. (Phase 03) `refreshAdmin` also loads `GET /api/admin/audit?limit=100` and renders it into `#audit-log` (time, user, action, entity, JSON-stringified detail). (Phase 04) `refreshAdmin` caches the last `GET /api/admin/menu` response in module-level `lastMenu` (so move/reorder handlers don't need a round-trip to know current order); `toggleItemGroup` attaches/detaches via `POST`/`DELETE /api/admin/item_modifier_groups`; `moveItem`/`moveCategory` swap two entries and re-PATCH `sort=0..N-1` for every item/category in the new order (simple and correct regardless of prior tie values, since every seeded row starts at the column's default `sort=0`); `toggleSoldOutToday` PATCHes `{sold_out_today}`; `updateGroupSelect`/`createGroup` manage `min_select`/`max_select` and new groups |
| `public/js/nav.js` | 45 | `buildNav`, `switchTab`, `refreshLive` (the 3s poll dispatcher); delegated click listener on `#nav` |
| `public/js/main.js` | 46 | Theme toggle, login/logout, `showApp`/`showLogin`, wires the poll timer, page init. Exposes `window.showLogin` because `api.js` (a classic script) calls it directly on a 401 |
| `public/customer/index.html` | 156 | QR self-order page shell. Local `<style>` holds only the rules that are genuinely different from `style.css` for this page (sticky category bar, customer item-btn layout, `#cart-bar` sub-selectors, mobile bottom-sheet modal, loading spinner) — everything duplicated with `style.css` (`.c-header`, `.c-wrap`, `.c-success*`, base `#cart-bar`, `.remark-presets`) was moved there instead. Does **not** load `api.js` (unused on this page; its 401 handler called a `showLogin()` that doesn't exist here). (Phase 04) the `#kandar-modal`'s confirm button gained `id="km-confirm-btn"` and its actions were renamed `data-action="close-mods"`/`"confirm-mods"` — the DOM ids (`kandar-modal`, `km-*`) themselves were left alone since they're not user-visible |
| `public/customer/customer.js` | 228 | Init from `/t/:token`, menu render, cart, modifier-group/remark modals, submit — `type="module"`, imports `$`/`fmt`/`esc` from `../js/state.js`. All interactive elements use `data-action`, one delegated listener on `document.body`. (Phase 04) same generalisation as `pos.js`: `addItem` routes on `item.modifier_group_ids.length`, not `kandar`; `openModifiers`/`confirmModifiers`/`updateModifierValidity` render and validate from the item's actual attached groups; the local `kandarItem` variable is renamed `modItem`; the "Customisable" badge in `renderItems` now reflects `modifier_group_ids.length`, not `kandar` |
| `public/api.js` | 57 | `API` fetch wrapper: bearer token in `localStorage`, `login`/`logout`, `get/post/patch/del`, `getBlobUrl` for authenticated QR PNGs. Loaded only by the staff app now. (Phase 03) a non-ok response's thrown `Error` now also carries `.status` and `.body` (the parsed JSON) so callers can react to a specific status (e.g. `pos.js`'s 409-race retry), not just read `.message` |
| `public/style.css` | 412 | The terracotta design system: tokens, buttons, login, app shell, cards, table grid, POS layout, cart, kitchen, dashboard, admin, modal, `.remark-presets`, toast, customer-page extras (now the authoritative versions — see `public/customer/index.html` above), responsive. **Keep this — extend, don't replace**. (Phase 04) added `.btn:disabled`/`.btn:disabled:hover` (grey background, `not-allowed` cursor) — needed once `#mod-confirm-btn`/`#km-confirm-btn` started toggling `disabled` |
| `docker-compose.yml` | 34 | `db` (postgres:16-alpine) + `app`. Secrets via `${VAR}` from `.env` |
| `Dockerfile` | 7 | Single stage, runs as root, `CMD ["node", "src/server.js"]`. Hardened in phase 11 |
| `test/helper.js` | ~35 | `withDb(fn)`: creates a random `test_<hex>` schema against `TEST_DATABASE_URL`, points `src/db.js` at it via `PGOPTIONS` search_path, runs `migrate()`, calls `fn(db)`, then drops the schema. Tests never touch `public` |
| `test/unit/smoke.test.js` | 107 | Three regression tests (`node --test`): `migrate()` idempotency, admin login + wrong-PIN 401, `GET /api/orders?mode=recent` 200 (audit #9). `startApp()` clears the require-cache for every module under `src/` (except `db.js`, which `withDb()` already refreshed) before re-requiring `src/server.js`, so the route/service/lib tree picks up the current test's pool instead of a previous test's closed one. (Phase 02) the idempotency test counts `migrations/*.sql` on disk rather than hardcoding `1`, so it keeps working as later phases add migration files |
| `test/unit/money.test.js` | 190 | Phase 02: pure-function tests for `roundHalfUp`, `lineTotal`, `computeBill` (tax-on-subtotal+svc, discount, 100-line float-drift check), `formatRM`, plus one integration test — pay an order by cash, assert the stored `orders` row's components sum to `total_cents` (checked in integer cents via a direct `db.query`, not on the RM floats the API returns for display), and that changing the live `tax_rate_bp` afterwards does not alter the already-paid order. Two of the phase prompt's example cash-rounding numbers (gross 1063→1060, 1067→1070) are arithmetically impossible for "nearest 5 sen" (max adjustment magnitude is 2, not 3) and are replaced with the mathematically correct expected values for the same inputs — see the comment above those two tests |
| `test/unit/orders.test.js` | 265 | Phase 03 integration tests, each starting a fresh app + seeding a staff and a kitchen admin user via `setup()`: a real concurrent-request race on `POST /api/orders` for one table asserts one `201`/one `409` (with the winner's id) and exactly one row in the DB; a voided line is excluded from `total` but still comes back from the API with `voided`/`void_reason`; void validation (400 without a reason, 403 for `kitchen`); the staff-may-void-only-while-`sent`, admin-any-time rule; every mutating action (`order.create`/`.append`/`.void_line`/`.status`/`.pay`/`.cancel`) writes exactly one `audit_log` row with the correct `user_id`; backward status transitions 403 for `kitchen`, 200 for `staff` |
| `test/unit/modifiers.test.js` | 126 | Phase 04: calls `buildOrderItems` directly against a self-contained fixture (its own category/items/groups, not the seeded demo menu) — radio group 0/1/2 selected (400/ok/400), checkbox `max_select=3` with 4 selected (400), an option from a group not attached to the item (400, message names both), sold-out-today (400) vs. `sold_out_until` in the past (ok), and a kandar item still accepting the exact payload shape (one radio + N checkboxes) the UI has always sent |
| `playwright.config.js` | 36 | E2E config: single worker, `webServer` runs `node test/e2e/reset-db.js && node src/server.js` against a dedicated `mamak_e2e` database, `launchOptions.executablePath` points at a sandbox-preinstalled Chromium when present (falls back to Playwright's own resolution otherwise) |
| `test/e2e/reset-db.js` | 26 | Drops + recreates the `mamak_e2e` database before the app boots, so every E2E run starts from the same seeded, orders-empty state |
| `test/e2e/journeys.spec.js` | 76 | The six journeys named in `_CONVENTIONS.md`. **Implemented:** staff login → order → kitchen → pay; QR customer order. **Pending** (`test.skip`, with the phase that adds them): split bill (05), void a line (03), offline order reconciles (07), shift open → close (09) |
| `.github/workflows/ci.yml` | ~25 | Node 20 + `postgres:16-alpine` service, `npm ci && npm test`, on push and PR. Does not yet run the Playwright suite |

## Database tables

`users` (id, name, role∈admin/staff/kitchen, pin_hash) ·
`sessions` (token PK, user_id, created_at) ·
`categories` (id, name, sort) ·
`items` (id, category_id, name, price_cents, kandar, available, sort, **(phase 04)** sold_out_until —
`available AND (sold_out_until IS NULL OR sold_out_until < today-in-KL)` is "orderable"
(`services/orders.js`'s `ORDERABLE_SQL`); `kandar` is display-only from this phase on, no longer
read by any validation or modal-selection logic) ·
`modifier_groups` (id, name, mode∈radio/checkbox, **(phase 04)** min_select, max_select) ·
`modifier_options` (id, group_id, name, price_cents, available, sort) ·
`item_modifier_groups` (item_id, group_id, sort — PK on the pair) — **(phase 04)** which groups an
item actually offers; `buildOrderItems` rejects any option whose group isn't attached, and any
attached group's selection count outside `[min_select, max_select]` ·
`tables` (id, name, qr_token) ·
`orders` (id, table_id, status∈sent/preparing/ready/served/paid/cancelled, source∈staff/qr, note, created_at, updated_at, paid_at, pay_method, pay_total_cents, **(phase 02)** subtotal_cents, service_charge_cents, tax_cents, discount_cents, rounding_cents, total_cents, tax_rate_bp, svc_rate_bp — the last two are the rates *snapshotted at payment time*, independent of the live `settings` row, **(phase 03)** opened_by, paid_by, closed_by — all `INT REFERENCES users(id)`; a partial unique index `one_open_order_per_table` on `(table_id) WHERE status NOT IN ('paid','cancelled')` enforces at most one open order per table) ·
`order_items` (id, order_id, item_id, name, price_cents, qty, note, **(phase 03)** added_by, voided_at, voided_by, void_reason — a voided line is never deleted, just marked; excluded from every total) ·
`order_item_mods` (id, order_item_id, name, price_cents) ·
`settings` (key PK, value) — holds `tax_rate_bp` (default `600` = 6% SST) and `svc_rate_bp`
(default `0`) as of phase 02; the previously-unused `sst_on` key is orphaned, unread by any route ·
`audit_log` (id, at, user_id, action, entity_type, entity_id, detail jsonb) — **(phase 03)** one row per
mutating action (`order.create`/`.append`/`.void_line`/`.status`/`.cancel`/`.pay`; `discount.apply`/
`shift.open`/`shift.close` are reserved for later phases), written by `writeAudit()` in
`src/services/orders.js`

**Design rule already in place — preserve it:** `order_items` and `order_item_mods`
snapshot `name` and `price_cents` at order time. Editing or deleting a menu item
never rewrites a historical bill. Every new table must follow the same principle.

## API surface

Public (no auth): `GET /api/menu` (items now `orderable`-filtered and carry `modifier_group_ids`;
groups carry `min_select`/`max_select`) · `GET /api/t/:token` · `POST /api/public/orders`
(rate-limited 20 / 10 min / IP, 201 on success, 409 `{error, order_id}` if the table
already has an open order) · `GET /t/:token` (customer page) · `GET /api/health`

Authenticated: `POST /api/login` (rate-limited 10 / 10 min / IP) · `POST /api/logout` ·
`GET /api/tables` (all roles, names only) · `GET /api/orders[?mode=recent]` ·
`POST /api/orders` (201, or 409 `{error, order_id}` on the one-open-order-per-table race) ·
`POST /api/orders/:id/items` · `POST /api/orders/:id/items/:lineId/void` (`{reason}`, 3-200 chars;
staff while `sent`, admin any time before paid/cancelled) · `PATCH /api/orders/:id` (status;
`TRANSITIONS` now includes backward moves, 403 for `kitchen`) ·
`POST /api/orders/:id/pay` · `GET /api/summary` · `GET|PATCH /api/settings`

Admin only: `GET /api/admin/menu` (now also returns `item_modifier_groups`) ·
`POST|PATCH|DELETE /api/admin/items` (`PATCH` also takes `sort`, `sold_out_today`) ·
`POST|PATCH /api/admin/categories` (`PATCH` takes `name`/`sort`) ·
`POST|PATCH|DELETE /api/admin/modifier_options` ·
`POST|PATCH /api/admin/modifier_groups` · `POST /api/admin/item_modifier_groups` (attach) ·
`DELETE /api/admin/item_modifier_groups/:itemId/:groupId` (detach) ·
`GET|POST /api/admin/tables` · `GET /api/admin/tables/:id/qr.png` ·
`GET|POST|DELETE /api/admin/users` · `GET /api/admin/audit[?limit=&entity_id=]`

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
