#!/usr/bin/env bash
#
# One-time preparation of the STAGING (test) server — Ubuntu 24.04, run as root:
#
#   ACTIONS_PUBKEY='ssh-ed25519 AAAA… elchi-staging-actions' \
#     bash scripts/staging/bootstrap-server.sh
#
# (or copy just this file to the server: `scp scripts/staging/bootstrap-server.sh root@<ip>:`).
# Runbook: docs/ops/staging.md. IDEMPOTENT: safe to re-run after every fix —
# each step checks first and only adds what is missing. It never deletes,
# resets or overwrites anything: an existing checkout, .env.staging, key,
# swap file or firewall rule is left as it is.
#
# What it does:
#   1. apt: git, curl, ufw, fail2ban; Docker Engine + Compose plugin from
#      Docker's own apt repository (Ubuntu's docker.io ships a Compose too old
#      for docker-compose.staging.yml's `!override`, needs >= 2.24.4).
#   2. deploy user ($DEPLOY_USER, in the docker group) — GitHub Actions logs in
#      as this user with the key in ACTIONS_PUBKEY (its private half goes only
#      into the GitHub `staging` environment secret SSH_PRIVATE_KEY).
#   3. read-only GitHub deploy key for that user (the server `git fetch`es the
#      repo); prints the PUBLIC key to add in GitHub -> Deploy keys.
#   4. $APP_DIR: clone of branch $REPO_BRANCH (once the deploy key is added) and
#      .env.staging from .env.staging.example (chmod 600) — to be filled in.
#   5. swap file ($SWAP_SIZE) if the box has no swap: building 15 images on
#      8 GB must not get OOM-killed.
#   6. ufw: deny incoming except SSH (every port sshd listens on + $SSH_PORT).
#      Nothing else needs to be open — the API is reached only through the
#      Cloudflare tunnel (outbound) and every compose port binds to 127.0.0.1.
#   7. fail2ban sshd jail.
#
# Env (all optional):
#   DEPLOY_USER     deploy                          SSH user for GitHub Actions
#   APP_DIR         /opt/elchi-staging              = GitHub secret SERVER_APP_PATH
#   REPO_URL        git@github.com:5E-TECH/Elchi-Backend.git
#   REPO_BRANCH     test
#   ACTIONS_PUBKEY  public key line for Actions (skipped when empty)
#   SSH_PORT        22                              extra port to allow in ufw
#   SWAP_SIZE       4G                              0 = no swap file
#   SKIP_FIREWALL   0                               1 = leave ufw/fail2ban alone
#
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="${APP_DIR:-/opt/elchi-staging}"
REPO_URL="${REPO_URL:-git@github.com:5E-TECH/Elchi-Backend.git}"
REPO_BRANCH="${REPO_BRANCH:-test}"
ACTIONS_PUBKEY="${ACTIONS_PUBKEY:-}"
SSH_PORT="${SSH_PORT:-22}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
SKIP_FIREWALL="${SKIP_FIREWALL:-0}"
# GitHub's published Ed25519 host key fingerprint
# (docs.github.com -> "GitHub's SSH key fingerprints").
GITHUB_ED25519_FP='SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'

log() { echo "[bootstrap] $*"; }
warn() { echo "[bootstrap] WARNING: $*" >&2; }
die() {
  echo "[bootstrap] ERROR: $*" >&2
  exit 1
}
as_deploy() { sudo -u "$DEPLOY_USER" -H "$@"; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo -i)"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || die "Ubuntu expected (found ${ID:-unknown})"
  [ "${VERSION_ID:-}" = 24.04 ] || warn "written for Ubuntu 24.04, this is ${VERSION_ID:-?}"
fi
NEXT=()

# --- 1. packages + Docker ------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
log "apt: base packages"
apt-get update -qq
apt-get install -y -q ca-certificates curl git ufw fail2ban sudo openssh-client >/dev/null

if ! docker compose version >/dev/null 2>&1; then
  if dpkg -s docker.io >/dev/null 2>&1; then
    die "Ubuntu's docker.io package is installed — remove it yourself (apt-get remove docker.io docker-compose-v2) and re-run; this script does not uninstall anything"
  fi
  log "Docker: adding Docker's apt repository and installing docker-ce + compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  [ -s /etc/apt/keyrings/docker.asc ] ||
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  [ -f /etc/apt/sources.list.d/docker.list ] ||
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME:-noble} stable" \
      > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
else
  log "Docker: already installed ($(docker --version))"
fi
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo 0)"
if [ "$(printf '%s\n' 2.24.4 "${COMPOSE_VERSION#v}" | sort -V | head -n 1)" != 2.24.4 ]; then
  die "Docker Compose ${COMPOSE_VERSION} < 2.24.4 — upgrade docker-compose-plugin (Docker's apt repo)"
fi
log "Docker Compose ${COMPOSE_VERSION} ok"

# --- 2. deploy user -------------------------------------------------------------
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  log "user $DEPLOY_USER: exists"
else
  log "user $DEPLOY_USER: creating (no password — SSH key login only)"
  adduser --disabled-password --gecos "Elchi staging deploy" "$DEPLOY_USER" >/dev/null
fi
getent group docker >/dev/null || groupadd docker
id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker || usermod -aG docker "$DEPLOY_USER"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
AUTH_KEYS="$DEPLOY_HOME/.ssh/authorized_keys"
[ -f "$AUTH_KEYS" ] || install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$AUTH_KEYS"
if [ -n "$ACTIONS_PUBKEY" ]; then
  case "$ACTIONS_PUBKEY" in
    ssh-ed25519\ * | ssh-rsa\ * | ecdsa-sha2-*) ;;
    *) die "ACTIONS_PUBKEY does not look like a PUBLIC key line (ssh-ed25519 AAAA…) — never pass the private key here" ;;
  esac
  if grep -qxF "$ACTIONS_PUBKEY" "$AUTH_KEYS"; then
    log "Actions key: already authorized"
  else
    echo "$ACTIONS_PUBKEY" >> "$AUTH_KEYS"
    log "Actions key: added to $AUTH_KEYS"
  fi
elif [ ! -s "$AUTH_KEYS" ]; then
  NEXT+=("GitHub Actions kaliti yo'q: ACTIONS_PUBKEY='ssh-ed25519 …' bilan skriptni qayta ishga tushiring")
fi

# --- 3. GitHub deploy key (read-only fetch of the repo) ---------------------------
GH_KEY="$DEPLOY_HOME/.ssh/elchi_github"
if [ ! -f "$GH_KEY" ]; then
  log "GitHub deploy key: generating $GH_KEY"
  as_deploy ssh-keygen -q -t ed25519 -N '' -C "elchi-staging-deploy@$(hostname)" -f "$GH_KEY"
fi
SSH_CFG="$DEPLOY_HOME/.ssh/config"
if ! grep -qs 'elchi_github' "$SSH_CFG"; then
  printf 'Host github.com\n  IdentityFile ~/.ssh/elchi_github\n  IdentitiesOnly yes\n' >> "$SSH_CFG"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$SSH_CFG"
  chmod 600 "$SSH_CFG"
fi
KNOWN="$DEPLOY_HOME/.ssh/known_hosts"
if ! as_deploy ssh-keygen -F github.com -f "$KNOWN" >/dev/null 2>&1; then
  SCAN="$(ssh-keyscan -t ed25519 github.com 2>/dev/null || true)"
  if [ -n "$SCAN" ] && [ "$(printf '%s\n' "$SCAN" | ssh-keygen -lf - | awk '{print $2}')" = "$GITHUB_ED25519_FP" ]; then
    printf '%s\n' "$SCAN" >> "$KNOWN"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$KNOWN"
    chmod 644 "$KNOWN"
    log "github.com host key: verified ($GITHUB_ED25519_FP) and trusted"
  else
    warn "github.com host key did not match $GITHUB_ED25519_FP — NOT trusted; check the network and re-run"
  fi
fi

# --- 4. app dir: checkout + .env.staging -------------------------------------------
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  log "checkout: $APP_DIR already exists — left as is (the deploy updates it)"
elif [ -n "$(ls -A "$APP_DIR")" ]; then
  warn "$APP_DIR is not empty and not a git checkout — not touching it"
  NEXT+=("$APP_DIR ni tekshiring (bo'sh emas, git emas)")
elif as_deploy git clone -q -b "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"; then
  log "checkout: cloned $REPO_URL ($REPO_BRANCH) into $APP_DIR"
else
  NEXT+=("Repo klonlanmadi: deploy key qo'shilganini va '$REPO_BRANCH' branchi borligini tekshiring, so'ng skriptni qayta ishga tushiring")
fi
if [ -d "$APP_DIR/.git" ] && [ ! -f "$APP_DIR/.env.staging" ] && [ -f "$APP_DIR/.env.staging.example" ]; then
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/.env.staging.example" "$APP_DIR/.env.staging"
  log ".env.staging: created from .env.staging.example (chmod 600) — FILL IT before the first deploy"
fi
# ./backups must belong to the deploy user BEFORE the first deploy: otherwise
# the db-backup bind mount makes Docker create it as root, and the next
# deploy's pre-deploy dump (run as $DEPLOY_USER) cannot create backups/pre-deploy.
if [ -d "$APP_DIR/.git" ] && [ ! -e "$APP_DIR/backups" ]; then
  install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/backups"
  log "backups: created $APP_DIR/backups (owner $DEPLOY_USER)"
fi
if [ -f "$APP_DIR/.env.staging" ] && grep -q '__REPLACE_WITH' "$APP_DIR/.env.staging"; then
  NEXT+=("$APP_DIR/.env.staging ni to'ldiring (__REPLACE_WITH…__ qolgan — deploy ularsiz ishlamaydi)")
fi

# --- 5. swap ------------------------------------------------------------------------
if [ "$SWAP_SIZE" = 0 ]; then
  log "swap: skipped (SWAP_SIZE=0)"
elif [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
  log "swap: already active"
elif [ -e /swapfile ]; then
  warn "/swapfile exists but is not active — not touching it"
else
  log "swap: creating /swapfile ($SWAP_SIZE)"
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -qs '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- 6./7. firewall + fail2ban ----------------------------------------------------------
if [ "$SKIP_FIREWALL" = 1 ]; then
  log "ufw/fail2ban: skipped (SKIP_FIREWALL=1)"
else
  SSH_PORTS="$( { sshd -T 2>/dev/null | awk '$1 == "port" {print $2}'; echo "$SSH_PORT"; } | sort -un | tr '\n' ' ')"
  for p in $SSH_PORTS; do
    ufw allow "$p/tcp" >/dev/null
  done
  if ufw status | grep -q '^Status: active'; then
    log "ufw: already active (ensured SSH: $SSH_PORTS)"
  else
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
    ufw --force enable >/dev/null
    log "ufw: enabled — incoming only SSH ($SSH_PORTS)"
  fi
  JAIL=/etc/fail2ban/jail.d/elchi-sshd.local
  if [ ! -f "$JAIL" ]; then
    printf '[sshd]\nenabled = true\nport = %s\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' \
      "$(echo "$SSH_PORTS" | xargs | tr ' ' ',')" > "$JAIL"
    log "fail2ban: sshd jail written ($JAIL)"
  fi
  systemctl enable --now fail2ban >/dev/null 2>&1 || warn "fail2ban did not start — check: systemctl status fail2ban"
  systemctl reload fail2ban >/dev/null 2>&1 || true
fi

# --- summary ------------------------------------------------------------------------
echo
log "done. GitHub secrets for the 'staging' environment:"
log "  SERVER_IP        = $(hostname -I 2>/dev/null | awk '{print $1}') (public IP of this server)"
log "  SERVER_SSH_PORT  = $SSH_PORT"
log "  SERVER_USER      = $DEPLOY_USER"
log "  SERVER_APP_PATH  = $APP_DIR"
log "  SSH_PRIVATE_KEY  = private half of ACTIONS_PUBKEY (stays on your machine / in GitHub only)"
echo
log "GitHub -> repo Settings -> Deploy keys -> Add (read-only, NO write access):"
cat "$GH_KEY.pub"
if [ "${#NEXT[@]}" -gt 0 ]; then
  echo
  log "keyingi qadamlar:"
  for n in "${NEXT[@]}"; do log "  - $n"; done
fi
