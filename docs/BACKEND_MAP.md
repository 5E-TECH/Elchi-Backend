# Elchi Backend — Project Map (single source of truth)

> **Purpose.** This document lets an AI agent (or a new engineer) understand the
> **entire backend** without scanning all 14 services. When asked to "analyze the
> whole project", **read this file first** and only open specific source files
> when this map points you there or is insufficient for the task.
>
> **Maintenance rule (keep this fresh).** Whenever you add/remove a service,
> entity/table, message pattern, gateway route, enum, env var, or change a core
> flow (order lifecycle, settlement/money model, cashbox invariant, branch
> transfer), **update this file in the same change**. The code is the detail;
> this map is the index. Companion docs:
> [`docs/frontend/`](./frontend/) (API contract + frontend coverage audit),
> [`AI_INTEGRATION_ROADMAP.md`](./AI_INTEGRATION_ROADMAP.md) (future AI/`ai-service` plan — not yet started).

Last structural sync: **2026-06-06**.

---

## 1. System architecture in one screen

- **NestJS monorepo** (`nest-cli.json`): **14 microservices + 1 API Gateway + 1
  shared library** (`libs/common`). Each service is a separate Nest app under
  `apps/<svc>/`; build/run scripts per service in `package.json`.
- **Transport:** RabbitMQ via `@nestjs/microservices`. Communication is
  predominantly **synchronous request/response RPC** (`client.send({cmd}, payload)`
  → `@MessagePattern({cmd})`). A few flows are **event/fire-and-forget**
  (`client.emit` / `@EventPattern`): realtime push, some webhook/notify paths.
  **No general pub/sub event bus.**
- **Database:** a single **PostgreSQL** instance, **schema-per-service** (TypeORM).
  Each service owns its schema (`DB_SCHEMA` env, defaults like `order_schema`).
  Services **never** touch another service's tables — they call its message
  patterns instead.
- **Object storage:** MinIO (S3-compatible) for files, used by `file-service`.
- **Edge:** the gateway sits behind a **Cloudflare Tunnel**; `api.elchipochta.uz`.
- **The frontend only talks to the API Gateway** (HTTP REST). Everything else is
  internal RMQ. See [`docs/frontend/FRONTEND_INTEGRATION_GUIDE.md`](./frontend/FRONTEND_INTEGRATION_GUIDE.md).

```
Browser/Mobile ──HTTP──> API Gateway ──RMQ(cmd)──> [identity, order, catalog,
   ▲  socket.io /realtime    │                       logistics, finance, branch,
   └────────────────────────┘                       investor, integration,
                                                     notification, analytics,
                                                     file, c2c, search]
                                                          │
                                            Postgres (schema/service) · MinIO · Telegram · providers
```

---

## 2. Service catalog

| Service | DB schema | Owns (entities/tables) | Responsibility |
|---|---|---|---|
| **api-gateway** | — (no DB) | — | HTTP→RMQ proxy, auth guards, RBAC, throttling, Swagger, socket.io, webhooks, excel/printer |
| **identity-service** | `identity_schema` | `user` | Users of every role, auth (login/refresh/logout/validate), profiles, markets (+telegram token), couriers/managers/registrators/admins/customers |
| **order-service** | `order_schema` | `order`, `order_item`, `order_tracking`, `order_settlement`, `order_custody_event`, `branch` (mirror), `branch_transfer_batch(+item,+history)`, `order_batch_inbox_message` | The core. Order lifecycle, sell/cancel/return/rollback, per-order FIFO settlement, transfer batches, order analytics source |
| **catalog-service** | `catalog_schema` | `product` | Market product catalog |
| **logistics-service** | `logistics_schema` | `region`, `district`, `post` | Geo (regions/districts, SATO codes) + **posts** (courier delivery batches): create/send/receive/reassign/cancel/return-requests |
| **finance-service** | `finance_schema` | `cashbox`, `cashbox_history`, `shift`, `user_salary`, `operator_earning`, `operator_payment`, `financial_balance_history` | Cashboxes (main/courier/market/branch), payments, shifts, salaries, operator earnings, company P&L ledger |
| **branch-service** | `branch_schema` | `branch`, `branch_config`, `branch_user` | Branch tree (HQ→regional→pickup), per-branch config (ownership/compensation), branch staff, transfer-batch orchestration, branch analytics/dashboard |
| **investor-service** | `investor_schema` | `investor`, `investment`, `profit_share` | Investor capital, investments, profit-share calculation/payout |
| **integration-service** | `integration_schema` | `external_integration`, `provider_shipment`, `provider_receivable`, `provider_remittance`, `sync_queue`, `sync_history`, `provider_webhook_log` | External providers (cargo/marketplace): credentials (AES-encrypted), sync queue, dispatch shipments, COD receivables/remittances, inbound HMAC webhooks |
| **notification-service** | `notification_schema` | `telegram_market`, `notification` | Per-user in-app notification inbox (dispatch/list/read/unread) + realtime socket.io push + Telegram group notifications (configs, connect-by-token, send) |
| **analytics-service** | — (no DB; aggregator) | — | Dashboards, KPI, revenue, reports — **reads other services** (order/finance/branch/identity) via RMQ; stores nothing |
| **file-service** | — (MinIO, no DB) | — | Upload/download (signed URLs), PDF & QR generation in MinIO |
| **c2c-service** | `c2c_schema` | `listing`, `c2c_order`, `review`, `dispute` | Consumer-to-consumer marketplace (listings/orders/reviews/disputes). **Not yet exposed via gateway** — no c2c gateway controller |
| **search-service** | `search_schema` | `search_document` | Global search index (upsert/remove/query); other services push index updates |

> Message-pattern naming convention: `{service}.{resource}.{action}` (e.g.
> `order.sell`, `finance.cashbox.payment_courier`, `branch.transfer_batches.create`).
> Health checks: `{service}.health`. A pattern listed under a service that is
> NOT its own prefix means that service **calls** another (cross-service RPC).

---

## 3. Per-service detail

### identity-service (`identity_schema`)
- **Entity:** `user` (all roles in one table; `Roles` enum, `Status`).
- **Auth:** `identity.login` / `identity.refresh` / `identity.logout` /
  `identity.validate` / `identity.user.profile`. Issues access+refresh JWT
  (gateway sets refresh as httpOnly cookie).
- **Per-role create/list:** `identity.{courier,manager,registrator,market,customer}.*`,
  generic `identity.user.{create,find_all,find_by_id,update,delete,status}`.
- **Market specifics:** telegram token (`market.find_by_tg_token`, `rotate_tg_token`),
  `expense_proof_conditions`. Creating a user also creates its cashbox
  (`finance.cashbox.create`) and may assign to a branch (`branch.user.assign`),
  and indexes to search.

### order-service (`order_schema`) — the core
- **Entities:** `order` (key cols incl. `status` (`Order_status`), `total_price`;
  money cols `total_price`/`market_tariff`/`courier_tariff`/`courier_share`/`branch_share`
  are `numeric(14,2)` — audit 2026-06-07, was float),
  `order_item`, `order_tracking` (history timeline), `order_settlement` (per-order
  FIFO chain state, `SettlementStatus`), `order_custody_event`, a local `branch`
  mirror, `branch_transfer_batch` + `_item` + `_history`, `order_batch_inbox_message`.
- **Lifecycle patterns:** `order.create`, `order.receive`, `order.external.create`/
  `receive_external`, `order.sell`, `order.partly_sell`, `order.cancel`,
  `order.could_not_deliver`, `order.initiate_return`, `order.mark_returned_to_market`,
  `order.rollback_waiting`, `order.update`/`update_full`/`update_normalized`,
  `order.delete`. Reads: `find_all(_enriched)`, `find_by_id(_enriched)`,
  `find_by_qr(_enriched)`, `find_new_by_market`, `find_new_markets`, `tracking`,
  `custody_history`, `print.find`.
- **Settlement:** `order.settlement.courier_to_branch` / `branch_to_hq` /
  `hq_to_market` / `find_by_order`. (See §5.2.)
- **Transfer batches (also mirrored in branch-service):**
  `order.transfer_batch.{create,create_return,send,receive,receive_orders,cancel,cancel_many,find_*,history.add}`,
  `order.bulk_assign_batch`, `order.bulk_remove_from_batch`.
- **Analytics source:** `order.analytics.*` (overview, revenue, courier/market
  stats, top couriers/markets/operators) — consumed by analytics-service.
- **Heavy cross-service caller:** branch, finance, identity, catalog, logistics,
  integration, file. This is where most money/state orchestration lives.

### logistics-service (`logistics_schema`)
- **Entities:** `region`, `district` (with SATO codes), `post`.
- **Posts (courier delivery batches, `Post_status`):** create/send (`post.update`),
  receive (`post.receive`, `receive_order`, `receive_orders`, `receive_scan`),
  reassign, cancel (`post.cancel.create`, `cancel.receive`), check/check_cancel,
  courier-scoped lists (`new`, `on_the_road`, `my_for_courier`, `old_for_courier`,
  `rejected*`), return-requests (`list`/`approve`/`reject`).
- **Order assignment:** `logistics.order.assign_to_courier`, `scan_assign`.
- **Geo:** regions/districts CRUD, SATO match preview/apply, region stats.

### finance-service (`finance_schema`)
- **Entities:** `cashbox` (`Cashbox_type`: main/couriers/markets/branch),
  `cashbox_history` (per-cashbox movements, `Source_type`), `shift`,
  `user_salary`, `operator_earning`, `operator_payment`,
  `financial_balance_history` (company P&L ledger, `FinancialSource_type`).
- **Patterns:** cashbox create/find/main/my/all_info/user_by_id, `update_balance`,
  `fill`, `spend`, payments (`payment_courier`, `payment_market`,
  `payment_branch_main`), `financial_balance.{record,history}`, history list,
  shifts (`open`/`close`/`find_all`), salary CRUD, operator earnings/payments/balance.
- **Invariant:** the cashbox system enforces a money invariant (checked by
  `scripts/check-cashbox-invariant.ts`, `npm run db:check-cashbox`).

### branch-service (`branch_schema`)
- **Entities:** `branch` (`BranchType`, `BranchOwnership`), `branch_config`
  (key/value: ownership, courier compensation, per-order share), `branch_user`
  (`BranchUserRole`).
- **Patterns:** tree/descendants/find_hq/find_by_code, CRUD, config CRUD, user
  assign/remove/find, dashboard, market analytics, new-orders branches,
  transfer-batch orchestration (`branch.transfer_batches.*`, `post.dispatch`,
  `return_batches.create`) which delegates to order-service `order.transfer_batch.*`.

### integration-service (`integration_schema`)
- **Entities:** `external_integration` (provider config, **AES-encrypted creds**
  via `INTEGRATION_CREDENTIAL_SECRET`), `provider_shipment`, `provider_receivable`,
  `provider_remittance`, `sync_queue`, `sync_history`, `provider_webhook_log`.
- **Patterns:** CRUD, healthcheck, `external.request`/`search_by_qr`,
  shipment dispatch/get/list/upsert, sync enqueue/process/queue/retry/trigger/
  history, receivable list/balance, remittance create, `webhook.receive` (HMAC
  verified here — see §5.5). SSRF guard on outbound URLs (`libs/common/src/security`).

### investor-service (`investor_schema`)
- **Entities:** `investor`, `investment`, `profit_share`.
- **Patterns:** investor CRUD, investment CRUD + find_by_investor, profit
  create/calculate/find/mark_paid. Read-only-ish portfolio domain.

### notification-service (`notification_schema`)
- **Entities:** `telegram_market`, `notification` (per-recipient inbox row —
  one row per recipient so read-state is per-user; `recipient_id`, `type`
  `{domain}.{event}`, `category`/`priority` enums, `title`/`body`/`data`/`link`,
  `channels`/`delivery` jsonb, `group_key` for dedupe, `is_read`/`read_at`).
- **Inbox engine (`NotificationInboxService`):** generic dispatch + inbox read API.
  - `notification.dispatch` — resolve recipients (`recipient_id` / `recipient_ids` /
    `roles[]` via `identity.user.find_all` paging / `broadcast`) → persist one row
    each (dedupe by `group_key`) → realtime push → optional telegram relay →
    email/sms stubbed. Returns `{dispatched, recipient_ids, channels, telegram}`.
  - `notification.inbox.{list,find_one,unread_count,mark_read,mark_all_read,delete}`
    — all scoped to the caller's `recipient_id` (set by the gateway from the JWT).
  - **Realtime:** first emitter of `{cmd:'realtime.notify'}` to the `GATEWAY` queue
    (socket.io `notification:new` to room `user:<sub>`); best-effort — when
    `RABBITMQ_GATEWAY_QUEUE` is unset the row still persists, push is skipped.
  - Default channels when omitted: `[in_app, realtime]`. The DB row is the system
    of record regardless of channel outcome. `role`/`broadcast` targeting can't
    reach superadmin/customer (excluded by `identity.user.find_all`) — use
    explicit `recipient_id` for those.
- **Telegram patterns (unchanged):** config CRUD, `connect_by_token`, `send`. Also
  runs the **order-create telegram bot** + group alert bot (tokens in env).
- **Gateway routes:** `GET/PATCH/DELETE /notifications/inbox*` (any authed user,
  own inbox), `POST /notifications/dispatch` (`@Roles(superadmin, admin)`).

### catalog-service (`catalog_schema`)
- **Entity:** `product`. CRUD + `update_own` (market), `delete_by_market`,
  `find_by_ids`. Pushes search index updates; resolves market via identity.

### analytics-service (no DB)
- Pure aggregator. `analytics.{dashboard,kpi,revenue,report.orders,report.couriers,
  report.finance}` — fans out to order/finance/branch/identity patterns and
  composes role-aware results.

### file-service (MinIO, no DB)
- `file.{upload,get_url,delete,exists,generate_pdf,generate_qr}`. Signed URLs;
  size/TTL from env.

### search-service (`search_schema`)
- `search_document` index. `search.{index.upsert,index.remove,query}`. Other
  services emit upsert/remove on writes; gateway exposes `GET /search`.

### c2c-service (`c2c_schema`) — internal only
- `listing`, `c2c_order`, `review`, `dispute` with full pattern set, but **no
  gateway controller yet** → not reachable from the frontend. (Registered in
  gateway RmqModule as `C2C` client for future wiring.)

---

## 4. Shared library `libs/common`

Imported as `@app/common`. Top level: `enums/`, `helpers/`, `src/`.

- **`enums/index.ts`** — ALL domain enums (Roles, Order_status, SettlementStatus,
  BranchType/Ownership, CourierCompensationMode, PaymentMethod, Cashbox_type,
  Source_type, FinancialSource_type, ExpenseProofCondition, Post_status,
  BranchTransfer*, Notification{Channel,Priority,Category,DeliveryStatus}).
  Single source of truth for state machines.
- **`helpers/response`** — `successRes`/`errorRes`/`catchError` (the
  `{statusCode,message,data}` envelope). `helpers/bcrypt` — hashing.
- **`src/config`** — all Joi validation schemas (`gatewayValidationSchema`,
  `identityValidationSchema`, …). One per service. The contract for env vars.
- **`src/rmq`** — `RmqModule.register({name})` (client factory),
  `rmq-client.helper.ts` (`rmqSend` with trace propagation),
  `execute-and-ack.helper.ts` (`executeAndAck`: the standard controller wrapper
  that runs the handler and **acks/nacks** the RMQ message; default nack
  `requeue=false` → a thrown error drops the message, risk of message loss).
- **`src/database`** — `DatabaseModule` with per-service `DB_SCHEMA` support.
- **`src/context`** — async trace context; server-side counterpart of the gateway
  `x-request-id` middleware. Propagates `trace_id` through RMQ payloads → pino logs.
- **`src/logger`** — pino (`nestjs-pino`) structured logging (`AppLoggerModule`).
- **`src/filters`** — `AllExceptionsFilter`, `RpcExceptionFilter` (uniform errors).
- **`src/sentry`** — `initSentry`/`flushSentry` (no-op without `SENTRY_DSN`).
- **`src/activity-log`** — pluggable audit-log entity+service; every row stores
  `serviceName` + acting user (denormalized) for a centralized audit dashboard.
- **`src/idempotency`** — `idempotent-execute.helper.ts`: dedupe repeated
  operations (e.g. order money ops) by idempotency key. `in_progress` reservations
  carry a **lease** (`DEFAULT_IDEMPOTENCY_LEASE_MS`=30s): a key abandoned by a
  crashed worker is atomically reclaimed by the next caller so a `request_id` is
  never permanently stuck. (Audit 2026-06-06.)
- **`src/outbox`** — transactional outbox pattern support (reliable RMQ emit).
- **`src/soft-delete`** — soft-delete base (deleted rows kept for audit).
- **`src/security`** — SSRF guard for outbound URLs from operator-supplied
  integration config (`INTEGRATION_ALLOW_PRIVATE_HOSTS` toggles private hosts).
- **`src/webhook`** — HMAC signature helpers for inbound provider webhooks.

---

## 5. Core domain flows (the business logic that matters)

### 5.1 Order lifecycle
`Order_status`: `created · new · received · on the road · waiting ·
waiting_customer · sold · cancelled · returned_to_market · paid · partly_paid ·
cancelled (sent) · closed`. Happy path: `new → received → on the road → sold`.
Created by market / registrator / market_operator (`order.receive`) / telegram
bot / external provider feed. Routed through branches via **transfer batches**
and assigned to couriers (`logistics.order.assign_to_courier`,
`order.scan_assign`). Courier records outcome: `sell` / `partly_sell` / `cancel`
/ `could_not_deliver`. Return: `initiate_return` → `mark_returned_to_market`.
`rollback_waiting` reverses sold/cancelled (settlement-aware). Full history in
`order_tracking`; custody in `order_custody_event`.

### 5.2 COD settlement & money model (config-driven, FIFO per order)
Cash collected on delivery flows **courier → branch → HQ → market**, reconciled
**per order, oldest-first**, as lump-sum payments are recorded:
`order.settlement.courier_to_branch` → `branch_to_hq` → `hq_to_market`. Each
order has an `order_settlement` row advancing through `SettlementStatus`
(`pending → courier_settled → branch_settled → market_settled`).
Who keeps what:
- **Courier share** ← `CourierCompensationMode` (`salary_only`=keep 0 owe all;
  `per_order`=keep tariff; `salary_plus_per_order`).
- **Branch share** ← `BranchOwnership` (`owned`=remit all, HQ pays staff;
  `partner`=keep `per_order_share`).
Finance mirrors this in cashboxes (`payment_courier`/`payment_market`/
`payment_branch_main`) and the company P&L ledger (`financial_balance_history`,
`FinancialSource_type.sell_profit` = market tariff − courier tariff).
**Details:** memory `settlement_compensation_initiative.md`, `order_flow_money_fixes.md`.

### 5.3 Branch transfer batches
Orders move between branches in QR-coded batches (forward + return),
`BranchTransferBatchStatus` (`PENDING→SENT→RECEIVED/CANCELLED`). Orchestrated by
branch-service, persisted by order-service (`branch_transfer_batch*`). Lifecycle:
create from a branch by `order_ids` → `send` (vehicle info) → `receive` /
`receive_orders` (partial) → `cancel`; `return_batches.create` groups by origin;
`post.dispatch` pushes an HQ post to a destination branch.

### 5.4 Cashbox invariant
The sum of cashbox balances must reconcile with recorded movements. Enforced in
finance-service and auditable via `npm run db:check-cashbox`. The frontend never
edits balances directly except via `fill`/`spend`/`update_balance`.

### 5.5 Provider integration & inbound webhooks
Operators register providers (`external_integration`, AES-encrypted creds).
Outbound: dispatch shipments, universal `request`/`search_by_qr` (SSRF-guarded).
Sync queue processes provider order feeds. COD `provider_receivable` accrues;
`remittance.create` settles it. Inbound `POST /webhooks/{slug}` is
**unauthenticated at JWT layer** — the gateway captures **raw bytes** and forwards
to `integration.webhook.receive`, which verifies the **HMAC** with the per-provider
secret (secret never reaches the gateway).
**Details:** memory `pcs_parity_initiative.md`.

---

## 6. Cross-cutting conventions (apply everywhere)

- **Response envelope:** `{ statusCode, message, data }` via `successRes`.
- **RMQ handler pattern:** controllers wrap logic in `executeAndAck`. Errors →
  nack `requeue=false` (message dropped) — be careful adding new patterns.
- **Auth/RBAC:** JWT (`ACCESS_TOKEN_KEY`); gateway guards `JwtAuthGuard` +
  `RolesGuard` (`@Roles(...)`) + `SelfGuard`. JWT payload: `{sub, username,
  roles[], branch_id?}`. Roles are lowercase. Full role→route matrix in the
  frontend guide §11.
- **Tracing:** `x-request-id` minted/echoed at gateway → `requestContext` →
  `trace_id` in every RMQ payload → pino logs. Use for end-to-end correlation.
- **Rate limiting:** `ThrottlerModule` global (~60/min/IP); auth endpoints stricter.
- **Idempotency / outbox / activity-log / soft-delete:** available in
  `libs/common` — use for money ops and audit-sensitive writes.
- **Validation:** gateway `ValidationPipe` is `whitelist + forbidNonWhitelisted`
  → unknown body fields are rejected (400).

---

## 7. Infra, config & ops

- **docker-compose.prod.yml** services: `rabbitmq`, `postgres`, `minio`,
  `migration-runner`, `api-gateway`, `cloudflared`, + all 13 other services.
  Volumes: `rabbitmq_data`, `postgres_data`, `minio_data`.
- **Schemas:** `scripts/init-schemas.sql` auto-creates every `*_schema` on
  Postgres start. Per-service `DB_SCHEMA` env (defaults in `libs/common/src/config`).
- **Migrations:** TypeORM (`typeorm.config.ts`, `migrations/`,
  `npm run migration:*`). `npm run db:prepare`.
- **Env:** `.env.example` is the template; `.env.production` is server-managed.
  Every var is validated by a Joi schema in `libs/common/src/config/index.ts`.
- **Deploy:** Cloudflare Tunnel → `api.elchipochta.uz`. Details in memory
  `deployment_domain_setup.md`.
- **Useful scripts:** `npm run start:all` (dev, all services), `build:all`,
  `openapi:generate`, `audit:frontend`, `db:check-cashbox`, `db:sync:sato`.

---

## 8. Concept → file index (where to look)

| Need | Path |
|---|---|
| Public HTTP routes | `apps/api-gateway/src/*-gateway.controller.ts` |
| Auth guards / JWT | `apps/api-gateway/src/auth/`, `apps/identity-service` |
| Realtime (socket.io) | `apps/api-gateway/src/realtime/` |
| Inbound webhooks | `apps/api-gateway/src/webhook-gateway.controller.ts` + `integration-service` |
| All enums / state machines | `libs/common/enums/index.ts` |
| Env contracts (Joi) | `libs/common/src/config/index.ts` |
| RMQ client / ack helper | `libs/common/src/rmq/` |
| Order logic & settlement | `apps/order-service/src/` |
| Money / cashboxes / ledger | `apps/finance-service/src/` |
| Branch tree / transfers | `apps/branch-service/src/` + order-service batch entities |
| Provider sync / webhooks | `apps/integration-service/src/` |
| Frontend contract | `docs/frontend/openapi.json` + guides |
| Existing planning docs | `docs/BRANCH_*.md` |

---

## 9. Open / notable state (as of last sync)

- **c2c-service** is fully built internally but **not exposed via the gateway**.
- **analytics-service** and **file-service** have **no database** (aggregator /
  MinIO respectively).
- Frontend has significant **coverage gaps** vs backend — see
  [`docs/frontend/COVERAGE_REPORT.md`](./frontend/COVERAGE_REPORT.md)
  (Investor, Integration-sync, Finance shift/salary/operator, Files, Excel,
  branch-config, analytics-reports not yet wired; several stale paths).
- Active initiatives tracked in memory: settlement/compensation, branch system,
  PCS parity, order-flow money fixes, audit findings.
```
