# Secret Rotation & Git-History Purge Runbook (Audit P0)

**Status:** ACTION REQUIRED · **Owner:** infra/devops · **Severity:** P0

Live production secrets were committed to git history (`.env.production` in blobs
`fd000be`, `280637f`, and others) and are still present on disk. **Every value
that ever lived in `.env.production` must be treated as compromised and rotated**,
and the file must be scrubbed from history. This is a one-time, coordinated task.

> ⚠️ Do NOT paste real secret values into any tracked file (including this one).
> Generate them on a trusted machine and place them only in the server's
> `.env.production` (which is git-ignored).

---

## 1. Rotate every leaked secret

Generate fresh values on a trusted machine:

```bash
# JWT signing keys (must match between api-gateway and identity-service)
openssl rand -hex 32   # ACCESS_TOKEN_KEY
openssl rand -hex 32   # REFRESH_TOKEN_KEY

# Integration credential encryption secret (Joi requires >= 32 chars)
openssl rand -hex 32   # INTEGRATION_CREDENTIAL_SECRET

# Datastore / object-store / broker credentials
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 16   # MINIO_ACCESS_KEY
openssl rand -hex 24   # MINIO_SECRET_KEY
openssl rand -hex 16   # RABBITMQ password (replace guest:guest)

# Superadmin seed password: strong, unique, >= 12 chars (NOT "0990")

# Swagger basic-auth (SWAGGER_USER / SWAGGER_PASSWORD)
openssl rand -hex 16   # SWAGGER_PASSWORD
```

> **Telegram bot tokens are NOT openssl-generated — revoke + reissue them:**
> `TELEGRAM_BOT_TOKEN` and `ORDER_BOT_TOKEN` were leaked in history. A leaked bot
> token grants full control of the bot, so message @BotFather → `/revoke` for
> each bot (this immediately invalidates the old token) and paste the new token
> into `.env.production`. There is no way to "rotate" a bot token other than
> revoking it.

Then, on the server, edit `.env.production` with the new values and apply them to
the running datastores:

- **Postgres**: `ALTER USER <user> WITH PASSWORD '<new>';` then update
  `POSTGRES_PASSWORD` / `POSTGRES_URI`.
- **MinIO**: rotate the root user/password (or create a new access key and retire
  the old) and update `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`.
- **RabbitMQ**: create a real user, set `RABBITMQ_DEFAULT_USER` / `_PASS`, update
  `RABBITMQ_URI`, and disable the default `guest` account.
- **Cloudflare Tunnel**: revoke the leaked `TUNNEL_TOKEN` in the Zero-Trust
  dashboard and issue a new one.
- **JWT keys**: rotating `ACCESS_TOKEN_KEY` / `REFRESH_TOKEN_KEY` invalidates all
  existing sessions — expect every user to re-login. Do it in a maintenance window.
- **Superadmin**: reset the seeded admin's password to the new strong value.
- **Telegram bots**: `/revoke` both `TELEGRAM_BOT_TOKEN` and `ORDER_BOT_TOKEN`
  via @BotFather, then update `.env.production`. (Revoking is immediate — the old
  token stops working the moment you revoke.)
- **Swagger**: set new `SWAGGER_USER` / `SWAGGER_PASSWORD` (the Swagger UI basic-auth).

> **Complete leaked-secret checklist** (every key that ever lived in
> `.env.production` and must be treated as compromised): `ACCESS_TOKEN_KEY`,
> `REFRESH_TOKEN_KEY`, `INTEGRATION_CREDENTIAL_SECRET`, `POSTGRES_PASSWORD`
> (+ `POSTGRES_URI`), `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, RabbitMQ creds
> (+ `RABBITMQ_URI`), `SUPERADMIN_PASSWORD`, `TUNNEL_TOKEN`, `TELEGRAM_BOT_TOKEN`,
> `ORDER_BOT_TOKEN`, `SWAGGER_USER`, `SWAGGER_PASSWORD`.

Restart the stack so every service picks up the new `.env.production`:

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate
```

## 2. Purge `.env.production` from git history

`.env.production` is now git-ignored, but its historical blobs still leak (audit
found it in **9 commits**). Rewrite history with `git filter-repo` (preferred) or
BFG. **This is destructive and force-pushes — coordinate with everyone who has a
clone.**

> ⏱️ **Timing — do the purge with NO open PRs.** A history rewrite + force-push
> changes every commit SHA, which breaks any open pull request and every
> outstanding branch. Merge or close open PRs first (e.g. the audit-remediation
> branch), then rewrite from the resulting `dev`/`main`. Rotation (§1) is
> independent — do it immediately; the purge can follow once branches are settled.
>
> Note: the purge is the *belt-and-suspenders* step. **Rotation (§1) is what
> actually closes the exposure** — once every leaked value is changed, the old
> blobs in history are worthless. Prioritise §1.

```bash
# From a fresh mirror clone:
pip install git-filter-repo         # or: brew install git-filter-repo
git filter-repo --path .env.production --invert-paths --force

# Re-add the remote (filter-repo drops it) and force-push all branches:
git remote add origin <REPO_URL>
git push origin --force --all
git push origin --force --tags
```

After the rewrite, **every collaborator must re-clone** (their old clones still
carry the secrets). Old clones and any CI caches should be deleted.

## 3. Prevent recurrence (already wired)

- `.gitignore` ignores `.env`, `.env.production`, `.env.local`, `backups/`, and
  `*.sql.gz`.
- CI runs a **gitleaks** secret-scan job (`.github/workflows/ci.yml` +
  `.gitleaks.toml`) that fails a PR adding a real secret to a tracked file.
- `.env.example` ships only `__REPLACE_WITH...__` placeholders — no real defaults.

## 4. Verify

```bash
# No .env.production anywhere in history:
git log --all --oneline -- .env.production        # → empty
# Working tree is clean of secrets:
gitleaks detect --no-git --config .gitleaks.toml --redact -v
```

## Checklist

- [ ] All JWT/DB/MinIO/RabbitMQ/Cloudflare/superadmin secrets rotated on the server
- [ ] Datastores updated (Postgres/MinIO/RabbitMQ) and stack recreated
- [ ] `git filter-repo` run and force-pushed
- [ ] Team notified to re-clone; stale clones/CI caches purged
- [ ] `git log --all -- .env.production` is empty
- [ ] gitleaks working-tree scan is clean
