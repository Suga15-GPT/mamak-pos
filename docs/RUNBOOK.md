# Runbook

Operational procedures for running Mamak POS in production. Written for
whoever is on shift when something breaks, not just for a developer.

## Rotate secrets (do this before going live)

The values that were in `.env` in commit `1be1d73` are exposed in this
repository's git history — assume they are compromised, permanently:

- **`POSTGRES_PASSWORD`**: pick a new one, update `.env`, then
  `docker compose up -d db` followed by `docker compose exec db psql -U
  postgres -c "ALTER USER postgres WITH PASSWORD '<new password>';"`, then
  update `.env`'s `POSTGRES_PASSWORD` to match and `docker compose up -d`
  the rest.
- **`ADMIN_PIN`**: this env var only seeds the *first* admin account on a
  brand-new database — changing it does nothing to an already-seeded one.
  Reset the live admin PIN instead: see "Reset an admin PIN" below. As of
  phase 11, the app also refuses to boot with `NODE_ENV=production` if any
  active admin account still verifies against the literal PIN `1234` — do
  not rely on this alone, it is a backstop, not a substitute for actually
  rotating it.

## Reset an admin PIN

If an admin still knows their own PIN: log in, open the user menu, **Change
my PIN**.

If nobody can log in as any admin (the "locked out entirely" case): connect
directly to the database and force a reset, which also clears
`must_change_pin` off and marks it back on so the temporary PIN must be
changed at next login:

```sql
UPDATE users
SET pin_hash = NULL,           -- see below: there is no "set a plaintext PIN" SQL shortcut
    must_change_pin = true
WHERE name = 'Admin' AND role = 'admin';
```

`pin_hash` is a salted scrypt hash (`hashPin()` in `src/lib/auth.js`) — it
cannot be set from plain SQL. The supported path is:

1. Have any **other** working admin account use
   `POST /api/admin/users/:id/reset-pin` (or the Admin tab's **Reset PIN**
   button) against the locked-out admin.
2. If truly no admin account is reachable at all, stop the app
   (`docker compose stop app`), run a one-off Node script against the same
   `DATABASE_URL` that calls `hashPin()` from `src/lib/auth.js` and writes
   the result directly to that user's `pin_hash`, with `must_change_pin =
   true`, then restart the app.

Either way, an admin PIN reset writes an `audit_log` row
(`user.pin_reset`) — check `GET /api/admin/audit` afterward if you want to
confirm who did it and when.

## Change your own PIN (any role)

Header → user menu → **Change my PIN**. Requires your current PIN. This
signs out every *other* session of your account immediately — the device
you just used to change it stays signed in.

## What to do when a printer jams

1. **The order is never lost.** A failed print job (`status = 'failed'` in
   `print_jobs`) never blocks or reverses the order/payment that queued it —
   check Admin → Print Jobs; the failing job shows its `last_error`.
2. Clear the physical jam, then Admin → Printers → **Test print** on that
   printer to confirm it prints again.
3. For the specific chit/receipt that failed: staff can always read the
   order from the Orders/Kitchen tab and call it out verbally to the kitchen
   as a stopgap; once the printer is back, use **Reprint receipt** (admin
   only, on a paid order) to reprint just the receipt. There is currently no
   one-tap "retry" for a failed kitchen chit — re-send the same items as a
   fresh append if the kitchen genuinely never saw them.

## If the server dies mid-service

**The answer is paper.** Do not wait on IT during service:

1. Take orders on paper — table, items, notes — exactly as you would if the
   power was out.
2. Ring up payments by hand; keep every paper ticket until the server is
   back.
3. Once the app is back up, enter each paper order as normal (it is fine
   that they land minutes or hours late — the money and the audit trail
   matter more than the timestamp), then reconcile the shift's cash drawer
   against the paper tickets before closing it.
4. If the outage happens *during* an open shift, do not close that shift
   until the paper tickets have been entered — the X/Z report and cash
   reconciliation are only correct once every sale is in the system.

## Backups

A nightly cron (`backup` service in `docker-compose.yml`, `crond` running
`scripts/backup.sh` at 03:00) writes a gzipped `pg_dump` to the `backups`
volume as `mamak-<UTC timestamp>.sql.gz`, and deletes anything older than
`RETENTION_DAYS` (default 14).

Run it by hand any time: `docker compose exec backup /scripts/backup.sh`.

### Restore (into a scratch database — never straight into production)

```bash
# 1. Copy the dump out of the volume (or `docker compose cp` it) if working locally.
docker compose exec backup ls /backups

# 2. Create a throwaway database and load the dump into it.
docker compose exec db psql -U postgres -c "CREATE DATABASE restore_check;"
docker compose exec -T db sh -c 'gunzip -c /backups/mamak-<timestamp>.sql.gz' \
  | docker compose exec -T db psql -U postgres -d restore_check

# 3. Confirm it actually restored something real — compare row counts
#    against the live database, table by table.
docker compose exec db psql -U postgres -d postgres -c \
  "SELECT 'orders', count(*) FROM orders UNION ALL SELECT 'payments', count(*) FROM payments UNION ALL SELECT 'users', count(*) FROM users;"
docker compose exec db psql -U postgres -d restore_check -c \
  "SELECT 'orders', count(*) FROM orders UNION ALL SELECT 'payments', count(*) FROM payments UNION ALL SELECT 'users', count(*) FROM users;"

# 4. Drop the scratch database once you're satisfied.
docker compose exec db psql -U postgres -c "DROP DATABASE restore_check;"
```

An unrestored backup is a rumour — actually run this drill after setting up
backups for the first time, and periodically afterward, not just once.

## Off-device backups (do this before you need it)

A nightly `pg_dump` on the same machine as the database protects against a bad
migration or a dropped table. It does **not** protect against losing the
machine: the live database and every backup of it are on the same disk, and go
together.

Set a destination in `.env` and `scripts/backup.sh` copies each dump to it
after writing the local one:

```bash
# One of these three shapes. Nothing else is invented if it is unset.
BACKUP_REMOTE_TARGET=s3://my-bucket/mamak      # needs the aws CLI + AWS_* creds
BACKUP_REMOTE_TARGET=backup@nas.local:/mamak   # needs rsync + a mounted SSH key
BACKUP_REMOTE_TARGET=/mnt/usb/mamak            # a mounted NAS or external disk
```

`BACKUP_REMOTE_CMD` overrides the whole step if you already have a tool: it is
run with the dump's path as `$1`.

Credentials are never stored in the repository. Supply them the way the tool
expects — `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `.env` (already passed
through to the `backup` service in `docker-compose.yml`), or an SSH key mounted
into the container — and keep `.env` out of git.

A failed off-device copy is reported loudly but never discards the local dump
that already succeeded.

### Checking it is actually happening

Each run records the time and outcome in the database, and **Admin → System**
shows it:

- 🟢 *Last backup* — a backup reported in within the last 48 hours.
- 🔴 *Last backup* — **no backup has ever reported in.** Nothing is protecting
  this data. Fix it today.
- 🟠 *Off-device backup: not configured* — backups exist only on this machine.

An unrestored backup is still a rumour — run the restore drill above after
setting this up, and periodically afterwards.

## BASE_URL and the table QR codes

`BASE_URL` is the address a **customer's phone** must be able to reach. It is
what gets encoded into every printed QR sticker.

If it is unset, QR links are guessed from whichever address the admin browser
used — which is usually `localhost`, and a `localhost` QR is silently useless
on every phone in the restaurant.

**Admin → Tables & QR** shows a red banner when the value could not work, and
**Admin → System** reports the same thing under *QR public address*. Both check
the value in use at that moment, so fixing `BASE_URL` and restarting turns them
green immediately.

After changing `BASE_URL`, reprint the stickers: **Admin → Tables & QR → Print**
on each table.
