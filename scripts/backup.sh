#!/bin/sh
# Nightly Postgres backup — a timestamped, gzipped pg_dump, with anything
# older than RETENTION_DAYS pruned. Reads the standard libpq env vars
# (PGHOST, PGUSER, PGPASSWORD, PGDATABASE) so pg_dump picks up the connection
# on its own; docker-compose.yml's `backup` service sets those.
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
echo "$(date -u +%FT%TZ) backup written: $FILE ($(du -h "$FILE" | cut -f1))"

find "$BACKUP_DIR" -name 'mamak-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
