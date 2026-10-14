# Elchi-Backend

Backend for **Elchi Pochta** — a courier / logistics + cash-on-delivery (COD)
money-handling platform (Uzbekistan). It runs deliveries end-to-end: order
intake (internal, branch, and marketplace-partner), courier dispatch, branch
transfer batches, COD settlement up the chain (courier → branch → HQ → market),
cashboxes, operator/investor earnings, analytics, notifications and search.

## Architecture

A **NestJS monorepo**: one HTTP **api-gateway** in front of **14 microservices**
that communicate over **RabbitMQ** (`@nestjs/microservices`, mostly synchronous
request/reply plus a transactional outbox for state-change events). Persistence
is **PostgreSQL with a schema per service** (TypeORM, single DB instance).

```
client ──HTTP──> api-gateway ──RabbitMQ──> { identity, order, catalog, logistics,
                                             finance, notification, integration,
                                             analytics, branch, investor, file,
                                             c2c, search } ──> PostgreSQL (schema/service)
```

| Service | Responsibility |
|---|---|
| **api-gateway** | HTTP surface, auth (JWT default-deny + `@Public`), RBAC, Swagger, rate limiting, realtime (WS) |
| **identity** | users, auth (JWT access/refresh), customers, RBAC roles |
| **order** | order lifecycle + state machine, COD money split, per-order FIFO settlement, transfer batches, analytics reads |
| **finance** | cashboxes, ledger, settlement legs, operator/investor payments, shifts |
| **logistics** | couriers, posts, assignment |
| **branch** | branches, branch users, config, transfer-batch orchestration |
| **catalog** | products / pricing |
| **integration** | marketplace **Partner API**, provider integrations, webhooks (HMAC) |
| **notification** | in-app inbox, realtime + Telegram dispatch |
| **analytics** | dashboards / KPI aggregation |
| **investor** | investor profit shares |
| **file** | MinIO/S3 uploads, signed URLs, QR/PDF generation |
| **search** | pg_trgm full-text search |
| **c2c** | customer-to-customer marketplace (stubbed) |

Shared code (config/Joi, RMQ helpers, outbox, idempotency, logging, Sentry,
filters, entities base) lives in `libs/common`.

### Key mechanisms

- **`executeAndAck`** — uniform RMQ ack/nack with a smart DLQ (RpcException →
  DLQ, transient → requeue-once → DLQ).
- **Transactional outbox** (`libs/common/src/outbox`) — state-change events are
  written in the same DB transaction as the change and published at-least-once,
  with poison-event alerting.
- **Idempotency** (`libs/common/src/idempotency`) — money mutations dedupe on a
  server-derived token / partial-unique cashbox-history index.
- **Joi config validation** (`libs/common/src/config`) — fail-fast on weak/missing
  secrets at boot.
- **Trace correlation** — `trace_id` flows gateway → RMQ → Pino logs → Sentry.

## Local development

Native (no Docker) is the common dev setup; infra (Postgres + RabbitMQ + MinIO)
can run via Docker.

```bash
npm install
cp .env.example .env          # fill in real values (see .env.example comments)

npm run infra:up              # start rabbitmq + postgres (docker)
npm run migration:run         # apply DB migrations
npm run start:all             # start gateway + all services (watch mode)
# or a single service: npm run start:gateway | start:order | start:finance | ...
```

Swagger UI (when enabled): `http://localhost:<gateway-port>/api`.

## Testing

```bash
npm test                 # full unit suite (jest)
npm run test:ci          # CI mode (runInBand)
npm run test:cov         # with coverage
```

CI (`.github/workflows/ci.yml`) runs lint, per-service typecheck, a
secret-scan (gitleaks), and the **full test suite as a blocking gate**, plus a
build smoke. Deploy (`.github/workflows/deploy.yml`) re-runs the suite, takes a
**pre-migration DB backup**, runs migrations, deploys changed services, and
**rolls back** on failure.

## Database & migrations

```bash
npm run migration:generate    # generate from entity changes
npm run migration:run         # apply
npm run migration:run:safe    # backup THEN run (pre-migration safety dump)
npm run db:reconcile          # cashbox money-conservation invariant check
```

Migrations live in `migrations/` and run against `order_schema`'s datasource
(cross-schema DDL is fully qualified). Backups: `scripts/backup-db.sh` (+ the
`db-backup` compose sidecar).

## Deployment

`docker-compose.prod.yml` runs the full stack (services + Postgres + RabbitMQ +
MinIO + Cloudflare Tunnel + `db-backup`/`db-reconcile` sidecars) behind a
Cloudflare Tunnel. Deploy is driven by `.github/workflows/deploy.yml`.

> ⚠️ **Secrets:** never commit real secrets. `.env`/`.env.production` are
> git-ignored and CI runs a gitleaks scan. See
> `docs/audit/SECRET_ROTATION_RUNBOOK.md`.

### AI (ai-service) — majburiy deploy tartibi (LP3RKvXY)

`deploy.yml` `.env.production` ni repodan OLMAYDI va faqat fayl YO'Q bo'lsa
zaxiradan tiklaydi — eski fayl jim qoladi; rollback kodni qaytaradi, `.env` ni
emas. Shuning uchun tartib QAT'IY:

1. SSH → serverdagi `.env.production` ga AI kalitlari QO'LDA qo'shiladi:
   `ANTHROPIC_API_KEY=sk-ant-…` (faqat shu yerda), `AI_ORDER_MODEL`,
   `AI_ORDER_VISION_MODEL`, `AI_CLASSIFY_MODEL`, `AI_DAILY_USD_CAP`, … (ro'yxat —
   `.env.example` "AI Order" bo'limi). `AI_ORDER_ENABLED=false` bilan boshlang.
2. Repodagi `.env.example` ga faqat bo'sh qiymat yoki `__REPLACE_WITH_…__`
   placeholder yoziladi (gitleaks allowlist). Kalit HECH QACHON
   `docker-compose.prod.yml` `environment:` blokiga literal yozilmaydi
   (`apps/ai-service/src/models/deploy-secrets.guard.spec.ts`).
3. Shundan KEYIN `main` ga merge/push. Teskari tartibda kod chiqadi-yu AI jim
   o'chiq qoladi (`/ai/status` → `key_state: 'missing'`).
4. Deploydan keyin `GET /ai/status`: `key_state: 'ok'` va
   `model_policy.ok: true` (ekstraksiya modeli Haiku'ga pasaytirilmagan). E2E
   o'tgach `AI_ORDER_ENABLED=true` → faqat `api-gateway` qayta yaratiladi.

⚠️ `libs/` yoki `docker-compose.prod.yml` o'zgarsa `deploy.yml` `DEPLOY_ALL=true`
va `RUN_MIGRATIONS=true` qiladi (14 servis qayta quriladi) — ClaudeService
`libs/common/src/ai` da, ya'ni AI'dagi kichik o'zgarish ham to'liq deploy.
Buni ish vaqtidan tashqari qiling.

## Documentation

- `docs/BACKEND_MAP.md` — authoritative service/endpoint/entity map (read this
  first for whole-project work).
- `docs/PARTNER_API.md` — external marketplace Partner API.
- `docs/frontend/` — OpenAPI spec + frontend integration guide + coverage report.
- `docs/audit/` — production-readiness / lifecycle / money audits + runbooks.
- `docs/BRANCH_SYSTEM_PLAN.md`, `docs/comparison/` — branch-system TZ & PCS↔Elchi
  functional comparison.

## License

UNLICENSED — private.
