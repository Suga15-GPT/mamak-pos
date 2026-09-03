# Phase 01 — Module split (no behaviour change)

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~35k tokens.**

## Why

`server.js` is 520 lines and `index.html` carries 440 lines of inline JS. Every
later phase would have to load them whole. Splitting them is what makes phases
02–11 affordable. **This phase changes no behaviour whatsoever** — it is a move
operation. If a test result changes, you have made a mistake.

## Files

Read: `server.js`, `public/index.html`, `docs/MAP.md`.
Create the layout in `docs/REBUILD-PLAN.md` §4.

## Do

**Server** — split `server.js` into:

| New file | Takes |
|---|---|
| `src/server.js` | express wiring, static, route mounting, `boot()`. ~60 lines |
| `src/lib/errors.js` | `awaitH`, `publicH`, an `AppError(message, status)` helper |
| `src/lib/auth.js` | `hashPin`, `verifyPin`, the rate limiter, session lookup |
| `src/lib/money.js` | `cents2rm`, `rm2cents`, `roundCashCents` (phase 02 grows this) |
| `src/routes/auth.js` | login, logout |
| `src/routes/public.js` | `/api/menu`, `/api/t/:token`, `/api/public/orders` |
| `src/routes/orders.js` | order list/create/append/status/pay |
| `src/routes/admin.js` | all `/api/admin/*` |
| `src/routes/reports.js` | `/api/summary`, `/api/settings` |
| `src/services/orders.js` | `buildOrderItems`, `insertOrder`, `ordersWithItems` |
| `src/seed.js` | the `CATS`/`ITEMS` arrays and seeding |

**Convert `requireAuth` to normal Express middleware.** Replace the
`const auth = await requireAuth('admin'); await auth(req,res,()=>{}); if (res.headersSent) return;`
dance at the top of ~20 handlers with `router.get('/path', requireRole('admin'), awaitH(...))`.
`requireRole(...roles)` returns a plain `(req,res,next)` middleware. This removes a
fragile `res.headersSent` check from every route.

**Frontend** — `public/index.html` keeps markup only. Move the inline JS to
`public/js/`: `pos.js`, `kitchen.js`, `dashboard.js`, `admin.js`, `nav.js`,
`state.js` (shared state + `$`, `fmt`, `esc`, `toast`). Load with
`<script type="module" src="/js/main.js">`. Replace the inline `onclick="…"`
attributes with `addEventListener` bound by `data-action` / `data-id` attributes —
this also finishes removing the attribute-escaping hazard (audit #11).

Move `public/customer.html` → `public/customer/index.html` with its JS in
`public/customer/customer.js`, and update the `/t/:token` route's `sendFile` path.
Move the CSS duplicated between `customer.html` and `style.css` into `style.css`.
Stop loading `api.js` on the customer page — it is unused there and its 401 handler
calls a `showLogin()` that does not exist on that page.

## Do not

Do not fix any bug, add any feature, change any endpoint path, response shape, or
CSS rule. Behaviour is frozen. Bug fixes belong to their own phases.

## Verify

```bash
npm test                     # same results as before the split
npx playwright test          # all six journeys still pass
```

Then by hand: log in as admin **and** as a staff user, take an order, send it,
watch it appear on the kitchen tab, pay it, and place one customer QR order.
Rewrite `docs/MAP.md` for the new layout — that file is the input to every later
phase, so it must be exact.
