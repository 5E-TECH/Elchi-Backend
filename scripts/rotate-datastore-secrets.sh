#!/usr/bin/env bash
#
# Prod datastore secret rotation (card AFiXurLH): Postgres password, RabbitMQ
# dedicated user (guest removed), MinIO app key + MinIO root credentials.
# Runbook (order, verification, rollback): docs/ops/secret-rotation.md.
#
# Run ON THE SERVER, from the app dir, as a docker-group user:
#   cd /home/shodiyor/apps/backend
#   bash scripts/rotate-datastore-secrets.sh <step> [--execute]
#
# Without --execute every step only prints what it would do (dry run) and runs
# its read-only checks. Steps, in this order:
#   preflight              read-only: containers, lengths/booleans, which values are the leaked ones
#   prepare                backups of .env.production + .env and NEW values -> $ROT_DIR (0700, files 0600)
#   postgres               ALTER ROLE -> env files -> recreate DB services -> verify old rejected / new works
#   rabbitmq               user elchi (+perms on /) -> RABBITMQ_URI -> recreate app services -> verify -> delete guest
#   minio-app              new secret for the app IAM user (MINIO_ACCESS_KEY) -> recreate file-service -> verify
#   minio-root             new root user+password (.env + .env.production) -> recreate minio -> verify
#   verify                 read-only: old values rejected, new values work, readiness
#   rollback <step>        put that step's OLD value back (postgres|rabbitmq|minio-app|minio-root)
#   cleanup                shred $ROT_DIR once everything is verified (old values gone for good)
#
# Secrets: generated with openssl into $ROT_DIR/new.env; old values only in
# $ROT_DIR/*.before. Never printed (only lengths / ok-fail), never in argv:
# psql/rabbitmqctl/mc get them on stdin, docker gets them via env (-e NAME).
# Live env files are rewritten IN PLACE (same inode, owner, mode, group).
#
# Downtime: `postgres`, `rabbitmq` recreate every app container (~30-60 s
# API gap each) — run in a quiet window. `minio-app`: file-service only.
# `minio-root`: MinIO restarts (~5-10 s; uploads/downloads fail meanwhile).
set -euo pipefail
umask 077
export LC_ALL=C

APP_DIR="${ELCHI_APP_DIR:-$(pwd)}"
ROT_DIR="${ROT_DIR:-$HOME/elchi-ops/rotation}"
DC="docker compose -f $APP_DIR/docker-compose.prod.yml --project-directory $APP_DIR"
ENVP="$APP_DIR/.env.production"
ENVD="$APP_DIR/.env"
NET="${ELCHI_DOCKER_NETWORK:-backend_default}"
PG_IMG="postgres:15"
READINESS_URL="${READINESS_URL:-https://api.elchipochta.uz/health/readiness}"
MQ_NEW_USER="${MQ_NEW_USER:-elchi}"

APP_SERVICES="api-gateway identity-service order-service catalog-service logistics-service finance-service notification-service integration-service analytics-service branch-service investor-service file-service c2c-service search-service ai-service"
# Every app service gets POSTGRES_URI from env_file (simplest: recreate them all)
# + the long-lived sidecars that read it (db-reconcile / activity-log-prune only
# when they are running).
DB_SERVICES="$APP_SERVICES db-backup $(docker ps --format '{{.Names}}' 2>/dev/null | sed -n 's/^elchi-\(db-reconcile\|activity-log-prune\)$/\1/p' | tr '\n' ' ')"

STEP="${1:-}"
EXECUTE=false
for a in "$@"; do [ "$a" = --execute ] && EXECUTE=true; done

say() { echo "[rotate] $*"; }
die() { echo "[rotate] ERROR: $*" >&2; exit 1; }
run() { if $EXECUTE; then "$@"; else echo "[rotate] (dry-run) would: $*"; fi; }

# value of KEY in an env file (last occurrence). Never echo the result.
getv() { grep -E "^$1=" "$2" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
# set KEY=VALUE in an env file IN PLACE (keeps inode/owner/mode). VALUE via env.
setv() {
  local key="$1" file="$2" tmp
  grep -qE "^$key=" "$file" || die "$key not found in $file"
  tmp="$(mktemp "$ROT_DIR/.edit.XXXXXX")"
  K="$key" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]} index($0, k"=")==1 {print k"="v; next} {print}' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}
# replace the password inside scheme://user:PASS@host… of KEY (user kept unless NEWUSER given)
set_uri_creds() {
  local key="$1" file="$2" pass="$3" newuser="${4:-}" cur user rest scheme
  cur="$(getv "$key" "$file")"
  scheme="${cur%%://*}"
  rest="${cur#*://}"
  user="${rest%%:*}"
  rest="${rest#*@}"
  [ -n "$newuser" ] && user="$newuser"
  V="${scheme}://${user}:${pass}@${rest}" setv "$key" "$file"
}
len() { printf '%s' "$1" | wc -c | tr -d ' '; }
same() { [ "$1" = "$2" ] && echo yes || echo no; }

need_prepared() {
  [ -f "$ROT_DIR/new.env" ] && [ -f "$ROT_DIR/env.production.before" ] && [ -f "$ROT_DIR/env.before" ] ||
    die "run 'prepare --execute' first ($ROT_DIR)"
}
newv() { getv "$1" "$ROT_DIR/new.env"; }
oldp() { getv "$1" "$ROT_DIR/env.production.before"; }
oldd() { getv "$1" "$ROT_DIR/env.before"; }

recreate() {
  say "recreating: $*"
  # shellcheck disable=SC2086
  run $DC up -d --no-deps --force-recreate "$@"
}
wait_healthy() {
  $EXECUTE || return 0
  local i bad
  for i in $(seq 1 40); do
    bad="$($DC ps --format '{{.Service}} {{.Status}}' "$@" 2>/dev/null | grep -v -E '\(healthy\)' | grep -v -E '^db-backup ' || true)"
    [ -z "$bad" ] && { say "all healthy: $*"; return 0; }
    sleep 5
  done
  say "NOT healthy after 200 s:"; echo "$bad"
  return 1
}
readiness() {
  local code out=/dev/null
  [ -d "$ROT_DIR" ] && out="$ROT_DIR/readiness.json"
  code="$(curl -s -o "$out" -w '%{http_code}' --max-time 20 "$READINESS_URL" || true)"
  say "readiness $READINESS_URL -> HTTP $code"
  [ "$code" = 200 ]
}

# psql over the DOCKER NETWORK (pg_hba: 127.0.0.1 inside the container is
# `trust`, so only a network login really checks the password). PGPASSWORD via env.
pg_login() { # $1 = password -> exit 0 if login works
  PGPASSWORD="$1" docker run --rm --network "$NET" -e PGPASSWORD "$PG_IMG" \
    psql -h postgres -U "$(getv POSTGRES_USER "$ENVP")" -d "$(getv POSTGRES_DB "$ENVP")" -Atqc 'select 1' >/dev/null 2>&1
}
# Management API on the host's 127.0.0.1:15672 (`rabbitmqctl authenticate_user`
# waits for a TTY password prompt — do not use it here). Credentials reach curl
# via `-K -` (stdin), never argv. 200 = valid; 401 = rejected. Works for users
# with a management tag (guest: administrator; the new user: management).
mq_auth() { # $1 user, $2 password -> exit 0 if valid
  local code
  code="$(printf 'user = "%s:%s"\n' "$1" "$2" |
    curl -s -o /dev/null -w '%{http_code}' --max-time 10 -K - "http://127.0.0.1:15672/api/whoami" || true)"
  [ "$code" = 200 ]
}
minio_login() { # $1 access key, $2 secret (stdin) -> exit 0 if it can list the bucket
  printf '%s\n%s\n' "$1" "$2" | docker exec -i elchi-minio bash -c '
    read -r A; read -r S; export MC_CONFIG_DIR=/tmp/.mc-rot-$$
    MC_HOST_t="http://$A:$S@127.0.0.1:9000" mc ls t/'"$(getv MINIO_BUCKET "$ENVP")"' >/dev/null 2>&1; rc=$?
    rm -rf "$MC_CONFIG_DIR"; exit $rc'
}
minio_admin() { # run `mc admin …` as root (creds from the container env); extra stdin lines -> $L1 $L2
  docker exec -i elchi-minio bash -c '
    read -r L1 || true; read -r L2 || true; export MC_CONFIG_DIR=/tmp/.mc-rot-$$
    export MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:9000"
    '"$1"'; rc=$?; rm -rf "$MC_CONFIG_DIR"; exit $rc'
}

# ---------------------------------------------------------------------------------
step_preflight() {
  say "app dir: $APP_DIR   rotation dir: $ROT_DIR   execute=$EXECUTE"
  [ -f "$ENVP" ] && [ -f "$ENVD" ] || die ".env.production / .env not found in $APP_DIR"
  docker ps --format '{{.Names}} {{.Status}}' | grep -E 'elchi-(postgres|rabbitmq|minio)' || die "datastore containers not running"
  say "POSTGRES_PASSWORD len=$(len "$(getv POSTGRES_PASSWORD "$ENVP")") (validator target: >= 24)"
  say "POSTGRES_URI embeds POSTGRES_PASSWORD: $(case "$(getv POSTGRES_URI "$ENVP")" in *":$(getv POSTGRES_PASSWORD "$ENVP")@"*) echo yes ;; *) echo no ;; esac)"
  say ".env POSTGRES_PASSWORD == .env.production: $(same "$(getv POSTGRES_PASSWORD "$ENVD")" "$(getv POSTGRES_PASSWORD "$ENVP")")"
  case "$(getv RABBITMQ_URI "$ENVP")" in amqp://guest:*) say "RABBITMQ_URI user: guest (to be replaced)" ;; *) say "RABBITMQ_URI user: not guest" ;; esac
  docker exec elchi-rabbitmq rabbitmqctl -q list_users | sed 's/^/[rotate]   mq user: /'
  say "MinIO root (container) == .env MINIO_ACCESS_KEY/SECRET_KEY == .env.production MINIO_ROOT_*: $(same "$(getv MINIO_ACCESS_KEY "$ENVD")" "$(getv MINIO_ROOT_USER "$ENVP")")/$(same "$(getv MINIO_SECRET_KEY "$ENVD")" "$(getv MINIO_ROOT_PASSWORD "$ENVP")")"
  say "MinIO root password len=$(len "$(getv MINIO_ROOT_PASSWORD "$ENVP")"); app secret len=$(len "$(getv MINIO_SECRET_KEY "$ENVP")")"
  say "deploy-user check: .env.production is $(stat -c '%U:%G %a' "$ENVP")"
  if [ -f "$ROT_DIR/new.env" ]; then say "prepared: yes ($ROT_DIR)"; else say "prepared: no"; fi
}

step_prepare() {
  if ! $EXECUTE; then say "(dry-run) would create $ROT_DIR with env backups + new.env"; return 0; fi
  [ -e "$ROT_DIR/new.env" ] && die "$ROT_DIR/new.env already exists — finish/rollback that rotation or remove the dir"
  mkdir -p "$ROT_DIR" && chmod 700 "$ROT_DIR"
  cp -p "$ENVP" "$ROT_DIR/env.production.before"
  cp -p "$ENVD" "$ROT_DIR/env.before"
  chmod 600 "$ROT_DIR/env.production.before" "$ROT_DIR/env.before"
  {
    echo "NEW_PG_PASSWORD=$(openssl rand -hex 24)"         # 48 chars >= 24
    echo "NEW_MQ_USER=$MQ_NEW_USER"
    echo "NEW_MQ_PASSWORD=$(openssl rand -hex 24)"
    echo "NEW_MINIO_APP_SECRET=$(openssl rand -hex 24)"
    echo "NEW_MINIO_ROOT_USER=elchi-root-$(openssl rand -hex 4)"
    echo "NEW_MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)"
  } > "$ROT_DIR/new.env"
  chmod 600 "$ROT_DIR/new.env"
  say "prepared $ROT_DIR (env.production.before, env.before, new.env — 0600). Nothing live changed."
  say "Copy new.env to Dilshod's password manager NOW (VPS loss = these values are needed for R2 restores too)."
}

step_postgres() {
  need_prepared
  local pg_user new old
  pg_user="$(getv POSTGRES_USER "$ENVP")"
  new="$(newv NEW_PG_PASSWORD)"
  old="$(oldp POSTGRES_PASSWORD)"
  [ "$(len "$new")" -ge 24 ] || die "new password too short"
  say "1/4 ALTER ROLE (password over stdin; existing connections stay logged in)"
  if $EXECUTE; then
    printf 'ALTER ROLE "%s" WITH PASSWORD %s;\n' "$pg_user" "'$new'" |
      docker exec -i elchi-postgres psql -q -v ON_ERROR_STOP=1 -U "$pg_user" -d postgres
  else say "(dry-run) would ALTER ROLE $pg_user"; fi
  say "2/4 env files: POSTGRES_PASSWORD + POSTGRES_URI (.env.production), POSTGRES_PASSWORD (.env)"
  if $EXECUTE; then
    V="$new" setv POSTGRES_PASSWORD "$ENVP"
    set_uri_creds POSTGRES_URI "$ENVP" "$new"
    V="$new" setv POSTGRES_PASSWORD "$ENVD"
  fi
  say "3/4 recreate DB services"
  # shellcheck disable=SC2086
  recreate $DB_SERVICES
  # shellcheck disable=SC2086
  wait_healthy $DB_SERVICES || die "services unhealthy — consider: rollback postgres --execute"
  say "4/4 verify"
  if $EXECUTE; then
    pg_login "$new" && say "new password: login OK" || die "new password does NOT work — rollback postgres --execute"
    pg_login "$old" && die "OLD password still works!" || say "old password: rejected (OK)"
    readiness || say "WARNING: readiness not 200 — check $ROT_DIR/readiness.json"
  fi
}

step_rabbitmq() {
  need_prepared
  local u p
  u="$(newv NEW_MQ_USER)"
  p="$(newv NEW_MQ_PASSWORD)"
  say "1/5 add user $u (password via stdin) + full permissions on vhost / (additive — guest still works)"
  if $EXECUTE; then
    if docker exec elchi-rabbitmq rabbitmqctl -q list_users | awk '{print $1}' | grep -qx "$u"; then
      printf '%s\n' "$p" | docker exec -i elchi-rabbitmq rabbitmqctl -q change_password "$u"
    else
      printf '%s\n' "$p" | docker exec -i elchi-rabbitmq rabbitmqctl -q add_user "$u"
    fi
    docker exec elchi-rabbitmq rabbitmqctl -q set_permissions -p / "$u" '.*' '.*' '.*'
    # `management`: scripts/rmq-cleanup-queues.sh uses the HTTP API (it defaulted to guest)
    docker exec elchi-rabbitmq rabbitmqctl -q set_user_tags "$u" management
    mq_auth "$u" "$p" && say "new user authenticates" || die "new user cannot authenticate"
  fi
  say "2/5 RABBITMQ_URI -> amqp://$u:***@… (.env.production and .env)"
  if $EXECUTE; then
    set_uri_creds RABBITMQ_URI "$ENVP" "$p" "$u"
    grep -qE '^RABBITMQ_URI=' "$ENVD" && set_uri_creds RABBITMQ_URI "$ENVD" "$p" "$u"
  fi
  say "3/5 recreate all app services"
  # shellcheck disable=SC2086
  recreate $APP_SERVICES
  # shellcheck disable=SC2086
  wait_healthy $APP_SERVICES || die "services unhealthy — rollback rabbitmq --execute"
  say "4/5 verify: no connection left as guest"
  if $EXECUTE; then
    sleep 5
    docker exec elchi-rabbitmq rabbitmqctl -q list_connections user | sort | uniq -c | sed 's/^/[rotate]   /'
    if docker exec elchi-rabbitmq rabbitmqctl -q list_connections user | grep -qx guest; then
      die "something still connects as guest — find it before deleting guest (rabbitmqctl list_connections user peer_host)"
    fi
    readiness || say "WARNING: readiness not 200"
  fi
  say "5/5 delete guest"
  run docker exec elchi-rabbitmq rabbitmqctl -q delete_user guest
  if $EXECUTE; then
    mq_auth guest guest && die "guest still authenticates!" || say "guest: rejected (OK)"
  fi
}

step_minio_app() {
  need_prepared
  local ak new old
  ak="$(getv MINIO_ACCESS_KEY "$ENVP")"
  new="$(newv NEW_MINIO_APP_SECRET)"
  old="$(oldp MINIO_SECRET_KEY)"
  say "1/4 new secret for the app IAM user (policy readwrite unchanged)"
  if $EXECUTE; then
    printf '%s\n%s\n' "$ak" "$new" | minio_admin 'mc admin user add local "$L1" "$L2" >/dev/null'
  fi
  say "2/4 MINIO_SECRET_KEY in .env.production"
  if $EXECUTE; then V="$new" setv MINIO_SECRET_KEY "$ENVP"; fi
  say "3/4 recreate file-service"
  recreate file-service
  wait_healthy file-service || die "file-service unhealthy — rollback minio-app --execute"
  say "4/4 verify"
  if $EXECUTE; then
    minio_login "$ak" "$new" && say "new app secret: OK" || die "new app secret does NOT work"
    minio_login "$ak" "$old" && die "OLD app secret still works!" || say "old app secret: rejected (OK)"
  fi
}

step_minio_root() {
  need_prepared
  local nu np ou op
  nu="$(newv NEW_MINIO_ROOT_USER)"
  np="$(newv NEW_MINIO_ROOT_PASSWORD)"
  ou="$(oldd MINIO_ACCESS_KEY)"
  op="$(oldd MINIO_SECRET_KEY)"
  say "1/4 IAM export (rollback material) -> $ROT_DIR/minio-iam-before.zip"
  if $EXECUTE; then
    minio_admin 'mkdir -p /tmp/iamx-$$ && cd /tmp/iamx-$$ && mc admin cluster iam export local >/dev/null && cat local-iam-info.zip; rc2=$?; cd /; rm -rf /tmp/iamx-$$; [ $rc2 -eq 0 ]' \
      > "$ROT_DIR/minio-iam-before.zip" < /dev/null || say "WARNING: IAM export failed — users/policies are still in the volume; continue only if you accept that"
  fi
  say "2/4 env: .env MINIO_ACCESS_KEY/MINIO_SECRET_KEY (compose interpolation -> MINIO_ROOT_*), .env.production MINIO_ROOT_USER/PASSWORD"
  if $EXECUTE; then
    V="$nu" setv MINIO_ACCESS_KEY "$ENVD"
    V="$np" setv MINIO_SECRET_KEY "$ENVD"
    V="$nu" setv MINIO_ROOT_USER "$ENVP"
    V="$np" setv MINIO_ROOT_PASSWORD "$ENVP"
  fi
  say "3/4 recreate minio (MinIO restarts ~5-10 s)"
  recreate minio
  wait_healthy minio || die "minio unhealthy — rollback minio-root --execute"
  say "4/4 verify"
  if $EXECUTE; then
    minio_login "$nu" "$np" && say "new root: OK" || die "new root does NOT work — rollback minio-root --execute"
    minio_login "$ou" "$op" && die "OLD root still works!" || say "old root: rejected (OK)"
    minio_login "$(getv MINIO_ACCESS_KEY "$ENVP")" "$(getv MINIO_SECRET_KEY "$ENVP")" && say "app key still works (OK)" || die "app key broken after root change"
    minio_admin 'mc admin user info local elchi-backup-ro >/dev/null' < /dev/null && say "backup read-only user still present (OK)" || say "WARNING: elchi-backup-ro missing"
  fi
}

step_verify() {
  local ok=true
  pg_login "$(getv POSTGRES_PASSWORD "$ENVP")" && say "postgres: current password works" || { say "postgres: current password FAILS"; ok=false; }
  if [ -f "$ROT_DIR/env.production.before" ]; then
    pg_login "$(oldp POSTGRES_PASSWORD)" && { say "postgres: OLD password still works"; ok=false; } || say "postgres: old password rejected"
  fi
  mq_auth guest guest && { say "rabbitmq: guest:guest still works"; ok=false; } || say "rabbitmq: guest rejected"
  docker exec elchi-rabbitmq rabbitmqctl -q list_connections user | sort | uniq -c | sed 's/^/[rotate]   mq connections: /'
  minio_login "$(getv MINIO_ACCESS_KEY "$ENVP")" "$(getv MINIO_SECRET_KEY "$ENVP")" && say "minio: app key works" || { say "minio: app key FAILS"; ok=false; }
  if [ -f "$ROT_DIR/env.before" ]; then
    minio_login "$(oldd MINIO_ACCESS_KEY)" "$(oldd MINIO_SECRET_KEY)" && { say "minio: OLD root still works"; ok=false; } || say "minio: old root rejected"
    minio_login "$(getv MINIO_ACCESS_KEY "$ROT_DIR/env.production.before")" "$(oldp MINIO_SECRET_KEY)" && { say "minio: OLD app secret still works"; ok=false; } || say "minio: old app secret rejected"
  fi
  readiness || ok=false
  $ok && say "VERIFY: all good" || { say "VERIFY: problems above"; return 1; }
}

step_rollback() {
  need_prepared
  local what="${2:-}"
  case "$what" in
    postgres)
      local pg_user old
      pg_user="$(getv POSTGRES_USER "$ENVP")"
      old="$(oldp POSTGRES_PASSWORD)"
      if $EXECUTE; then
        printf 'ALTER ROLE "%s" WITH PASSWORD %s;\n' "$pg_user" "'$old'" |
          docker exec -i elchi-postgres psql -q -v ON_ERROR_STOP=1 -U "$pg_user" -d postgres
        V="$old" setv POSTGRES_PASSWORD "$ENVP"
        V="$(oldp POSTGRES_URI)" setv POSTGRES_URI "$ENVP"
        V="$(oldd POSTGRES_PASSWORD)" setv POSTGRES_PASSWORD "$ENVD"
      fi
      # shellcheck disable=SC2086
      recreate $DB_SERVICES
      ;;
    rabbitmq)
      if $EXECUTE; then
        if ! docker exec elchi-rabbitmq rabbitmqctl -q list_users | awk '{print $1}' | grep -qx guest; then
          printf 'guest\n' | docker exec -i elchi-rabbitmq rabbitmqctl -q add_user guest
          docker exec elchi-rabbitmq rabbitmqctl -q set_permissions -p / guest '.*' '.*' '.*'
          docker exec elchi-rabbitmq rabbitmqctl -q set_user_tags guest administrator
        fi
        V="$(oldp RABBITMQ_URI)" setv RABBITMQ_URI "$ENVP"
        grep -qE '^RABBITMQ_URI=' "$ENVD" && V="$(oldd RABBITMQ_URI)" setv RABBITMQ_URI "$ENVD"
      fi
      # shellcheck disable=SC2086
      recreate $APP_SERVICES
      ;;
    minio-app)
      if $EXECUTE; then
        printf '%s\n%s\n' "$(oldp MINIO_ACCESS_KEY)" "$(oldp MINIO_SECRET_KEY)" | minio_admin 'mc admin user add local "$L1" "$L2" >/dev/null'
        V="$(oldp MINIO_SECRET_KEY)" setv MINIO_SECRET_KEY "$ENVP"
      fi
      recreate file-service
      ;;
    minio-root)
      if $EXECUTE; then
        V="$(oldd MINIO_ACCESS_KEY)" setv MINIO_ACCESS_KEY "$ENVD"
        V="$(oldd MINIO_SECRET_KEY)" setv MINIO_SECRET_KEY "$ENVD"
        V="$(oldp MINIO_ROOT_USER)" setv MINIO_ROOT_USER "$ENVP"
        V="$(oldp MINIO_ROOT_PASSWORD)" setv MINIO_ROOT_PASSWORD "$ENVP"
      fi
      recreate minio
      ;;
    *) die "rollback what? postgres|rabbitmq|minio-app|minio-root" ;;
  esac
  say "rollback $what done — run: verify"
}

step_cleanup() {
  [ -d "$ROT_DIR" ] || { say "nothing to clean"; return 0; }
  run find "$ROT_DIR" -type f -exec shred -u {} +
  run rmdir "$ROT_DIR"
}

case "$STEP" in
  preflight) step_preflight ;;
  prepare) step_prepare ;;
  postgres) step_postgres ;;
  rabbitmq) step_rabbitmq ;;
  minio-app) step_minio_app ;;
  minio-root) step_minio_root ;;
  verify) step_verify ;;
  rollback) step_rollback "$@" ;;
  cleanup) step_cleanup ;;
  *)
    sed -n '2,32p' "$0"
    exit 2
    ;;
esac
