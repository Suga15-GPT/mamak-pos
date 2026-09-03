# Phase 11 — Hardening and deployment

Read `docs/prompts/_CONVENTIONS.md` first.
**Model:** Sonnet 5, medium effort. **Expect ~35k tokens.**

## Why

Audit #26, #27, #29, #30, #31. The app now handles money and staff accountability;
it should stop storing its session token where any script can read it, stop
locking out the whole restaurant behind a proxy, and stop running as root.

## Files

Read: `src/server.js`, `src/lib/auth.js`, `public/js/api.js`, `Dockerfile`,
`docker-compose.yml`. Create: `migrations/009_sessions.sql`, `scripts/backup.sh`.

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

## Verify

```bash
npm test
curl -sI localhost:3000/ | grep -i "content-security\|x-frame\|nosniff"
docker compose up --build          # healthcheck goes healthy, app runs as node
```

Confirm: login sets an httpOnly cookie and `localStorage` holds no token; a POST
without the CSRF header is rejected; a restored backup matches the source row
counts; and the browser console is free of CSP violations.
