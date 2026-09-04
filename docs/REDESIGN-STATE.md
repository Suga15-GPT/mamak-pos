# Redesign state

Short, living record of the master redesign programme. Read this plus your
targeted files instead of rereading the repository.

## Current phase

Phase A — order architecture and kitchen rounds.

## Completed phases

_(none yet)_

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
- `orders.status` is kept, but is now a **derived rollup** of the order's
  station tickets (operational priority: any `sent` → `sent`, else any
  `preparing` → `preparing`, else any `ready` → `ready`, else `served`).
  `paid`/`cancelled`/`refunded` stay terminal and are never overwritten by
  derivation. Keeping the column preserves payments, reports, Z reports and the
  one-open-order-per-table index unchanged.

### Preparation stations
- `prep_stations` (code, name, sort, active). Seeded: `kitchen`, `drinks`.
- `items.station_code` assigns a menu item to a station; default `kitchen`.
- `order_items.station_code` is a **snapshot** taken at order time (same rule as
  name/price).
- One round can span stations; each station gets its own ticket and its own
  chit. The customer bill stays a single order.

### Order types
- `orders.order_type` is `dine_in` | `takeaway`. `orders.table_id` is nullable;
  a takeaway order has no table. Takeaway is not a fake table tile.

### QR ordering
- `POST /api/public/orders` appends a new round to the table's open order rather
  than 409-ing. Table identity comes from `qr_token` only; no staff API is
  exposed. Rate limits unchanged.
- Settings: `qr_ordering_enabled` (default on), `qr_require_approval`
  (default off). Pending rounds carry `approval_state='pending'` and produce no
  station ticket until accepted.
- A customer polls `GET /api/public/sends/:ref` with the opaque `public_ref`
  returned at submit time — never an order id.

### Money / integrity
Unchanged and preserved: integer cents, parameterised SQL, `esc()` on render,
snapshot rule, forward-only migrations, idempotency keys, payment guards,
audit log, KL-midnight sold-out reset.

## Migrations added

_(pending)_

## Known temporary issues

_(none)_

## Next phase

Phase B — QR ordering, preparation stations, order types.

## Latest test state

Baseline before the programme: `npm test` 72/72 pass; Playwright 6/6 pass.
