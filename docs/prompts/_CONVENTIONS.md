# Shared contract for every phase prompt

Every prompt in this folder begins with "Read `docs/prompts/_CONVENTIONS.md`".
This is that file. It exists so the phase prompts stay short.

## Ground rules

1. **Do not explore the repository.** `docs/MAP.md` says what every file contains.
   Read only the files your prompt's *Files* section names. If you believe you need
   another file, read it — but do not grep the tree to find out what exists.
2. **Do exactly the named scope.** Do not rename, reformat, restructure, upgrade a
   dependency, or "improve" anything the prompt did not ask for. An unrequested
   change makes the diff unreviewable and will be reverted wholesale.
3. **Make no design decisions.** Formulas, column names, indexes, status values and
   endpoint paths are given. If something genuinely is not specified, pick the
   option most consistent with existing code, implement it, and say so in one line
   at the end. Do not stop to ask.
4. **Prove it before reporting.** Run the *Verify* command. Paste the real output.
   Never report success from reading code. If a test fails, fix it and re-run.
5. **Small diffs.** If your change exceeds ~400 changed lines, you have taken on
   more than the phase asked. Stop and report what you cut.

## House style

- Server: CommonJS (`require`). Browser: ES modules (`import`). No bundler, no TypeScript.
- No new npm dependencies unless the prompt names one. `pg`, `express`, `qrcode`
  are the only runtime deps; adding one is a decision, not a convenience.
- SQL: parameterised (`$1`) always. Never string-concatenate a value into a query.
  Only whitelisted identifiers (never user input) may be interpolated.
- **Money is integer cents.** No floats in any calculation, column, or comparison.
  Convert to ringgit only for display, via `money.js`.
- Every string rendered into HTML goes through `esc()`. Event handlers take an id
  and look the record up — never interpolate a name into an attribute.
- Preserve the snapshot rule: anything printed on a bill (name, unit price, rate)
  is copied onto the order row at the time of the transaction, never joined live
  from the menu.
- Errors: `throw Object.assign(new Error('message'), { status: 400 })` for anything
  the client should see. Unexpected errors must not leak their text on public routes.
- Keep the terracotta design system in `public/style.css`. Use its CSS custom
  properties (`--terra`, `--sand`, `--charcoal`, `--radius-md`, …). Do not introduce
  a second palette, and do not add a CSS framework.
- **Every interactive control needs an explicit `color`.** A control that inherits
  its colour will eventually render white-on-white in dark mode.

## Migrations

- One new file per phase: `migrations/NNN_short_name.sql`, `NNN` zero-padded and
  strictly increasing. Never edit a migration that is already committed.
- Forward-only. Additive where possible: add a column with a default, backfill,
  then add the constraint — so a deploy never locks a table mid-service.
- Every migration must be safe to run against a database that already has live
  orders in it. Assume the restaurant is open.

## Testing

- Unit tests: `node --test test/unit/`. No test framework dependency.
- A phase that touches money, order state, or payments **must** add unit tests for
  the new rules, including the boundary cases the prompt lists.
- E2E (`test/e2e/`) is Playwright and covers six journeys only: staff login →
  order → kitchen → pay; QR customer order; split bill; void a line; offline order
  reconciles; shift open → close. Extend these; do not add new spec files.
- Before reporting done: `npm test` passes, and the app still boots
  (`node src/server.js` against a live Postgres) with no console errors.

## Definition of done for every phase

- [ ] `npm test` green, output pasted in the report.
- [ ] The phase's *Verify* command run, output pasted.
- [ ] `docs/MAP.md` updated for any file added, moved, or materially changed.
- [ ] One commit, message explaining **why** the change was needed, not what changed.
- [ ] A one-paragraph report: what changed, anything deviated from spec and why,
      anything the next phase should know.
