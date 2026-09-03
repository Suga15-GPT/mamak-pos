# Phase 00 — Safety net: migrations, tests, CI

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~25k tokens.**

## Why

Nothing else in this plan is safe to attempt. Today the schema is applied by
`fs.readFileSync('schema.sql')` on every boot, there are zero tests, and four
critical bugs shipped unnoticed. Build the net before walking the wire.

## Files

Read: `server.js` lines 462–520 (`seed()` and `boot()`), `schema.sql`, `package.json`.
Create: `migrations/001_baseline.sql`, `src/db.js`, `test/unit/smoke.test.js`,
`.github/workflows/ci.yml`. Delete: `migrate.js`.

## Do

**1. Migration runner** in `src/db.js`, exporting `pool`, `query`, and `migrate()`:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`migrate()` reads `migrations/*.sql` sorted by filename, and for each version not
in `schema_migrations` runs the file **and** the insert in a single transaction, so
a failed migration leaves no partial state. Log each version applied. Applying
twice must be a no-op.

**2. `migrations/001_baseline.sql`** — the current `schema.sql` verbatim, plus the
`ALTER TABLE modifier_options ADD COLUMN IF NOT EXISTS available …` that `seed()`
currently runs. It must be idempotent (`CREATE TABLE IF NOT EXISTS` throughout) so
it applies cleanly to an existing production database that already has these tables.

**3. Rewire boot.** `seed()` calls `migrate()` instead of reading `schema.sql`, and
keeps only the data seeding (categories/items/tables/admin user). Delete
`schema.sql` and `migrate.js`. Keep the existing DB-not-ready retry loop.

**4. Test harness.** `npm test` → `node --test test/unit/`. Tests need a database:
add `test/helper.js` exporting `withDb(fn)` that connects using `TEST_DATABASE_URL`
(default `postgres://postgres:postgres@localhost:5432/postgres`), creates a schema
named `test_<random>`, sets `search_path` to it, runs `migrate()`, invokes `fn`, and
drops the schema in a `finally`. Tests must never touch the `public` schema.

**5. `test/unit/smoke.test.js`** — three tests, each a real regression from
`docs/AUDIT.md` so they can never silently return:
- `migrate()` is idempotent: run twice, second run applies 0 versions.
- Seeded admin can log in; a wrong PIN returns 401.
- `GET /api/orders?mode=recent` returns 200 (audit #9 shipped as a 500).

Start the app on an ephemeral port inside the test and call it with `fetch`.

**6. CI** — `.github/workflows/ci.yml`, on push and PR: Node 20, a
`postgres:16-alpine` service, `npm ci`, `npm test`.

## Do not

Do not restructure `server.js` — that is phase 01. Do not change any behaviour.
Do not add a test framework; `node:test` is built in.

## Verify

```bash
npm test                                   # all green
node -e "require('./src/db').migrate()"    # second run: 0 applied
```

Paste both outputs. Confirm `schema.sql` and `migrate.js` are gone and the app
still boots and seeds against an empty database.
