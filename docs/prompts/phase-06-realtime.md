# Phase 06 — Real-time updates (SSE)

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~25k tokens.**

## Why

Audit #23. Every client re-fetches the entire open-order tree every 3 seconds, and
each fetch is three queries. Eight devices is ~160 queries a minute, almost all of
them returning "nothing changed" — while a new order still takes up to 3 seconds to
reach the kitchen, and the kitchen screen is the one place latency is felt.

## Files

Read: `src/server.js`, `src/routes/orders.js`, `public/js/state.js`,
`public/js/kitchen.js`, `public/js/pos.js`.
Create: `src/lib/events.js`, `src/routes/stream.js`.

## Do

**1. `src/lib/events.js`** — a tiny in-process hub. One restaurant runs one server
process; do not reach for Redis or Postgres `LISTEN/NOTIFY`.

```js
const bus = new EventEmitter();      // bus.setMaxListeners(0)
publish(type, payload)               // increments a monotonic seq, fans out
subscribe(fn)                        // → unsubscribe
recent(sinceSeq)                     // replay from a ring buffer of the last 200
```

Event types: `order.created`, `order.updated`, `order.paid`, `order.voided`,
`menu.updated`. Payload carries `{ seq, type, order_id, table_id }` — **ids only,
never the full order**. Clients refetch what they need. This keeps the stream tiny
and avoids leaking data to a role that should not see it.

**2. `GET /api/stream`** (`src/routes/stream.js`), authenticated, roles
admin/staff/kitchen:
- `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`,
  and `X-Accel-Buffering: no` (nginx buffers SSE to death without it).
- On connect, honour `Last-Event-ID` / `?since=` by replaying from `recent()` so a
  reconnect never misses an order.
- Heartbeat comment (`: ping\n\n`) every 25 s to survive proxy idle timeouts.
- Clean up the subscription on `req.on('close')`. Leaking subscriptions here is the
  standard way an SSE implementation quietly eats memory over a service.

**3. Publish** from the order routes: create, append, status change, void, pay.
Publish **after** the transaction commits, never inside it — otherwise clients
refetch a row that has not landed yet and see stale data.

**4. Client.** `public/js/state.js` opens one `EventSource` for the whole app and
re-dispatches to whichever tab is active. Delete the `setInterval(refreshLive,3000)`.
Rules:
- Reconnect with backoff (1s, 2s, 4s, capped at 30s); `EventSource` retries on its
  own but the backoff matters when the server is down.
- Keep a **60-second safety poll** as a backstop for a wedged proxy. Belt and
  braces is correct here: a kitchen that silently stops updating is worse than a
  wasted request per minute.
- Show a connection dot in the header — green connected, amber reconnecting, red
  offline. Staff must be able to tell at a glance whether the screen is live.
- Debounce refetches by 250 ms so a 12-line order does not trigger 12 fetches.

## Verify

```bash
npm test
curl -N -H "Cookie: <session>" localhost:3000/api/stream    # events appear live
```

Then with two browsers side by side: place an order in one and confirm it appears
on the other's kitchen tab in **under 1 second** without a refresh. Kill the server
and confirm the dot goes red and recovers to green when it restarts, with no
duplicate or missing orders. Confirm in devtools that the 3-second poll is gone.
