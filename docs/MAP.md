# Codebase map

**Read this instead of exploring.** Every prompt in `docs/prompts/` names the files
it needs; this file tells you what is in them and roughly where. Keep it accurate —
phase 01 rewrites it after the module split, and every later phase updates the rows
it touches.

## Current state (before phase 01)

| File | Lines | Contains |
|---|---|---|
| `server.js` | ~520 | Everything server-side. Sections in order: helpers & money (17–34), `requireAuth` + rate limiter (36–75), auth routes (78–95), public menu/table/QR-order routes (98–170), `buildOrderItems` + `insertOrder` (110–160), staff order routes (172–260), pay (265–285), `/api/summary` dashboard SQL (288–320), settings (320–335), admin menu/tables/QR/users (337–450), static routes (452–460), seed data + `boot()` (462–520) |
| `schema.sql` | 89 | All tables. Applied wholesale on every boot by `seed()`. To be replaced by `migrations/` in phase 00 |
| `migrate.js` | 18 | One-off `ALTER TABLE` for `modifier_options.available`. Redundant — the same ALTER runs in `seed()`. Delete in phase 00 |
| `public/index.html` | ~650 | Staff app. Lines 1–50 dark-mode + local CSS overrides, 50–200 markup for 4 tabs + 3 modals, 200–650 **all application JS inline**: state, auth, nav, POS/cart, kandar modal, send/pay, kitchen, dashboard, admin, live refresh |
| `public/customer/…` → currently `public/customer.html` | ~390 | QR self-order page. Inline CSS 8–121, markup 123–200, inline JS 200–390 (init from `/t/:token`, menu render, cart, submit) |
| `public/api.js` | 55 | `API` fetch wrapper: bearer token in `localStorage`, `login`/`logout`, `get/post/patch/del`, `getBlobUrl` for authenticated QR PNGs. **Loaded by the customer page but unused there** |
| `public/style.css` | 386 | The terracotta design system: tokens (4–26), buttons, login, app shell, cards, table grid, POS layout, cart, kitchen, dashboard, admin, modal, toast, customer extras, responsive. **Keep this — extend, don't replace** |
| `docker-compose.yml` | 34 | `db` (postgres:16-alpine) + `app`. Secrets via `${VAR}` from `.env` |
| `Dockerfile` | 7 | Single stage, runs as root. Hardened in phase 11 |

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
`Admin` user with `ADMIN_PIN`.
