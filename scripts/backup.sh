#!/bin/sh
# Nightly Postgres backup — a timestamped, gzipped pg_dump, with anything
# older than RETENTION_DAYS pruned. Reads the standard libpq env vars
# (PGHOST, PGUSER, PGPASSWORD, PGDATABASE) so pg_dump picks up the connection
# on its own; docker-compose.yml's `backup` service sets those.
#
# Local backups alone do not survive the thing they exist for: if the Docker
# host dies, the live database and every backup of it die together, because
# both live on that machine. So this script also pushes each dump to an
# off-device destination when one is configured, and records the outcome in the
# database so Admin -> System can report a real last-backup time rather than a
# green light nobody checked.
#
# Off-device destination (optional, nothing is invented if it is unset):
#   BACKUP_REMOTE_TARGET  where to copy the dump. Understood forms:
#                           s3://bucket/prefix        (needs the aws CLI)
#                           user@host:/path           (needs rsync + an SSH key)
#                           /mnt/nas/mamak            (a mounted NAS/USB path)
#   BACKUP_REMOTE_CMD     override entirely: run this instead, with the dump
#                         path as "$1". Anything else you already use.
#
# Credentials are NEVER stored here. Supply them the way the tool expects —
# AWS_* environment variables from the host's .env, or a mounted SSH key — and
# keep them out of git. See docs/RUNBOOK.md.
#
# An unrestored backup is a rumour — see docs/RUNBOOK.md for the restore
# drill (pg_restore/psql into a scratch database, compare row counts).
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/mamak-$STAMP.sql.gz"

pg_dump --no-owner --no-acl "${PGDATABASE:-postgres}" | gzip > "$FILE"
SIZE=$(du -h "$FILE" | cut -f1)
echo "$(date -u +%FT%TZ) backup written: $FILE ($SIZE)"

find "$BACKUP_DIR" -name 'mamak-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

# --- off-device copy ------------------------------------------------------
# A failure here must not lose the local dump that already succeeded, so it is
# reported loudly and recorded, but does not abort the script.
OFFSITE="not configured"
if [ -n "${BACKUP_REMOTE_CMD:-}" ]; then
  if sh -c "$BACKUP_REMOTE_CMD" "$0" "$FILE"; then OFFSITE="copied off-device"
  else OFFSITE="OFF-DEVICE COPY FAILED"; echo "WARNING: BACKUP_REMOTE_CMD failed" >&2; fi
elif [ -n "${BACKUP_REMOTE_TARGET:-}" ]; then
  case "$BACKUP_REMOTE_TARGET" in
    s3://*)
      if command -v aws >/dev/null 2>&1 && aws s3 cp "$FILE" "$BACKUP_REMOTE_TARGET/"; then OFFSITE="copied to object storage"
      else OFFSITE="OFF-DEVICE COPY FAILED"; echo "WARNING: aws s3 cp failed or aws CLI missing" >&2; fi ;;
    /*)
      if mkdir -p "$BACKUP_REMOTE_TARGET" && cp "$FILE" "$BACKUP_REMOTE_TARGET/"; then OFFSITE="copied to mounted path"
      else OFFSITE="OFF-DEVICE COPY FAILED"; echo "WARNING: copy to $BACKUP_REMOTE_TARGET failed" >&2; fi ;;
    *)
      if command -v rsync >/dev/null 2>&1 && rsync -a "$FILE" "$BACKUP_REMOTE_TARGET/"; then OFFSITE="copied to remote host"
      else OFFSITE="OFF-DEVICE COPY FAILED"; echo "WARNING: rsync failed or rsync missing" >&2; fi ;;
  esac
else
  echo "NOTE: BACKUP_REMOTE_TARGET is not set — this backup exists only on this machine." >&2
fi
echo "off-device: $OFFSITE"

# --- record the outcome ---------------------------------------------------
# psql may not be present in a minimal image; the backup itself still stands,
# Admin -> System simply reports "never recorded" instead.
if command -v psql >/dev/null 2>&1; then
  psql -v ON_ERROR_STOP=1 -d "${PGDATABASE:-postgres}" \
    -v note="$SIZE, $OFFSITE" \
    -c "INSERT INTO settings (key, value) VALUES ('last_backup_at', now()::text)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
        INSERT INTO settings (key, value) VALUES ('last_backup_note', :'note')
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;" >/dev/null
fi
