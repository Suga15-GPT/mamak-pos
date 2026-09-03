# Codebase map

**Read this instead of exploring.** Every prompt in `docs/prompts/` names the files
it needs; this file tells you what is in them and roughly where. Keep it accurate —
phase 01 rewrites it after the module split, and every later phase updates the rows
it touches.

## Current state (before phase 01)

| File | Lines | Contains |
|---|---|---|
| `server.js` | ~524 | Everything server-side. Sections in order: helpers & money (16–33), `requireAuth` + rate limiter (40–63), auth routes (64–83), public menu/table/QR-order routes (84–193), `buildOrderItems` + `insertOrder` (104–193), staff order routes (194–259), pay (260–282), `/api/summary` dashboard SQL (283–313), settings (314–329), admin menu/tables/QR/users (330–443), static routes (444–470), seed data + `boot()` (471–525). `pool` and `migrate()` now come from `src/db.js` — `seed()` calls `migrate()` instead of reading `schema.sql` wholesale |
| `migrations/001_baseline.sql` | 90 | The former `schema.sql`, verbatim, plus the `available` column `ALTER` that used to run inline in `seed()`. Applied by `src/db.js`'s `migrate()`. Idempotent — safe against a database that already has these tables |
| `src/db.js` | 44 | Migration runner. Exports `pool`, `query`, `migrate()`. `migrate()` applies `migrations/*.sql` in filename order inside a transaction per file, tracked in `schema_migrations`; re-running applies nothing |
| `public/index.html` | ~650 | Staff app. Lines 1–50 dark-mode + local CSS overrides, 50–200 markup for 4 tabs + 3 modals, 200–650 **all application JS inline**: state, auth, nav, POS/cart, kandar modal, send/pay, kitchen, dashboard, admin, live refresh |
| `public/customer/…` → currently `public/customer.html` | ~390 | QR self-order page. Inline CSS 8–121, markup 123–200, inline JS 200–390 (init from `/t/:token`, menu render, cart, submit) |
| `public/api.js` | 55 | `API` fetch wrapper: bearer token in `localStorage`, `login`/`logout`, `get/post/patch/del`, `getBlobUrl` for authenticated QR PNGs. **Loaded by the customer page but unused there** |
| `public/style.css` | 386 | The terracotta design system: tokens (4–26), buttons, login, app shell, cards, table grid, POS layout, cart, kitchen, dashboard, admin, modal, toast, customer extras, responsive. **Keep this — extend, don't replace** |
| `docker-compose.yml` | 34 | `db` (postgres:16-alpine) + `app`. Secrets via `${VAR}` from `.env` |
| `Dockerfile` | 7 | Single stage, runs as root. Hardened in phase 11 |
| `test/helper.js` | ~35 | `withDb(fn)`: creates a random `test_<hex>` schema against `TEST_DATABASE_URL`, points `src/db.js` at it via `PGOPTIONS` search_path, runs `migrate()`, calls `fn(db)`, then drops the schema. Tests never touch `public` |
| `test/unit/smoke.test.js` | ~90 | Three regression tests (`node --test`): `migrate()` idempotency, admin login + wrong-PIN 401, `GET /api/orders?mode=recent` 200 (audit #9). The login/orders tests boot the real `server.js` on a random port via `fetch` |
| `.github/workflows/ci.yml` | ~25 | Node 20 + `postgres:16-alpine` service, `npm ci && npm test`, on push and PR |

## Database tables

`users` (id, name, role∈admin/staff/kitchen, pin_hash) ·
`sessions` (token PK, user_id, created_at) ·
`categories` (id, name, sort) ·
`items` (id, category_id, name, price_cents, kandar, available, sort) ·
`modifier_groups` (id, name, mode∈radio/checkbox) ·
`modifier_options` (id, group_id, name, price_cents, available, sort) ·
`tables` (id, name, qr_token) ·
`orders` (id, table_id, status∈sent/preparing/ready/served/paid/cancelled, source∈staff/qr, note, created_at, updated_at, paid_at, pay_method, pay_total_cents) ·
`order_items` (id, order_id, item_id, name, price_cents, qty, note) ·
`order_item_mods` (id, order_item_id, name, price_cents) ·
`settings` (key PK, value)

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
  hides internal error text. Thrown errors carrying `.status` become that response.
- Auth is used as `const auth = await requireAuth('admin'); await auth(req,res,()=>{}); if (res.headersSent) return;`
  — an odd factory pattern. Phase 01 converts it to plain Express middleware.
- Money is integer cents in the DB; `cents2rm`/`rm2cents` convert at the edges only.
- Client-side, every string rendered into HTML goes through `esc()`. Handlers take
  an **id** and look the record up — never interpolate a name into an attribute.

## Local development

```bash
docker compose up                      # full stack
# or against a local postgres:
DATABASE_URL=postgres://postgres:PASS@localhost:5432/postgres \
  ADMIN_PIN=1234 BASE_URL=http://localhost:3000 node server.js
```

Seeds on first boot: 6 categories, 25 items, 2 modifier groups, 14 tables, and an
`Admin` user with `ADMIN_PIN`. Boot runs `src/db.js`'s `migrate()` first, applying
`migrations/*.sql` in order.

```bash
npm test    # node --test against TEST_DATABASE_URL (default localhost:5432/postgres)
```
