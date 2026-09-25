# Redesign state

Short, living record of the redesign programme. Read this plus your targeted
files instead of rereading the repository.

## Current phase

Complete. Two programmes have now run on this codebase:

- **A–G** (earlier): kitchen rounds, QR order-more, admin CRUD, the first design
  pass, the dashboard, recovery paths, tests. See "Architecture decisions" below
  — none of it was relitigated.
- **V2** (this programme): the Warm Minimal design system and application shell,
  the staff POS, kitchen/tables/admin polish, the dashboard, Speak to Order, and
  the in-app Help centre.

## V2 phases

| Phase | What it delivered |
|---|---|
| 0 | Current-state audit; baseline 95/95 unit, 13/13 Playwright |
| 1 | One semantic token layer, a rebuilt button system, left rail + bottom bar |
| 2 | Staff POS: monogram menu cards, three-row bill lines, sent/new split, phone order bar |
| 3 | KDS columns and tickets, modifier groups as question-and-answers, floor/kitchen summaries |
| 4 | KPI hero, busiest-hour marking, tidier chart grid |
| 5 | Speak to Order: transcription → interpretation → validation → preview → confirm |
| 6 | Help centre: 18 topics, 6 mini walkthroughs, 9 FAQs, contextual links |
| 7–8 | Responsive/dark sweep, 5 viewports × every screen, docs, final review |

## Design system (do not relitigate)

- **Two token layers.** Semantic (`--brand`, `--surface`, `--text`, `--ok`,
  `--danger`, `--info`, `--warn`, `--on-accent`…) is what new code uses. The old
  names (`--terra`, `--sand`, `--charcoal`, `--cream`…) are kept as **aliases**
  of the semantic layer — several hundred call sites reference them, and
  renaming them would be a large diff that changes nothing a user can see.
  There is exactly one place a colour is decided.
- **`--on-accent`** is text sitting on a filled brand or status colour: white in
  light mode, near-black in dark, where every accent is deliberately lighter.
  One token instead of a `body.dark` correction per component. Never write
  `color:#fff` on a token-filled background.
- **One typeface** (DM Sans), tabular numerals on every money figure. The
  display serif is gone: it read as decoration on a screen people use at speed.
- **Buttons** are one shape, six intents (default/outline/ghost/sage/info/
  danger/charcoal), three sizes (`small`, default, `primary-lg`), one press
  behaviour. `.btn` sets `--btn-bg`/`--btn-fg`/`--btn-bd`; variants re-point
  those rather than restating the rule.
- **Elevation** is a 1px border plus a barely-there shadow. Hover elevation is
  for interactive surfaces only.
- **`[hidden] { display:none !important; }`** is set globally. A component that
  sets its own `display` otherwise out-specifies the user agent's rule and
  renders an empty box.
- **Never animate `transform` on a container of `position:fixed` children.** A
  finished `fill-mode:both` animation leaves the identity matrix behind, which
  makes the element a containing block. `.tab.active` animates opacity for
  exactly this reason.

## Application shell

- **≥1180px**: left rail, 216px, icon + word.
- **768–1179px**: same rail, 84px, icon over word.
- **<768px**: bottom bar, same buttons, same handler.
- `nav.js` paints both from one list; the rail additionally carries the wordmark
  and who is logged in. The header is a page title, a connection dot and one
  account disclosure — nothing else.
- Nav order: POS, Kitchen, Sales, Shift, Admin, Help. Role-filtered. Help is
  last on purpose: always in the same place, never in the way.

## Voice architecture (do not relitigate)

```
audio -> transcription -> menu-aware interpretation -> structured proposal
      -> deterministic validation -> priced preview -> customer confirms
      -> POST /api/public/orders (the existing path)
```

- **The model can only name IDs.** `PROPOSAL_SCHEMA` in `src/services/voice.js`
  has no price, total, tax or discount field. There is nowhere for it to put
  money. Every figure comes from `items.price_cents` /
  `modifier_options.price_cents`.
- **Interpretation is not a mutation.** `POST /api/public/voice/interpret`
  writes nothing. A customer who abandons the preview leaves no order, no round,
  no ticket, no chit — asserted by both a unit test and a Playwright journey.
- **Confirmation reuses the tap path**, so a tampered draft is no more powerful
  than a tampered basket. Voice add-ons open a new kitchen round through the
  same `appendSend` every other path uses; there is no voice order data model.
- **Validation is per line, not all-or-nothing**: an unknown id is dropped and
  named, a sold-out dish comes back as `{reason:'sold_out', name}` (which is why
  sold-out items stay in the snapshot the model sees), an option the dish does
  not offer is dropped and becomes a `needs_choice` question answered in the
  existing food-options dialog. A line with `needs_choice` blocks Confirm.
- **Providers** are `providers.transcribe` / `providers.interpret`, swapped by
  `setProviders()`. Tests inject stubs; `VOICE_MODE=mock` injects a word matcher.
  Transcription is any OpenAI-compatible `/audio/transcriptions` endpoint;
  interpretation is Anthropic's Messages API with `output_config.format`.
- **Cost**: one transcription + one interpretation per utterance. The menu is the
  cached system prefix and is rendered in a fixed order so it stays cached;
  `effort: 'low'`; snapshot rebuilt once a minute, not once an order; the
  snapshot carries no prices.
- **Off by default** (`VOICE_ORDERING`). Unconfigured, `/api/t/:token` reports
  `voice.enabled:false` and no microphone appears.
- `Permissions-Policy` allows `microphone=(self)`. It was denied outright, which
  would have made `getUserMedia` fail silently.

## Help centre

- `public/js/help.js` holds the topics, the FAQs and the walkthroughs as data.
  Topics are role-filtered; search matches any word in a topic's body.
- A walkthrough is 3–5 captioned frames of a mock screen built from the same
  tokens as the real UI. The cursor is positioned from the laid-out cell, not
  from coordinates, so frames survive different text wrapping. Reduced-motion
  gets the frames without the auto-advance.
- The markdown handbook (`docs/HOW-TO-USE-MAMAK-POS.md`) stays the long
  printable reference; the in-app copy is adapted, not duplicated.
- Contextual `data-action="help-jump"` links exist on Kitchen, the menu editor
  and the QR settings. Three, not one per screen.

## Architecture decisions carried forward (do not relitigate)

Dining order vs kitchen round, station tickets, derived `orders.status`,
preparation stations, order types, QR approval, integer cents,
parameterised SQL, `esc()` on render, the snapshot rule, forward-only
migrations, idempotency keys, payment and shortfall guards, the audit log, the
KL-midnight sold-out reset, role permissions. All unchanged by V2 and by card
mode.

The **table model** (a dine-in order identified by its table, one open order per
table, a QR sticker per table) is no longer on this list: card mode replaced it.
See below.

## Card mode

Numbered customer cards replace tables as the way a dine-in order is identified.
A card handed over at the counter is what actually follows a party around a
mamak; a table number never reliably named a bill.

- **A card is in use while it has an open order**, enforced by the partial
  unique index `one_open_order_per_card`. It frees itself when the order is
  paid, cancelled or refunded — there is no in-use flag and no manual release.
  Two tills racing for one card get one 201 and one 409 naming the winner.
- **Cards 1–50 are seeded**; Admin → Cards & QR sets the count. Raising it
  activates or creates numbers; lowering it deactivates the top numbers and is
  refused (409) while any of them has an open bill.
- **New dine-in orders set `card_id`, never `table_id`.** Tables are kept, never
  dropped: old bills keep their table names, and a table order open at upgrade
  time stays visible (its own section on the floor) and payable until it
  closes. Takeaway is unchanged — no card.
- **Move** takes a card (a lost or swapped card), with the same guards as
  before and 409 if the target card is in use.
- **Everywhere a location is shown it says "Card 7"**: POS, kitchen tickets,
  chits, receipts, print jobs, the approval queue, the dashboard
  (`open_cards`), audit detail.

### Combining bills

- `bill_groups` + `orders.bill_group_id`. **Nothing moves between orders**:
  each card keeps its own order, rounds, kitchen tickets and discounts, and
  staff can keep adding to any member card after combining.
- **Group total = sum of member `total_cents`.** Tax is each order's own,
  computed as it always was. It is never recomputed on the combined subtotal
  (asserted by a test where the two would differ by a sen).
- **A combined bill is paid in full, in one go.** `POST
  /api/bill-groups/:id/pay {legs:[{method, amount, tendered?}, ...]}` takes
  every leg together (say RM20 cash and the rest by card) and writes them all
  in one transaction. At most one cash leg; card/e-wallet legs name their
  amounts and together may not exceed the group's due; the cash leg covers the
  remainder after 5-sen rounding, applied once to that remainder; change =
  tendered − rounded remainder. Legs that don't settle the group exactly are
  refused (400 "A combined bill has to be paid in full in one go.") and write
  nothing. There is no part-paid combined bill — that state is what stranded
  cards and blocked every correction in review (PR #16, findings #1 and #3).
- **Each leg becomes ordinary per-order `payments` rows** (same taken_by,
  shift), allocated in ascending card number, legs in the order given and cash
  last, so the rows always sum exactly to what was taken. The rounding goes on
  the last member settled in cash; a 1–2 sen cash remainder that rounds to
  nothing settles on the rounding alone with no zero-sen row. Every member is
  paid and the group closed in the same transaction. Because payments stay one
  row per order, shifts, Z reports and refunds did not change.
- **A grouped card that closes on its own** (voided to zero, comped, cancelled
  because its QR round was rejected, or cancelled by an admin) leaves its group
  automatically; a group left with one card dissolves. Each step is audited.
- **Un-combining is allowed only while no member has a payment** (409 "This
  combined bill has a payment on it and can't be split apart."). Under the
  rule above that can only be a payment a card took on its own before it was
  combined. A group left with one card dissolves.
- **The bill lock** (see "Payments and locking") is taken first by combine,
  un-combine, dissolve, group pay and leave-on-close, which then read the
  group's membership and lock its orders by ascending id and its groups by
  ascending id. Per-path lock ordering alone was not enough: discovering a
  group's other members while already holding row locks deadlocked.
- **A card with a payment of its own can't be combined** (409 "This card has a
  payment on it — pay or refund it before combining.") — combined bills are
  paid all at once.
- Too little cash on a combined bill says "Cash given RM x is less than the RM
  y still due".
- A grouped card is paid and split with its group: its own pay and split
  routes return 409. Per-card split keeps working for ungrouped cards.
- A group prints one receipt: lines under "Card N", the money summed, one total.
- Combine, un-combine and group payment each write `audit_log`.

### QR self-ordering

- `qr_mode`: **per_card** (each card's own QR; orders onto its open order or
  opens one), **shop** (one poster token; the customer types their card
  number, and approval is always required whatever `qr_require_approval` says,
  because anyone can type any number), **off** (public QR and voice endpoints
  404; the customer page says "Please order at the counter"). Migrated from
  `qr_ordering_enabled`. The old 503 "paused" message is gone.
- Voice changed only in how its token resolves to a card.
- **Approval rule.** A round awaiting approval (always, in shop mode) is not on
  the bill: its lines show "awaiting approval" and count in no total — card
  bill, combined bill, POS cart or receipt. The till refuses payment, single
  card or combined, while any round on it awaits approval (409 "A customer
  order is waiting for approval — approve or reject it first."). Approve and
  reject lock the order and return 409 once it is no longer open; they never
  recompute a closed bill. Approving recomputes the bill in the same
  transaction, so no payment can be taken against the pre-approval total.
- Admin can regenerate one card's QR token or the shop poster's; printed copies
  of the old one stop working. Audited.

### Payments and locking

- **One bill lock, taken first.** Every operation that can change which cards
  share a bill, settle a bill, or change a bill's total takes one
  transaction-scoped advisory lock with a single fixed key
  (`pg_advisory_xact_lock`, `src/lib/billlock.js`) as its **first** lock:
  opening an order (with its first total), combine, un-combine, dissolve,
  group pay, single-card pay, adding a round (staff, QR, voice), void,
  discount/comp and its removal, refund, QR approve/reject, move, cancel,
  leave-on-close, **every status tap** (kitchen ticket and order-level),
  shift close and cash pay-in/pay-out. Only then does it lock order rows,
  ascending id. Rule of thumb: anything that writes an order's status,
  lines, totals, payments, refunds, tickets or bill-group membership, or
  closes a shift, takes the lock first. They are serialised against each other, so they
  cannot deadlock by construction, and each one reads the order *after*
  locking it.
- So **every** one of those is race-safe against a payment, not only adding
  items: a void, discount or approval that loses the race to a payment finds
  the bill closed and is refused (409); one that wins is included in the total
  the payment then reads. Each recomputes the bill inside its own transaction.
- **Closed bills stay closed, three ways.** The bill lock serialises status
  taps with payment; `deriveOrderStatus` writes only
  `WHERE status NOT IN ('paid','cancelled','refunded')`; and migration 015's
  trigger rejects any status change out of `paid`, `cancelled` or `refunded`
  except paid → refunded. A kitchen tap that read "ready" before a payment
  once wrote "served" over "paid" (PR #16 re-check 2, K). A ticket can still
  be advanced after its order is paid (food is often served after paying);
  only the order's status is left alone.
- **Move re-checks under the lock** and refuses (409) a bill that closed while
  it waited; a refund reads the open shift under the lock. "Has a payment" for
  combine, un-combine and adding items always means paid net of refunds > 0.
- **An order with any round awaiting approval is never auto-settled or
  auto-closed** (a void or discount that takes the accepted lines to zero
  leaves it open), and a grouped card with a held round never leaves its group
  on its own. A comp is refused while a round is held, like payment.
- A refund on a still-open bill only reduces what has been paid; only a paid
  (closed) order whose refunds equal its payments becomes `refunded`.

## Migrations added

None in V2. Speak to Order needed no schema change — it produces the same rows
the tap flow produces. Card mode added `014_card_mode.sql` and
`015_closed_orders_stay_closed.sql` (the closed-status trigger). The
follow-ups added `017_closed_orders_frozen.sql` (016 is reserved for the
setup-wizard branch): the same trigger now also freezes a closed order's
`card_id`, `table_id`, `order_type` and money columns; paid → refunded still
works.

## Files materially changed in V2

- `public/style.css` — rewritten as one token system (~1350 lines).
- `public/index.html` — shell, POS, kitchen, dashboard heads, Help section.
- `public/js/` — `nav.js` (two shells), `pos.js` (cards, bill lines, phone bar),
  `kitchen.js`, `dashboard.js`, `admin.js`, `i18n.js`, `main.js`, new `help.js`.
- `public/customer/` — `index.html`, `customer.js` (one submit path), new
  `voice.js`.
- `src/` — new `services/voice.js`, new `routes/voice.js`; `server.js`
  (microphone policy, scoped body limit), `routes/public.js` (voice flag).
- `test/` — new `unit/voice.test.js` (17), three new Playwright journeys.
- `package.json` — one new dependency, `@anthropic-ai/sdk`.

## Known limitations

- **No food photographs.** There is no image column and no upload pipeline;
  menu cards carry a monogram tile built from the item's own name instead.
  Adding real images would need a migration, an upload path and a CSP change.
- **Voice UI chrome is bilingual; voice *errors* are English only.** The
  transcription and interpretation handle Manglish; the "sorry, I could not hear
  that" strings do not have BM translations yet.
- **The menu snapshot is cached for 60s.** A dish marked sold out is refused
  immediately (validation reads the database), but the model may still propose
  it for up to a minute — which surfaces as "finished for today", not as a
  wrong order.
- **`VOICE_MODE=mock` is a word matcher**, not a model. It cannot do
  corrections properly and replaces the draft outright.
- Off-device backup is still prepared, not configured (`BACKUP_REMOTE_TARGET`).
- Stations are still `kitchen` and `drinks` with no management UI.
- `npm audit` reports three moderate advisories in express/qs. They predate this
  programme and were not touched by it.

## Latest test state

After PR #16 re-check 2: `npm test` 155/155 (`test/unit/card_recheck.test.js`
12, `test/unit/card_recheck2.test.js` 7). Playwright 17/17.

After the PR #16 review fixes: `npm test` 136/136 (16 regression tests in
`test/unit/card_review.test.js`, one or more per finding). Playwright 17/17.

After card mode: `npm test` 120/120 (8 new in `test/unit/cards.test.js`).
Playwright 17/17 (12 journeys, including "two cards, combine, pay once", + 5
responsive viewports).

Before card mode: `npm test` 112/112. Playwright 16/16 (11 journeys + 5 responsive viewports).
A separate scripted sweep checked 5 viewports × every screen × light and dark
for horizontal overflow, console errors and page errors: clean.
