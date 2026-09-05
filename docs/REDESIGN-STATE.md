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
preparation stations, order types, QR ordering and approval, integer cents,
parameterised SQL, `esc()` on render, the snapshot rule, forward-only
migrations, idempotency keys, payment and shortfall guards, the audit log, the
KL-midnight sold-out reset, role permissions. All unchanged by V2.

## Migrations added

None in V2. Speak to Order needed no schema change — it produces the same rows
the tap flow produces.

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

`npm test` 112/112. Playwright 16/16 (11 journeys + 5 responsive viewports).
A separate scripted sweep checked 5 viewports × every screen × light and dark
for horizontal overflow, console errors and page errors: clean.
