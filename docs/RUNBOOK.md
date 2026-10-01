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
  the rest. Any characters work, `/ + = # @` included: the app is given the
  password on its own (`PGPASSWORD`), never inside a URL. In `.env`, put it
  in single quotes if it has a `$` or a space. If it has a `$` or a quote,
  set it in the database with `docker compose exec db psql -U postgres` and
  then `\password postgres` at the prompt (it asks twice and needs no
  quoting) instead of the `ALTER USER` command.
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
   database (`docker compose run --rm app node -e '…'` runs it with the
   app's own connection settings) that calls `hashPin()` from `src/lib/auth.js`
   and writes the result directly to that user's `pin_hash`, with
   `must_change_pin = true`, then restart the app.

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

## Restore cleared sales data

**Admin → System → Clear sales data** (admin only: the admin's own PIN and the
word `CLEAR`) starts every sales figure from RM0 — after staff training, or a
trial day — without deleting anything. In one transaction under the bill lock
it copies every sales row into a new schema in the same database, named for
the shop's date and time, `archive_YYYYMMDD_HHMMSS`, then removes those rows
from the live tables:

- **moved:** `orders`, `order_items`, `order_item_mods`, `order_sends`
  (rounds), `order_send_tickets` (kitchen tickets), `payments`, `discounts`,
  `refunds`, `bill_groups`, `shifts`, `cash_movements`, `print_jobs` — and the
  idempotency keys, which are columns of `orders` and `order_items`.
  `src/services/sales_archive.js` holds the list; a unit test fails if a new
  table is not classified.
- **kept:** the menu, stations, staff and their logins, cards and tables,
  printers, settings and feature switches, and `audit_log`, which gains one
  `sales.clear` row saying who cleared, when, how many bills, what total
  (payments less refunds) and the archive's name.

It is refused while any bill, shift or kitchen ticket is still open. Bill,
payment and shift numbers are not reset, so archived rows never collide with
new ones, and an archive can be put back beside new trading later. The
idempotency keys of the archived bills stay behind in
`archived_idempotency_keys`, so a till that replays an order it sent before
the clear is told "already done" instead of opening the same food as a new
bill. A menu item or printer deleted since the clear doesn't block a restore:
those lines and print jobs come back with the link empty (the bill keeps the
dish's name and price), as deleting it would have left a live row. Anything
else the archive points at that has since gone (a card, say) is refused by
name before anything is written — put it back, then restore.

Running the setup wizard again never clears sales — it changes settings only.

### Putting an archive back

1. **Back up first** (see Backups above): `docker compose exec backup /scripts/backup.sh`.
2. Find the archive. Admin → Activity shows "Cleared sales data" with its
   name, or list them with what each holds:

   ```bash
   docker compose exec app node scripts/restore-sales-archive.js --list
   # archive_20260930_220501  412 bills  RM 8123.40
   ```

3. Restore it:

   ```bash
   docker compose exec app node scripts/restore-sales-archive.js archive_20260930_220501
   ```

   One transaction under the bill lock, parents before children: shifts,
   combined bills, bills, rounds, lines, kitchen tickets, options, cash
   movements, discounts, payments, refunds, print jobs. Only columns the live
   table still has are copied (a column added since takes its default). It
   restores everything or nothing, writes a `sales.restore` audit row, and
   refuses an archive whose bills are already back ("looks restored already")
   or a name that isn't `archive_YYYYMMDD_HHMMSS`.

4. Check the Sales screen and a Z report from before the clear, then drop the
   archive once you no longer need a copy of it:

   ```bash
   docker compose exec db psql -U postgres -c 'DROP SCHEMA "archive_20260930_220501" CASCADE;'
   ```

Nothing here goes near the triggers from migrations 015/017/019 that freeze a
closed bill: they fire on `UPDATE`, and clearing and restoring only insert and
delete whole rows.

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

`BASE_URL` is the address a **customer's phone** must be able to reach: this
PC's LAN address, e.g. `http://192.168.x.x:3000` (on Windows, `ipconfig`
shows it as the IPv4 Address). It is what gets encoded into every printed QR
sticker and every NFC tag. Give this PC a fixed address in the router
(a DHCP reservation) so it never changes under the stickers.

Never `localhost`: on a phone, `localhost` is the phone itself, so a
`localhost` QR is silently useless on every phone in the restaurant. With
`docker compose`, a `BASE_URL` left out of `.env` becomes
`http://localhost:3000`, and in production the app then logs a
`WARNING: BASE_URL is …` line every time it starts (for `127.0.0.1` too).
Unset outside docker compose, QR links are guessed from whichever address the
admin browser used.

**Admin → Tables & QR** shows a red banner when the value could not work, and
**Admin → System** reports the same thing under *QR public address*. Both check
the value in use at that moment, so fixing `BASE_URL` and restarting turns them
green immediately.

After changing `BASE_URL`, reprint the stickers: **Admin → Tables & QR → Print**
on each table. Rewrite the NFC tags too.

---

## Speak to Order: switching it on, and what it costs

Voice ordering is **off** unless `VOICE_ORDERING=1`. While it is off, the QR page
is exactly what it has always been — a menu you tap — and no microphone button
appears anywhere. Nothing else in the POS changes.

### What you need

Two vendors, both configured on the server. No key is ever sent to a browser.

```
VOICE_ORDERING=1

# Speech to text — anything speaking the OpenAI /audio/transcriptions shape:
# OpenAI, Groq, or a whisper server you run yourself.
VOICE_STT_URL=https://api.openai.com/v1/audio/transcriptions
VOICE_STT_MODEL=whisper-1
VOICE_STT_API_KEY=...

# Interpretation — Anthropic's Messages API.
ANTHROPIC_API_KEY=...
VOICE_LLM_MODEL=claude-opus-5
```

If any of those is missing, `GET /api/t/:token` reports `voice.enabled: false`
and the page hides the microphone rather than showing a button that fails.

### Trying it without an account

```
VOICE_ORDERING=1
VOICE_MODE=mock
VOICE_MOCK_TRANSCRIPT=roti canai dua, teh tarik satu
```

Both vendors are replaced by a local word matcher, so the whole flow — the
permission prompt, the level meter, the preview, the confirmation, the kitchen
round — can be walked through and demonstrated. It does not listen to the
microphone; it "hears" `VOICE_MOCK_TRANSCRIPT` and nothing else. **Never set
this in production.**

### What each spoken order costs

One transcription and one interpretation per utterance. There is no
conversation, no streaming session, no second opinion.

The interpretation prompt is the restaurant's menu followed by the sentence
that was just said. The menu is rendered in a fixed order and marked as a cache
prefix, so after the first order of a busy period it is served from cache
rather than billed again; the per-order cost is then roughly the sentence plus
a short JSON answer. The menu snapshot itself is rebuilt from the database once
a minute, not once an order, and carries no prices — the model has no business
knowing what things cost.

If the bill still matters more than the accuracy, `VOICE_LLM_MODEL` takes any
Anthropic model id. A smaller model costs less per order and mishears Manglish
more often — "teh o ais" for "teh o limau" is the kind of mistake it makes, and
the customer will see it on the preview and have to correct it. Change it,
watch a service, and change it back if the corrections get annoying.

### Limits already in place

- Audio is capped at 700 KB and the page stops recording at 25 seconds.
- Only real audio MIME types are accepted; anything else is a 400.
- 15 utterances per IP and 25 per table, per ten minutes.
- Vendor errors never reach the customer — they see "we could not hear that
  clearly" and the detail goes to the server log.

### Turning it off in a hurry

Unset `VOICE_ORDERING` and restart. To stop **all** customer ordering
(voice and tapping) without a restart, use Admin → Tables & QR → Accept QR
orders instead.


## Reading receipts for Expenses (Gemini)

Optional. Without it, 🧾 Expenses works by typing.

1. Sign in at https://aistudio.google.com with a Google account → **Get API key**
   → **Create API key**. The free tier needs no card and is plenty for a few
   receipts a day.
2. Add it to `.env`: `GEMINI_API_KEY=...` (and, only if Google retires the
   default model, `GEMINI_MODEL=<a current model that reads images and audio>`).
3. `docker compose up -d` (the app restarts with the key; nothing else changes).
4. 🧾 Expenses → Photo of receipt: the form should fill itself in.

The key stays on the server; phones never see it. On the free tier Google may
use what is sent to improve its products — receipts from suppliers only.
If reading fails ("free reading limit used up", "could not reach"), the form
opens empty and you type it.

## Tills after an update

Every screen checks every 30 seconds which version the server is running. After
an update it reloads itself at the first quiet moment (no dialog open, nothing
unsent on the bill, no expense draft open); until then a blue bar says it will.
Each till's version is at the foot of **🛟 Help** ("POS version …") — after an
update every till should show the same one.

**The first update that adds this (from a version without it):** the old
version's offline cache holds the tills on the old screens, and a reload alone
is answered from that cache. On every device that runs the POS:

1. **Send or clear what is on the screen first.** The old version keeps a line
   that hasn't been sent only in the page, so closing the page loses it.
2. **Close every POS tab and window on that device** — the Kitchen screen and
   any second POS tab too, not just the one in front of you — then open the
   POS again. While any old POS tab stays open on a device, that device stays
   on the old version.
3. Do step 2 a second time.
4. Check: **🛟 Help** shows a "POS version" line at the bottom, the same on
   every till (on a phone, scroll to the very end). If 🧾 Expenses is switched
   on (Admin → Features), the owner's login also shows it. If the version line
   is missing, close every POS tab once more.

From then on, updates reach the tills by themselves.
