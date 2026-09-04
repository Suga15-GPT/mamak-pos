# Redesign state

Short, living record of the master redesign programme. Read this plus your
targeted files instead of rereading the repository.

## Current phase

Complete. All seven phases (A–G) are implemented, tested and integrated.

## Completed phases

| Phase | What it delivered |
|---|---|
| A | Kitchen rounds, station tickets, derived order status, per-round printing |
| B | QR order-more, QR pause/approval, QR URL health, preparation stations, takeaway |
| C | Menu/category/food-option CRUD with safe deletes, table management, Admin sections |
| D | Mamak Modern design system, POS/kitchen/mobile redesign, overflow fixes |
| E | Dashboard aggregation endpoint, KPI cards, inline SVG charts |
| F | System health, print retry, off-device backup, move order |
| G | Regression/CRUD/print tests, responsive matrix, staff handbook |

## Architecture decisions (do not relitigate)

### Dining order vs kitchen round
- A **dining order** (`orders`) is the customer's bill. One per table (dine-in),
  or free-standing (takeaway).
- A **kitchen round** (`order_sends`) is one batch sent to preparation.
  `order_sends.seq_no` is 1-based per order. Every `order_items` row carries
  `send_id`.
- Preparation lifecycle lives on a **station ticket**
  (`order_send_tickets`, one row per `(send_id, station_code)`):
  `sent → preparing → ready → served`. Round 2 never inherits round 1's state.
- `orders.status` is kept, but is a **derived rollup** of the order's station
  tickets (operational priority: any `sent` → `sent`, else any `preparing` →
  `preparing`, else any `ready` → `ready`, else `served`).
  `paid`/`cancelled`/`refunded` stay terminal and are never overwritten by
  derivation. Keeping the column preserved payments, reports, Z reports and the
  one-open-order-per-table index unchanged — the reason the blast radius of this
  change stayed small.
- Void permission is decided by **the line's own ticket**, not the order: a
  still-`sent` add-on is staff-voidable even when round 1 was served an hour ago.

### Preparation stations
- `prep_stations` (code, name, sort, active, `printer_role`). Seeded: `kitchen`
  → the `kitchen` printer role, `drinks` → the `bar` role, falling back to the
  kitchen printer when no `bar` printer exists.
- `items.station_code` assigns a menu item to a station; default `kitchen`.
- `order_items.station_code` is a **snapshot** taken at order time (same rule as
  name/price).
- One round can span stations; each station gets its own ticket and its own
  chit. The customer bill stays a single order.

### Order types
- `orders.order_type` is `dine_in` | `takeaway`. `orders.table_id` is nullable;
  a takeaway order has no table, and a CHECK ties the two together. NULLs are
  distinct in the one-open-order-per-table index, so any number of takeaway
  orders can be open at once.

### QR ordering
- `POST /api/public/orders` appends a new round to the table's open order rather
  than 409-ing. Table identity comes from `qr_token` only; no staff API is
  exposed. Rate limits unchanged. Refused once the bill has a payment on it.
- Settings: `qr_ordering_enabled` (default on), `qr_require_approval`
  (default off). Pending rounds carry `approval_state='pending'` and produce no
  station ticket, no display card and no print until accepted. Rejecting voids
  the lines rather than deleting them.
- A customer polls `GET /api/public/sends/:ref` with the opaque `public_ref`
  returned at submit time — never an order id.
- QR links are derived per request (`src/lib/baseurl.js`), and Admin is told
  outright when they would resolve to localhost.

### UX decisions
- Every state is words + icon, never colour alone.
- One next action per kitchen ticket; no rows of disabled buttons.
- Tapping an item adds it; remarks are a per-line button. Configured food
  options still ask, because the kitchen depends on them.
- Navigation is role-based and painted into two shells (top tabs on a tablet, a
  bottom bar on a phone). Nothing frequent lives in a hamburger.
- Mobile overflow is fixed at source (`min-width:0` on grid/flex children, 16px
  inputs, scroll containers around wide content), not with zoom hacks.
- `window.prompt()` is replaced by a styled `ask()` dialog — some embedded
  browsers suppress prompts outright, which would have made "void a line"
  impossible on those devices.

### Money / integrity
Unchanged and preserved: integer cents, parameterised SQL, `esc()` on render,
snapshot rule, forward-only migrations, idempotency keys, payment guards,
shortfall guards, audit log, KL-midnight sold-out reset, role permissions.

One deliberate security change: the login limiter now only counts **failed**
attempts. Counting successes locked out a whole restaurant behind one router IP
at shift change; a brute-force attacker only ever produces failures.

## Migrations added

- `012_rounds_stations_order_types.sql` — stations, rounds, station tickets,
  order types, print-job round/station/retry columns, QR settings, and a
  backfill that puts every existing order into round 1 at its current state.
- `013_admin_crud.sql` — `tables.active`/`sort`, `modifier_groups.sort`,
  backup-reporting settings rows.

Both are forward-only, additive, and safe to run while the restaurant is open.

## Known temporary issues

- Off-device backup is **prepared, not configured**: `scripts/backup.sh` will
  push each dump to `BACKUP_REMOTE_TARGET` (S3-compatible, rsync/SSH, or a
  mounted path) and records the outcome, but no destination or credential
  exists in this repository — by design. The owner must set it in `.env`.
- Stations are `kitchen` and `drinks`, seeded and editable in the database.
  There is no station-management UI; the schema takes more without surgery.

## Next phase

None. Future-ready but deliberately not built: limited quantity counts,
scheduled menus, Call Staff / Request Bill from QR, table merge, extra stations
with their own admin UI, loyalty, e-Invoice.

## Latest test state

`npm test` 95/95 pass, three consecutive runs. Playwright 13/13 pass
(8 journeys + 5 responsive viewports). See the final report for pasted output.
