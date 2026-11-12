#!/usr/bin/env bash
# Logical backup of the database (and local uploads, when FILE_STORAGE=local).
#   npm run db:backup -- [output-dir]        default: ./backups
# Uses MIGRATION_DATABASE_URL (the owner role sees every row; the app role is limited by row-level security and
# would produce an empty backup). Writes <dir>/db-<UTC timestamp>.dump (pg_dump custom format) and a .sha256 beside
# it. This complements, and does not replace, your database provider's point-in-time recovery: see docs/operations.md.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
URL="${MIGRATION_DATABASE_URL:?Set MIGRATION_DATABASE_URL (the owner role)}"
OUT="${1:-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
chmod 700 "$OUT"
FILE="$OUT/db-$STAMP.dump"
pg_dump --format=custom --no-owner --file="$FILE" "$URL"
( cd "$OUT" && sha256sum "db-$STAMP.dump" > "db-$STAMP.dump.sha256" )
echo "database: $FILE ($(du -h "$FILE" | cut -f1))"
if [ "${FILE_STORAGE:-local}" = "local" ]; then
  DIR="${FILE_STORAGE_DIR:-.data/uploads}"
  if [ -d "$DIR" ]; then
    tar -czf "$OUT/uploads-$STAMP.tar.gz" -C "$DIR" .
    ( cd "$OUT" && sha256sum "uploads-$STAMP.tar.gz" > "uploads-$STAMP.tar.gz.sha256" )
    echo "uploads:  $OUT/uploads-$STAMP.tar.gz"
  fi
else
  echo "uploads:  in object storage (turn on bucket versioning; not copied by this script)"
fi
echo "The backup holds personal data and encrypted secrets: store it encrypted, and keep APP_ENCRYPTION_KEY separately."
echo "Check it restores: npm run db:restore-drill -- $FILE"
