# Pending Actions — work deferred from the audit remediation

Living checklist of what remains after `fix/sprint0-audit-remediation`. Each item
says **who** must do it and **why** it wasn't done in the branch. Full remediation
history: `REMEDIATION_2026-08-12.md`.

Legend — Owner: 👤 = infra/USER action · 🤝 = needs a product/frontend decision ·
🛠️ = a dev can do it (blocked only on environment/coordination).

---

## 🔴 HIGH — do first

### 1. Execute secret rotation  ·  Owner: 👤
The leaked production secrets are **still live** in git history (`.env.production`
across 9 commits) until rotated. Runbook: `SECRET_ROTATION_RUNBOOK.md`.
Helper: `scripts/rotate-secrets.sh` (generates the auto-generatable values into a
git-ignored `.env.production.new`, no values printed).

**Step-by-step (run ON THE PRODUCTION SERVER, in a maintenance window — JWT
rotation logs everyone out; DB/RabbitMQ password change needs a restart):**

1. **Generate** — `bash scripts/rotate-secrets.sh` → creates `.env.production.new`
   (+ backup) with fresh JWT keys, POSTGRES/MINIO/SWAGGER passwords, and the
   passwords inside `POSTGRES_URI` / `RABBITMQ_URI`. Then fill the MANUAL values
   into `.env.production.new`:
   - `TELEGRAM_BOT_TOKEN`, `ORDER_BOT_TOKEN` → @BotFather → `/revoke` each → new token
   - `TUNNEL_TOKEN` → Cloudflare Zero-Trust dashboard → revoke + reissue
   - `SUPERADMIN_PASSWORD` → strong, unique (not the old "0990")
2. **Apply datastore-side** (using the new values):
   - Postgres: `ALTER USER <POSTGRES_USER> WITH PASSWORD '<new>';`
   - MinIO: rotate root user/password (or new access key, retire old)
   - RabbitMQ: create a real user + password, disable the default `guest`
   - Cloudflare / BotFather: done in step 1 (dashboard / revoke)
3. **Swap + restart** — `diff .env.production.bak.* .env.production.new` (review),
   `mv .env.production.new .env.production`,
   `docker compose -f docker-compose.prod.yml up -d --force-recreate`
4. **Verify** — services healthy (docker healthchecks green), login works (new JWT
   keys), a DB write works (new pg password), bots respond (new tokens). Delete
   the `.env.production.bak.*` once confirmed.

### 2. Purge `.env.production` from git history  ·  Owner: 👤
Belt-and-suspenders once §1 is done. **Do it with NO open PRs** (a history rewrite
changes every SHA and breaks open branches) — i.e. after this branch merges.
Commands in `SECRET_ROTATION_RUNBOOK.md §2` (`git filter-repo --path
.env.production --invert-paths` → force-push all + tags → everyone re-clones).

---

## 🟡 MEDIUM

### 3. File per-object ownership registry  ·  Owner: 🛠️
File IDOR is currently closed by a prefix + staff-role heuristic
(`file-gateway.controller.ts`). A staff user could still fetch another entity's
private file if the key prefix matches. A true per-object ownership record
(who/what entity owns each stored key, checked on signed-URL / read) closes it
fully. Needs a small ownership table + a check on the file read/URL paths.

### 4. DB-backed integration tests  ·  Owner: 🛠️ (env)
Unit tests mock the repo, so SQL correctness (money aggregations, migrations, the
new column-narrowing, any future JS→SQL push-down) isn't exercised end-to-end. Add
a docker-compose test Postgres + a small integration suite in CI. Blocked here
only by the lack of a test DB in this environment.

### 5. Per-service RMQ payload validation  ·  Owner: 🛠️ (low value)
Microservice `@MessagePattern` handlers take plain typed objects, not
class-validator DTOs, so the gateway's global `ValidationPipe` is the only
validation layer. Internal callers are trusted, so this is low priority; if done,
convert hot-path payloads to validated DTO classes + a microservice `ValidationPipe`.

---

## 🟢 LOW

### 6. Response-envelope consolidation  ·  Owner: 🤝
Responses are inconsistent (`{data}` vs raw). Standardising the shape is
frontend-breaking, so it needs coordination with the frontend team (or a
versioned `/v2` surface — versioning infra is already in place).

### 7. Analytics JS→SQL GROUP BY push-down  ·  Owner: 🛠️ (env)
`getRevenueStats` / market / courier aggregate in JS. A SQL `GROUP BY` push-down
is a perf win but changes how money figures are computed — needs a DB-backed
equivalence test (see #4). Memory is already bounded by the date-span cap + column
narrowing, so this is optimisation, not a bug.

### 8. Finance `findAllHistory` cashbox-id subquery  ·  Owner: 🛠️ (low value)
Loads all cashbox ids of a type then filters history by `IN (...)`. A `Raw()`
subquery would avoid the load but needs exact schema-qualified identifiers
verifiable only against a real DB, and the load is in practice bounded by the
cashbox count. Low value / unfavourable risk.

### 9. Single-host HA  ·  Owner: 🤝
One Postgres / one host (docker-compose) = SPOF. Multi-host / managed DB / k8s is a
separate infra investment, fine for the current scale.

### 10. Grandfathered migration-timestamp collisions  ·  Owner: 🛠️ (cosmetic)
Three existing collisions (unrelated tables, already ran in prod) are grandfathered
by `migration-timestamp.guard.spec.ts`. Renumbering is cosmetic and only safe on a
fresh environment.
