# Phase 07 — Offline tolerance

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5 at **high** effort (Opus if available — silent data loss lives
here). **Expect ~55k tokens.** Depends on phases 03 and 06.

## Why

Audit #19. The shop's wifi drops. Today that means staff cannot take orders at all,
and any in-flight submit is lost with no indication. A POS that stops working when
the network hiccups is not a POS.

**The hard requirement: an order is never lost and never sent twice.** Everything
below serves that sentence.

## Files

Read: `public/js/api.js`, `public/js/pos.js`, `src/routes/orders.js`,
`src/services/orders.js`. Create: `public/js/outbox.js`, `public/sw.js`,
`migrations/006_idempotency.sql`, `test/unit/idempotency.test.js`.

## Do

**1. Server-side idempotency** — do this first; the client is worthless without it.

```sql
ALTER TABLE orders      ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_idem
  ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_items_idem
  ON order_items (idempotency_key) WHERE idempotency_key IS NOT NULL;
```

`POST /api/orders` and `POST /api/orders/:id/items` accept an
`Idempotency-Key` header (a client-generated UUID per submission batch). On a
duplicate key, **return the original result with 200** — do not create a second
order, and do not error. This makes retry safe, which is the whole basis of the
outbox. Test it directly: same key twice → one row, two identical responses.

**2. `public/js/outbox.js`** — an IndexedDB queue:
- `enqueue(request)` stores `{id: uuid, url, method, body, key, createdAt, attempts}`.
- `flush()` sends entries **in insertion order**, one at a time. Order matters: an
  append must never overtake the create it belongs to.
- Retry with backoff on network failure or 5xx. On a **4xx other than 409**, stop
  retrying, move the entry to a `failed` store, and surface it — a malformed order
  retried forever is worse than a visible error.
- Flush on `online`, on app start, and every 15 s while entries remain.

**3. POS writes through the outbox.** "Send to Kitchen" enqueues and returns
immediately; the UI shows the line as **pending** (dim, with a clock icon) until the
server confirms. Optimistic, but honest: pending lines are visibly not-yet-sent.
Never block the waiter on the network.

**4. `public/sw.js`** — a service worker that precaches the shell (`index.html`,
`/js/*`, `/style.css`) and the last `GET /api/menu` response, so a reload while
offline still opens a working app with the menu. Network-first for API GETs,
cache-first for static assets. **Never cache POSTs** — that is the outbox's job.
Bump a `CACHE_VERSION` constant on each deploy and delete old caches on `activate`.

**5. Offline UX.** A persistent banner: "Offline — N orders waiting to send". The
connection dot from phase 06 covers the online case. Payments and voids are
**not** queued — they require server confirmation and must fail loudly offline
("Cannot take payment while offline"). Only order entry works offline. This
asymmetry is deliberate: a mis-queued payment is a cash discrepancy nobody can
reconstruct.

**6. Conflict.** If the outbox flushes a create for a table that got an order while
offline, the server returns 409 with the existing order id (phase 03); the client
converts the queued create into an append to that order and retries once.

## Tests — `test/unit/idempotency.test.js`

- Same `Idempotency-Key` twice → one order row, both responses identical.
- Concurrent duplicate keys → one row, no 500.
- Append with a repeated key does not duplicate lines.
- A key is scoped to its route: the same key on create and append is not confused.

Plus a Playwright journey: go offline (`context.setOffline(true)`), enter two
orders, come back online, and assert exactly two orders exist with correct lines.

## Verify

```bash
npm test
npx playwright test -g "offline"
```

Then by hand with devtools set to Offline: take an order, confirm the pending state
and the banner, restore the network, and confirm it sends exactly once. Then do the
cruel version — go offline, hit send, and **reload the page** before restoring:
the order must still be in the outbox and must still arrive.
