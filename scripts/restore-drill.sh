#!/usr/bin/env bash
#
# Monthly restore drill (card 6RaEn5cN, docs/ops/backup-rpo-rto.md §3):
# newest DB dump in R2 (daily/ + pre-deploy/) -> THIS machine -> throwaway
# postgres:15 container -> row count of every table vs the dump's own COPY
# blocks. Prints sizes and timings; deletes the local copy and the container
# at the end (also on failure). Never touches prod. Monthly on GitHub Actions
# when RESTORE_DRILL_ENABLED is on (.github/workflows/restore-drill.yml).
#
# Usage:  bash scripts/restore-drill.sh <empty work dir>
# R2 keys (never printed, never in argv — docker gets them via `-e NAME`):
#   env R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#   (R2_ENDPOINT overrides the Cloudflare endpoint)
#   or RESTORE_DRILL_SSH=user@server: read from the server's .env.production
#      (RESTORE_DRILL_ENV_PATH, default /home/shodiyor/apps/backend/.env.production)
# Optional:
#   OFFSITE_ENCRYPTION_KEY — the copies are client-side encrypted (6RaEn5cN):
#      read them through the crypt remote, under encrypted/ in the bucket.
#   RESTORE_DRILL_MINIO_BUCKET=elchi-files — also download the whole MinIO copy
#      (minio/<bucket>/current) and compare object count and bytes with R2. Every
#      object is verified while it downloads (MD5; through crypt, the auth tag).
# Optional: RESTORE_DRILL_LOCK=<file> — run the restore under `flock <file>`
#           (shared dev machines).
set -euo pipefail
set +x
umask 077

WORK="${1:?usage: restore-drill.sh <empty work dir>}"
CN="elchi-restore-drill-$$"
RCLONE_IMG="rclone/rclone:1.68.2"
PG_IMG="postgres:15"

if [ -n "${RESTORE_DRILL_SSH:-}" ]; then
  ENVF="${RESTORE_DRILL_ENV_PATH:-/home/shodiyor/apps/backend/.env.production}"
  getk() { ssh -o BatchMode=yes "$RESTORE_DRILL_SSH" "grep -E '^$1=' '$ENVF' | tail -n 1 | cut -d= -f2-"; }
  R2_ACCOUNT_ID="$(getk R2_ACCOUNT_ID)"
  R2_ACCESS_KEY_ID="$(getk R2_ACCESS_KEY_ID)"
  R2_SECRET_ACCESS_KEY="$(getk R2_SECRET_ACCESS_KEY)"
  R2_BUCKET="$(getk R2_BUCKET)"
  OFFSITE_ENCRYPTION_KEY="$(getk OFFSITE_ENCRYPTION_KEY)"
fi
: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_BUCKET:?}"
RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY RCLONE_CONFIG_R2_ENDPOINT
unset R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

# Client-side encrypted copies: same layout as scripts/backup-offsite.sh.
SRC_ROOT="r2:$R2_BUCKET"
MD5_ARGS=()
CRYPT_ENV=()
if [ -n "${OFFSITE_ENCRYPTION_KEY:-}" ]; then
  RCLONE_CONFIG_R2CRYPT_PASSWORD="$(printf '%s\n' "$OFFSITE_ENCRYPTION_KEY" | docker run --rm -i "$RCLONE_IMG" obscure -)"
  export RCLONE_CONFIG_R2CRYPT_PASSWORD
  unset OFFSITE_ENCRYPTION_KEY
  SRC_ROOT="r2crypt:encrypted"
  MD5_ARGS=(--download)
  CRYPT_ENV=(-e RCLONE_CONFIG_R2CRYPT_TYPE=crypt -e "RCLONE_CONFIG_R2CRYPT_REMOTE=r2:$R2_BUCKET"
    -e RCLONE_CONFIG_R2CRYPT_FILENAME_ENCRYPTION=off -e RCLONE_CONFIG_R2CRYPT_DIRECTORY_NAME_ENCRYPTION=false
    -e RCLONE_CONFIG_R2CRYPT_PASSWORD)
fi

mkdir -p "$WORK/dl" "$WORK/out"
chmod 700 "$WORK" "$WORK/dl"
cleanup() {
  docker rm -f "$CN" > /dev/null 2>&1 || true
  rm -rf "$WORK/dl"
}
trap cleanup EXIT

ts() { date +%s.%N; }
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }
rc() {
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$WORK/dl:/restore" \
    -e RCLONE_CONFIG= -e RCLONE_CONFIG_R2_TYPE=s3 -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    -e RCLONE_CONFIG_R2_REGION=auto -e RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true \
    -e RCLONE_CONFIG_R2_ENDPOINT -e RCLONE_CONFIG_R2_ACCESS_KEY_ID -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY \
    "${CRYPT_ENV[@]}" "$RCLONE_IMG" "$@"
}

# 1. newest dump in R2
NEWEST="$({
  rc lsf "$SRC_ROOT/daily" --files-only --include '*.sql.gz' --format tp --separator ' ' | sed 's#$# daily#'
  rc lsf "$SRC_ROOT/pre-deploy" --files-only --include '*.sql.gz' --format tp --separator ' ' | sed 's#$# pre-deploy#'
} | sort | tail -n 1)"
F="$(echo "$NEWEST" | awk '{print $3}')"
D="$(echo "$NEWEST" | awk '{print $4}')"
[ -n "$F" ] || { echo "no dump found in $SRC_ROOT/{daily,pre-deploy}" >&2; exit 1; }
echo "newest: $D/$F (R2 time $(echo "$NEWEST" | awk '{print $1" "$2}'))"

# 2. download + verify
T1=$(ts)
rc copy "$SRC_ROOT/$D/$F" /restore --stats 0
T2=$(ts)
R2_MD5="$(rc md5sum "${MD5_ARGS[@]}" "$SRC_ROOT/$D/$F" | awk '{print $1}')"
LOCAL_MD5="$(md5sum "$WORK/dl/$F" | awk '{print $1}')"

# 2b. MinIO copy (optional, see the header)
if [ -n "${RESTORE_DRILL_MINIO_BUCKET:-}" ]; then
  M="$SRC_ROOT/minio/$RESTORE_DRILL_MINIO_BUCKET/current"
  T3=$(ts)
  rc copy "$M" /restore/minio --stats 0 --transfers 4
  T4=$(ts)
  SIZE="$(rc size "$M" --json)"
  R2_N="$(echo "$SIZE" | sed -n 's/.*"count": *\([0-9]*\).*/\1/p')"
  R2_B="$(echo "$SIZE" | sed -n 's/.*"bytes": *\([0-9]*\).*/\1/p')"
  LOCAL_N="$(find "$WORK/dl/minio" -type f | wc -l)"
  LOCAL_B="$(find "$WORK/dl/minio" -type f -printf '%s\n' | awk '{s += $1} END {print s + 0}')"
  echo "minio: $LOCAL_N objects, $LOCAL_B B, $(el "$T3" "$T4") s; R2: $R2_N objects, $R2_B B"
  [ "$LOCAL_N" = "$R2_N" ] && [ "$LOCAL_B" = "$R2_B" ] && [ "$LOCAL_N" -gt 0 ] ||
    { echo "minio verification FAILED" >&2; exit 1; }
  rm -rf "$WORK/dl/minio"
fi
unset RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY RCLONE_CONFIG_R2CRYPT_PASSWORD
gzip -t "$WORK/dl/$F"
TRAILER=no
gzip -dc "$WORK/dl/$F" | tail -n 8 | grep -q 'PostgreSQL database dump complete' && TRAILER=yes
echo "download: $(stat -c %s "$WORK/dl/$F") B gz, $(gzip -dc "$WORK/dl/$F" | wc -c) B sql, $(el "$T1" "$T2") s;" \
  "md5 R2==local: $([ "$R2_MD5" = "$LOCAL_MD5" ] && echo yes || echo NO); gzip ok; dump-complete trailer: $TRAILER"
[ "$R2_MD5" = "$LOCAL_MD5" ] && [ "$TRAILER" = yes ] || { echo "dump verification FAILED" >&2; exit 1; }

# 3. expected rows = the dump's COPY blocks
gzip -dc "$WORK/dl/$F" | awk '
  /^COPY [^ ]+ / { t = $2; n = 0; inb = 1; next }
  inb && /^\\\.$/ { print t, n; inb = 0; next }
  inb { n++ }
' | sort > "$WORK/out/expected.txt"
echo "dump: $(wc -l < "$WORK/out/expected.txt") tables with data, $(awk '{s += $2} END {print s + 0}' "$WORK/out/expected.txt") rows"
awk '{printf "select %c%s%c, count(*) from %s union all\n", 39, $1, 39, $1}' "$WORK/out/expected.txt" |
  sed '$ s/ union all$/;/' > "$WORK/out/count.sql"
cat > "$WORK/out/stats.sql" << 'SQL'
select pg_size_pretty(pg_database_size(current_database())),
       (select count(*) from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema'),
       (select count(*) from information_schema.tables
         where table_schema not in ('pg_catalog', 'information_schema') and table_type = 'BASE TABLE');
SQL

# 4. restore into a throwaway postgres:15
restore() {
  docker run -d --name "$CN" --memory 1g -e POSTGRES_PASSWORD=drill-only-local -e POSTGRES_DB=restore_check "$PG_IMG" > /dev/null
  for _ in $(seq 1 60); do docker exec "$CN" pg_isready -q -U postgres -d restore_check 2> /dev/null && break; sleep 1; done
  sleep 2
  echo "server: $(docker exec "$CN" psql -At -U postgres -c 'show server_version')"
  R0=$(ts)
  gzip -dc "$WORK/dl/$F" | docker exec -i "$CN" psql -q -v ON_ERROR_STOP=1 -U postgres -d restore_check > "$WORK/out/restore.log" 2>&1
  R1=$(ts)
  echo "restore: $(el "$R0" "$R1") s (psql errors: $(grep -c -i 'error' "$WORK/out/restore.log" || true))"
  docker exec -i "$CN" psql -At -F ' ' -U postgres -d restore_check < "$WORK/out/count.sql" | sort > "$WORK/out/actual.txt"
  docker exec -i "$CN" psql -At -F ' | ' -U postgres -d restore_check < "$WORK/out/stats.sql" |
    awk -F' [|] ' '{print "restored db: " $1 ", schemas: " $2 ", tables: " $3}'
}
if [ -n "${RESTORE_DRILL_LOCK:-}" ]; then
  export -f restore ts el
  export CN WORK F PG_IMG
  flock "$RESTORE_DRILL_LOCK" bash -c 'set -euo pipefail; restore'
else
  restore
fi

# 5. compare
if diff -q "$WORK/out/expected.txt" "$WORK/out/actual.txt" > /dev/null; then
  echo "row counts: ALL $(wc -l < "$WORK/out/expected.txt") tables match the dump"
else
  echo "row counts: MISMATCH (dump vs restored):"
  diff "$WORK/out/expected.txt" "$WORK/out/actual.txt" | head -n 20
  exit 1
fi
