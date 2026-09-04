# Phase 11 — Hardening and deployment

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~35k tokens.**

## Why

Audit #26, #27, #29, #30, #31, #36. The app now handles money and staff
accountability; it should stop storing its session token where any script can read
it, stop locking out the whole restaurant behind a proxy, and stop running as root.

It also has **no way to manage staff or change a PIN** — the API can create and
delete users but never update one, and the Admin tab has no user screen at all.
Today the only way to change the admin PIN is to delete every user row and let the
app re-seed. After phase 03 that stops working entirely, because orders reference
the staff who took them. A restaurant hires and loses people constantly; this is
not optional.

## Files

Read: `src/server.js`, `src/lib/auth.js`, `src/routes/auth.js`, `src/routes/admin.js`,
`public/js/api.js`, `public/js/admin.js`, `Dockerfile`, `docker-compose.yml`.
Create: `migrations/009_sessions.sql`, `migrations/010_staff.sql`,
`public/js/staff.js`, `scripts/backup.sh`, `test/unit/staff.test.js`.

## Do

**1. Cookie sessions, not `localStorage`.** The bearer token in `localStorage` is
readable by any injected script. Move to an httpOnly cookie:
`Set-Cookie: sid=…; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` plus `Secure`
whenever the request is HTTPS. Mutating requests (POST/PATCH/DELETE) require a CSRF
token: issue one at login, return it in the JSON body, and have the client send it
as `X-CSRF-Token`. Compare with `crypto.timingSafeEqual`. Keep the QR-image blob
fetch working — it becomes simpler, since cookies ride along with `<img>` requests.

Add to `migrations/009_sessions.sql`: `last_seen_at` on `sessions`, and rotate the
session id on login (session fixation).

**Then delete the `?token=` fallback on `GET /api/stream`.** Phase 06 had to accept
the session token in the query string because `EventSource` cannot set an
`Authorization` header — which puts a live session token into reverse-proxy access
logs, browser history, and anything reading a URL. Cookies remove the reason it
exists: `EventSource` sends them automatically. Once cookie auth works, that route
must authenticate exactly like every other one, and the query-string branch must be
gone, not merely deprioritised. Verify with a request carrying `?token=` and no
cookie: it must be a 401.

**2. `trust proxy` (#26).** `app.set('trust proxy', 1)` when `TRUST_PROXY=1`.
Without it, behind any reverse proxy every request appears to come from one IP and
the login limiter locks out the entire restaurant on the tenth wrong PIN of the day.
Verify `req.ip` reflects `X-Forwarded-For` when enabled and does **not** when not
(never trust the header unconditionally — that lets an attacker forge their IP and
bypass the limiter).

**3. Security headers.** Set them by hand — no new dependency:
`Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'`,
plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
`X-Frame-Options: DENY`, `Permissions-Policy: geolocation=(), microphone=(), camera=()`.
Removing the inline handlers in phase 01 is what makes a CSP without
`script-src 'unsafe-inline'` possible — verify the console is clean, and if
anything still needs inline script, fix the script rather than loosening the policy.

**4. Bound the rate limiter (#30).** The `rl` Map grows one entry per IP forever.
Sweep entries older than the window every 5 minutes, or use a small LRU. Also apply
a limiter to `/api/public/orders` per **table token**, not only per IP — one phone
hotspot is one IP for a whole group of diners.

**5. Bound the order list (#29).** `GET /api/orders` gets `LIMIT 200` and a
`?since=` parameter. An open order forgotten for a week should not be in every
response forever.

**6. Dockerfile (#31).**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "src/server.js"]
```

Drop the `|| npm install` fallback — with a committed lockfile, a failing `npm ci`
is a real failure and must not be masked. Add `mem_limit`/`restart: unless-stopped`
in compose, and a `db` volume backup.

**7. Backups.** `scripts/backup.sh` runs `pg_dump` to a timestamped file, keeps 14
days, and is wired to a nightly cron in compose. **Then restore one into a scratch
database and confirm the row counts match** — an unrestored backup is a rumour.
Document the restore command in `docs/RUNBOOK.md` along with: how to reset an admin
PIN, how to reprint a receipt, what to do when a printer jams, and how to run the
shop if the server dies (the answer is paper — write it down).

**8. Secrets.** `.env` is already untracked, but the values leaked in git history
(commit `1be1d73`) are still exposed. Document in the runbook that
`POSTGRES_PASSWORD` and `ADMIN_PIN` must be rotated, and make the app refuse to
boot with the default PIN `1234` when `NODE_ENV=production`.

**9. Staff & PINs screen.** The user table becomes manageable, and deletion becomes
deactivation — after phase 03 a user with orders against them cannot be deleted at
all, and their name must stay readable on old bills.

```sql
-- migrations/010_staff.sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS must_change_pin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_changed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- a deactivated "Ali" must not block hiring a new Ali, so the uniqueness
-- constraint applies only to active staff, and matches login's case handling
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_name_active
  ON users (lower(name)) WHERE active;

-- the seeded admin is still on the default PIN until proven otherwise
UPDATE users SET must_change_pin = true WHERE pin_changed_at IS NULL;
```

Endpoints:

| Route | Who | Does |
|---|---|---|
| `GET /api/admin/users` | admin | id, name, role, active, created_at, last_seen_at. **Never** `pin_hash` |
| `POST /api/admin/users` | admin | create; always sets `must_change_pin = true` |
| `PATCH /api/admin/users/:id` | admin | name, role, active |
| `POST /api/admin/users/:id/reset-pin` | admin | set a new PIN for someone who forgot theirs |
| `POST /api/me/pin` | **any role** | change your own PIN; requires your current PIN |

Replace `DELETE /api/admin/users/:id` with `PATCH … {active:false}`. Keep the route
returning `410 Gone` with a message pointing at the new one.

Rules — each one is a test:
- **Never lock the shop out.** Deactivating or demoting the last active admin is a
  400. So is deactivating yourself.
- **Inactive users cannot log in**, and an inactive user's existing sessions stop
  working immediately — add `AND u.active` to the session lookup, so deactivating
  someone mid-shift ejects them rather than waiting for their session to expire.
- **Changing a PIN invalidates sessions.** Your own change kills all your sessions
  except the current one; an admin reset kills all of that user's sessions. A PIN
  change that leaves a stolen session alive has achieved nothing.
- **`must_change_pin` blocks everything.** While set, every endpoint except
  `POST /api/me/pin` and `POST /api/logout` returns `403 pin_change_required`, and
  the UI shows a change-PIN dialog that cannot be dismissed.
- **PIN policy:** 4–8 digits; reject all-same (`0000`, `1111`), sequential runs
  (`1234`, `4321`, `2345`), and reuse of the current PIN. Do not go further than
  this — staff type this a hundred times a shift, and the real defence is the login
  rate limit plus the audit trail, not PIN entropy.
- Every create, role change, deactivation and PIN reset writes an `audit_log` row
  (phase 03). Never log the PIN itself, hashed or otherwise.

UI:
- **Admin tab → "Staff & PINs" card.** A table of name / role / status / last active,
  with Edit, Reset PIN and Deactivate per row. Former staff collapsed underneath in a
  "Former staff" section, showing name, role and when they left — they stay visible
  because old bills still carry their name.
- **"Change my PIN" in the header user menu, for every role** — not buried in the
  Admin tab, which waiters and kitchen staff cannot open. This is the part people
  forget, and it is the one every staff member actually needs.
- Adding staff takes name, role, PIN and confirm-PIN, and says plainly that the new
  person will be asked to choose their own PIN at first login.

## Verify

```bash
npm test
node --test test/unit/staff.test.js
curl -sI localhost:3000/ | grep -i "content-security\|x-frame\|nosniff"
docker compose up --build          # healthcheck goes healthy, app runs as node
```

`test/unit/staff.test.js` must cover: last-admin deactivation → 400; self
deactivation → 400; inactive user login → 401; a live session dying the moment its
user is deactivated; own PIN change with a wrong current PIN → 401; policy
rejecting `1234`/`0000`/`4321` and accepting `7392`; reset-pin clearing that user's
sessions and setting `must_change_pin`; `must_change_pin` returning 403 everywhere
until changed; and deactivating "Ali" then successfully creating a new "Ali".

Confirm: login sets an httpOnly cookie and `localStorage` holds no token; a POST
without the CSRF header is rejected; a restored backup matches the source row
counts; and the browser console is free of CSP violations.
