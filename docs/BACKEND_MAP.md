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

Last structural sync: **2026-10-01** (fix3 launch-day audit remediation — the
"fix3 (2026-10-01)" notes below; journal: [`audit/AUDIT_LOG.md`](./audit/AUDIT_LOG.md)).

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
- **fix3 (2026-10-01):** `market_tg_token` (format `group_token-<32 hex>`) is
  returned only by `identity.user.find_by_id` with `include_tg_token` (the
  gateway sets it for SUPERADMIN/ADMIN only) and only on market rows — the
  admin hands it to the market for the Telegram group bind. `rotate_tg_token`
  now has **no caller** (a group bind no longer rotates). Refresh: a validly
  signed but superseded token (newer login on another device) → 401 **without**
  nulling the stored hash, so the latest login keeps its session (one session
  per account); a password or login-phone change revokes the refresh token.
  Admins may edit their own name/phone/password (`PATCH /auth/my-profile`).
  Deleting a manager/registrator also removes the active `branch_users` row
  (`branch.user.remove`, best-effort, warn log). User-create saga: a failed
  branch assign / cashbox create compensates (unassign + soft-delete) instead
  of leaving an orphan user.

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
  `order.update_from_api`, `order.delete`. Reads: `find_all(_enriched)`, `find_by_id(_enriched)`,
  `find_by_qr(_enriched)`, `find_new_by_market`, `find_new_markets`, `tracking`,
  `custody_history`, `print.find`.
  - **fix3 (2026-10-01):** `order.update_from_api` `{id, dto, requester}` is the
    **only** target of the gateway's HTTP `PATCH /orders/:id` and `/:id/full`
    → `updateFromApi` (API field/role/branch rules, §5.1; a call without a
    requester → 403). `order.update` / `update_full` / `update_normalized`
    stay plain `updateFull` — trusted internal writes (branch dispatch,
    logistics post/return flows, finance's requester-less PAID/PARTLY_PAID
    sync); never put API rules there. `order.external.create` now receives and
    uses `requester`; `order.create` accepts `paid_online_amount` (partner
    prepaid, §5.2). `order.find_by_id(_enriched)` returns the **raw** order row
    (no `{data}` wrapper) — gateway scope checks unwrap it.
- **Settlement:** `order.settlement.courier_to_branch` / `branch_to_hq` /
  `hq_to_market` (legacy lump-sum paths — answer 410 since Faza 2b; cash moves
  only via the finance payment endpoints) / `find_by_order`;
  `order.settlement.advance` (per-order FIFO advance enqueued by finance's
  outbox). (See §5.2.)
  - **fix3 (2026-10-01):** `order.settlement.advance` runs with
    `reclaimFailed: true` and writes an "applied" marker
    (`order.settlement.advance.applied:<sha256(token)>` in `idempotency_keys`)
    inside the FIFO transaction, so a retried/reclaimed message never applies
    a payment twice (M8). New `order.settlement.close_zero_courier_rows`
    `{courier_id, requester}` (C8): closes a courier's PENDING
    `courier_to_branch` rows only when their sum is exactly 0 tiyin **and** the
    carry is 0 — one transaction under the carry lock, all-or-nothing; reply
    `{courier_id, closed_count, closed_order_ids, skipped_reason}`; no money
    moves. branch-service calls it best-effort before a courier transfer /
    branch removal.
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
- **fix3 (2026-10-01):**
  - **Disabled for launch (CODE-12):** `logistics.post.create`,
    `logistics.post.update` (sendPost) and `logistics.post.reassign` reply
    RpcException **410** without calling the service (methods kept, re-enable =
    restore the handlers); the gateway's `PATCH /post/:id` and
    `PATCH /post/reassign/:id` throw 410 and send no RPC. Posts reach a branch
    via `POST /branches/posts/:postId/dispatch`, a courier via
    `POST /orders/assign-to-courier` or a scan.
  - `post.receive` keeps the post SENT while any ON_THE_ROAD order remains and
    adds top-level `failures` / `not_received_order_ids` (LC-11); `post.new`
    adopts only orphan RECEIVED orders in **HQ custody** (LC-03); a partial HQ
    receipt of a cancelled post sends unreceived parcels back to the real
    sender (LC-06); scanner receives write `return_requested:false` (CODE-09);
    `assign_to_courier` refuses NEW external orders and inactive/deleted
    couriers (CODE-11); return-request approve/reject update orders in chunks
    of 5 (CODE-10); `district.update` takes the requester and is SA/ADMIN only
    (LC-08).
  - Courier scan of an order in a branch transfer batch
    (`order.transfer_batch.receive_one_by_scan`): downstream 4xx keep their
    status (CODE-13); a **transit** reply (`reason:'transit'`) → clear 400
    ("boshqa hudud uchun (tranzit) … kuryerga berilmaydi") instead of
    "Boshqa filial orderi" — the order is not assigned (§5.3).

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
- **fix3 (2026-10-01):** `payment_market` replies right after commit (+ the 2 s
  bounded ledger publish); the per-order PAID/PARTLY_PAID sync and the partner
  webhook run in the background (serialized per market, in-process, drained
  ≤5 s on shutdown — a crash mid-sync drops them, display-only). The sync
  pages SOLD/PARTLY_PAID orders oldest-first (100/page, ≤50 pages; remaining =
  `to_be_paid − extra_cost − paid_amount`). `payment_courier` with
  `click_to_market` and a BRANCH receiver → 400; on the HQ path the amount must
  not exceed the market payable (400) and a second `hq_to_market` advance is
  enqueued (token `<token>:m`). A BRANCH cashbox may go negative only for system
  legs — a manager's manual `spend` is strict like MAIN (400). `all_info` adds
  `marketPayableTotal` (sum of positive market balances). Financial-balance
  history/analytics/top-impacts and the cashbox history date filters use
  Tashkent days for `YYYY-MM-DD`.

### branch-service (`branch_schema`)
- **Entities:** `branch` (`BranchType`, `BranchOwnership`), `branch_config`
  (key/value: ownership, courier compensation, per-order share), `branch_user`
  (`BranchUserRole`).
- **Patterns:** tree/descendants/find_hq/find_by_code, CRUD, config CRUD, user
  assign/remove/find, dashboard, market analytics, new-orders branches,
  transfer-batch orchestration (`branch.transfer_batches.*`, `post.dispatch`,
  `return_batches.create`) which delegates to order-service `order.transfer_batch.*`.
- **fix3 (2026-10-01):** no new patterns. `branch.cashbox.resolve_for_manager`
  and manager→courier access use **only the manager's own branch** (no
  ancestor walk — HQ/parent couriers are out of scope; C3/M7). `post.dispatch`
  rules are in §5.3. `extractRpcError` keeps downstream 4xx (no more 500) and
  error texts are Uzbek (CODE-13). `branch.dashboard` data carries
  `stats_unavailable: true` when the order-service stats call fails (zeros kept
  for shape; CODE-23). `branch.update` → 409 when couriers are attached and the
  branch would become PICKUP / inactive / move region, or when open
  orders/batches exist (`order.branch_can_delete`) and it would become PICKUP /
  inactive (CODE-20). Courier transfer and `branch.user.remove` first call
  `order.settlement.close_zero_courier_rows` best-effort when the courier's
  holdings are exactly 0, then re-check (the 409 stays if anything remains).
  Dispatch destinations count only **active** managers (identity check, 503
  fail-closed; CODE-07).

### integration-service (`integration_schema`)
- **Entities:** `external_integration` (provider config, **AES-encrypted creds**
  via `INTEGRATION_CREDENTIAL_SECRET`), `provider_shipment`, `provider_receivable`,
  `provider_remittance`, `sync_queue`, `sync_history`, `provider_webhook_log`.
- **Patterns:** CRUD, healthcheck, `external.request`/`search_by_qr`,
  shipment dispatch/get/list/upsert, sync enqueue/process/queue/retry/trigger/
  history, receivable list/balance, remittance create, `webhook.receive` (HMAC
  verified here — see §5.5). SSRF guard on outbound URLs (`libs/common/src/security`).
- **fix3 (2026-10-01):** new `LOGISTICS` RMQ client. `createPartnerShipment`
  takes a numeric `region_id` as given, otherwise derives it from the district
  (`logistics.district.find_by_id`: assigned region first); district missing or
  without a region → 400, logistics transport/5xx → 503 (partner retries). It
  passes `paid_online_amount = subtotal − cod_amount` to `order.create`, which
  now persists it (§5.2).

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
- **fix3 (2026-10-01) — Telegram group binding (CODE-02):** the bot text and
  REST `connect_by_token` share one parser. A bind needs the market's
  **current secret** `market_tg_token` (`group_token-<32 hex>`, optional
  `-create`/`-cancel` suffix = group type), resolved via
  `identity.market.find_by_tg_token`; the old `group_token-<marketId>` form and
  the saved-token fallback are rejected. The token is **not rotated** after a
  bind (it stays the order-bot credential) and is not stored in
  `telegram_market.token` (sends use the env bot). An existing (market, group
  type) binding — active or inactive, not deleted — is **never overwritten** by
  the bot/token ("Bu market uchun bu turdagi guruh allaqachon ulangan — admin
  orqali o'zgartiring"); re-binding goes only through admin
  `PATCH/DELETE /notifications/:id`. The notification bot answers `/id` /
  `/id@<bot>` with `Group ID: <chat.id>`; bot texts are Uzbek and unexpected
  errors are not echoed into the group. Order bot `/status`: only for the
  token-linked market's own orders; a missing and a foreign order get the same
  "❌ #N buyurtma topilmadi." (CODE-18). **No service sends automatic
  new/cancelled-order alerts** to bound groups — only manual
  `POST /notifications/send` and `notification.dispatch`'s optional relay.
- **Gateway routes:** `GET/PATCH/DELETE /notifications/inbox*` (any authed user,
  own inbox), `POST /notifications/dispatch` (`@Roles(superadmin, admin)`).

### catalog-service (`catalog_schema`)
- **Entity:** `product`. CRUD + `update_own` (market), `delete_by_market`,
  `find_by_ids`. Pushes search index updates; resolves market via identity.
- **fix3 (2026-10-01, gateway):** `GET /product` and `/product/:id` require
  SUPERADMIN/ADMIN/REGISTRATOR/MANAGER/BRANCH/MARKET; a MARKET sees only its
  own products (another `market_id` / product → 403).

### analytics-service (no DB)
- Pure aggregator. `analytics.{dashboard,kpi,revenue,report.orders,report.couriers,
  report.finance}` — fans out to order/finance/branch/identity patterns and
  composes role-aware results.
- **fix3 (2026-10-01):** MARKET/MARKET_OPERATOR dashboard `markets` holds only
  the requester's own row (market cut to `{id,name}`; fail-closed `[]`);
  admin/branch dashboard market/courier rows are `{id,name}`;
  `report.couriers` is limited to the requester's own branch couriers for
  MANAGER/REGISTRATOR/BRANCH (empty report when the branch can't be
  resolved); `report.finance` monthly buckets use Tashkent months. (Order
  revenue chart buckets in order-service also use the Tashkent wall clock.)

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
  fix3 (2026-10-01): gateway `AUTH_THROTTLE_LIMIT` default **30** (was 10; login,
  per IP); new `AUTH_REFRESH_THROTTLE_LIMIT` (default **60**) and
  `AUTH_REFRESH_THROTTLE_TTL_MS` (default **60000**) for `POST /auth/refresh`,
  both `.empty('')`. The real values are read from `process.env` by
  `authThrottleConfig()` in `auth-gateway.controller.ts` (the `@Throttle`
  metadata loads before Joi defaults apply) — keep the two defaults equal.
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
  `ActivityLogService.log/logChange` (fail-safe writes), `query(filters,page)`,
  `findByEntity`, `prune`. **Wired into 9 services** (identity/order/finance/
  branch/logistics/catalog/integration/investor/notification — ~96 state-changing
  ops; tables in those schemas, action VARCHAR(64), migration 1716000000009).
  Each exposes `{svc}.activity_log.find_all` + `.find_by_entity`. Read via gateway
  **`GET /activity-logs`** (+ `/entity/:type/:id`, `/user/:id`, `/actions`),
  `@Roles(SUPERADMIN, ADMIN)`: fans in across per-schema tables, merges
  newest-first, and `AuditEnrichmentService` resolves raw ids (actor/entity/
  `*_id` refs) into full objects via batch find_by_ids (best-effort).
- **`src/idempotency`** — `idempotent-execute.helper.ts`: dedupe repeated
  operations (e.g. order money ops) by idempotency key. `in_progress` reservations
  carry a **lease** (`DEFAULT_IDEMPOTENCY_LEASE_MS`=30s): a key abandoned by a
  crashed worker is atomically reclaimed by the next caller so a `request_id` is
  never permanently stuck. (Audit 2026-06-06.)
- **`src/outbox`** — transactional outbox pattern support (reliable RMQ emit).
  fix3 (2026-10-01, M8): **money events never become `failed`** —
  `DEFAULT_PERSISTENT_OUTBOX_PATTERNS` = `finance.*` + `order.settlement.advance`
  retry forever at the 60 s backoff cap (other events still poison after
  `maxAttempts`, default 10). New `OutboxOptions`: `maxAttempts`,
  `persistentPatterns` (`[]` = old behaviour), `stuckAlertAttempts` (pending
  events with ≥10 attempts → error log every check, Sentry when the count
  changes). `OutboxService.requeueFailed({ids?, patterns?})` + inspect/replay
  SQL in `libs/common/src/outbox/README.md`.
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
Created by market / registrator / market_operator (Telegram bot route) / external
provider feed. A market's order waits in `new` until HQ accepts it by hand
(`order.receive` = HQ intake, `POST /orders/receive`, SA/ADMIN/REGISTRATOR/MANAGER;
business decision #1). Routed through branches via **transfer batches**
and assigned to couriers (`logistics.order.assign_to_courier`,
`order.scan_assign`). Courier records outcome: `sell` / `partly_sell` / `cancel`
/ `could_not_deliver`. Return: `initiate_return` → `mark_returned_to_market`.
`rollback_waiting` reverses sold/cancelled (settlement-aware). Full history in
`order_tracking`; custody in `order_custody_event`.

**fix3 rules (2026-10-01)** — gateway and order-service enforce the same rules:
- **Create** (`POST /orders`, `/orders/external`, bot, ai-confirm): for every
  requester except SUPERADMIN/ADMIN the lifecycle/custody fields (`status`,
  `post_id`, `courier_id`, `current_batch_id`, `assigned_at`, `return_reason`,
  `sold_at`, `canceled_post_id`, `holder_*`, `home_branch_id`,
  `parent_order_id`, `to_be_paid`, `paid_amount`, `qr_code_token`,
  `operator_id`; service also `paid_online_amount`) are **silently dropped** →
  always `new`, no courier, no post. Markets and the bot also lose
  `branch_id`/`source` (order at HQ); branch staff get their own branch forced
  (`source='branch'`; staff without a branch → 400; on
  `order.external.create` the source stays `external` and a branch-service
  failure → 503 instead of silently creating at HQ). `customer_id` is
  honoured only from SA/ADMIN — everyone else sends the `customer` object
  (`customer_id` alone → 400). Bot orders start `new` (not `created`).
  Requester-less internal imports are unchanged; the site import derives
  `region_id` from the district and skips unresolvable rows
  (`region_unresolved`).
- **Edit** (`PATCH /orders/:id`, `/:id/full` → `order.update_from_api`):
  SA/ADMIN/REGISTRATOR only. `status`, `market_id`, `to_be_paid`,
  `paid_amount` → 400 for everyone, SA included (status changes only through
  sell/cancel/return/rollback); `post_id`, `customer_id`, `qr_code_token`,
  `source` → SUPERADMIN only (403); the service also rejects internal
  snapshot fields (`courier_id`, `branch_id`, `sold_at`, tariffs/shares,
  `branch_cashbox_amount`, `sale_collectible_amount`, `extra_cost`,
  `external_id`, …) with 400. REGISTRATOR: only orders whose `branch_id` /
  `holder_branch_id` / `home_branch_id` is its branch (403, fail-closed).
- **Delete:** a market deletes only its own NEW orders; a registrator only in
  its branch scope (403).
- **Read scope (gateway):** `GET /orders/:id` — market own, market_operator own
  market, customer own, courier (`courier_id`/`holder_courier_id`), branch
  staff own branch triple (+ HQ staff: HQ-held), operator/investor 403;
  `/:id/tracking` — branch staff the same, courier only while holding the
  parcel. These checks used to read `response.data` (always undefined — the
  service returns the raw row) and never ran; they now enforce.
  `GET /orders` → 403 for OPERATOR/INVESTOR/unknown, CUSTOMER own,
  MARKET_OPERATOR own market; `/orders/market/:id` SA/ADMIN/MARKET;
  `/orders/markets/new` + `/:id/new` SA/ADMIN/REGISTRATOR/MANAGER/BRANCH/MARKET
  (market: own row); the cancelled lists give the HQ registrator HQ custody
  (like SA/admin); `GET /orders/:id/settlement` — MANAGER/REGISTRATOR own
  branch scope (403); QR lookups — a market sees only its own parcels;
  `orders.xlsx` — branch forced for MANAGER/REGISTRATOR/BRANCH.
- **HQ intake** (`order.receive` by SA/ADMIN/HQ registrator): orders held by a
  non-HQ branch → 400 "Bu buyurtma filialda turibdi — uni o'sha filial qabul
  qiladi (#ids)"; the whole request is refused, nothing reaches logistics.
- **Status machine:** `sold → partly_paid` is allowed (finance's partial market
  payout sync).
- **Outcome:** a manager (without the courier role) cannot sell / partly-sell a
  courier-held order → 400, the courier sells it (cancel is still allowed);
  partly-sell price > `total_price` → 400; a manager sale whose settlement
  branch cashbox is missing → 404 before the transaction; sell clears
  `return_requested`; a different new extra-cost request (action, amount,
  price) closes the old pending approval and creates a new one (the 202 reply
  carries the new approval); `initiate_return` — SA/ADMIN, or REGISTRATOR in
  its branch scope (others 403).
- **Rollback** (`rollback_waiting`) — the boundary is **HQ**:
  - courier: SOLD/CANCELLED only; a CANCELLED order only while the parcel is
    still with that courier (`holder_courier_id` = requester); target
    `cancelled_sent` is courier-only. Manager: SOLD/CANCELLED only, own
    branch. Superadmin: SOLD/CANCELLED/CLOSED/PAID/PARTLY_PAID (PARTLY_PAID is
    SA-only).
  - SOLD/PAID/PARTLY_PAID without `sold_at` → 400 for everyone (forged sale).
  - settlement row BRANCH_SETTLED/MARKET_SETTLED (cash at HQ) → 400 for
    **everyone**.
  - COURIER_SETTLED with a courier and non-zero `courier_amount` (the courier
    already remitted to the branch) → couriers and managers 400 ("Tuzatishni
    faqat superadmin qila oladi"). **SUPERADMIN correction:** inside the
    rollback transaction, under the same locks as `runFifoSettlement`
    (courier_to_branch carry → branch_to_hq carry → settlement row re-read),
    the row's `courier_amount` is added to the courier's `courier_to_branch`
    carry (credit toward his next settlement), then the legs are reversed as
    for a pending sale. Refused with 400/503 and no change: credit (negative)
    rows, rows without a branch or on the HQ branch, a courier now in another
    branch, a missing carry table, HQ/assignment lookup failure (503), a row
    that changed or reached HQ meanwhile.
  - which cashboxes are reversed comes from the settlement row, not from who
    clicks (§5.2). If the post-commit return-post creation fails the reply is
    200 with `data.cancel_post_created=false` + a warning.

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

**fix3 money rules (2026-10-01):**
- **Rollback reverses what the sale recorded** (M1/LC-01,
  `resolveRollbackReversalActor`): if the `order_settlement` row has a
  `courier_id`, that courier's FOR_COURIER sale leg is reversed and his extra
  cost refunded, whoever rolls back (a manager rollback of a courier sale = the
  courier's own rollback). `courier_id` null (manager/branch or provider sale)
  → no courier leg; the extra cost goes back to the settlement branch's BRANCH
  cashbox. Orders with no settlement row keep the old requester-based logic. A
  missing cashbox → 404 (no silent skip).
- **Extra-cost refund = `order.extra_cost`** (M5; the 5-second finance-history
  lookup is gone). `partly_sell` now writes `extra_cost`; rollback zeroes it
  after the refund. Extra-cost P&L entries carry sale/cancel/rollback dedup
  keys (M13). Partly-sell price ≤ `total_price`, so the rollback merge-back
  restores the original total exactly (M10).
- **Partner prepaid:** `order.create` persists `paid_online_amount`
  (0 ≤ value ≤ `total_price`, else 400; kept only for SA/ADMIN, the partner
  path and requester-less calls, stripped for markets/branch staff). The
  courier collects only the COD part (cod 0 → he collects 0; his share is
  booked as a credit).
- **Branch share (CODE-05):** `resolveBranchShare` asks branch-service with a
  system requester; 404 → 0; **any other failure → `logger.error` + 0**
  (launch-only fallback instead of a 503 — no PARTNER branch exists and
  ownership/`per_order_share` can't be set yet; revisit before onboarding one,
  log key `CODE-05: branch.find_by_id`).
- Provider sale (`markByProvider`): `branch_cashbox_amount = 0`,
  `sale_collectible_amount = total`; `markProviderSettledToHq` stamps a
  numeric actor or NULL.
- **SA correction after remittance** (M6): credit to the courier's
  `courier_to_branch` carry (§5.1). **Net-zero rows** (C8):
  `order.settlement.close_zero_courier_rows`. **Outbox** (M8): money events
  never poison (§4); `order.settlement.advance` is exactly-once via the
  applied marker.
- **Manager cash scope** (C3/M7/RBAC-07): own branch only — a manager receives
  cash only from couriers whose active `branch_users` row is in his branch
  (403 "Bu kuryer sizning filialingizga tegishli emas"; branch-service down →
  503). `click_to_market` by a manager → 403 (only via the HQ/MAIN cashbox).
  `POST /finance/cashbox/payment/market` is SA/ADMIN only.
- **Payout idempotency** (C1/M2): `payment/courier`, `payment/market` and
  `payment/branch-to-main` honour `Idempotency-Key` (used as `dedup_epoch`;
  duplicate → `{statusCode:200, data:{idempotent:true}}`). Without a key the
  market/branch-to-main fallback token = kind|actor|target|amount|method in a
  30 s bucket (no `payment_date`/`comment`).
- **Branch cash → HQ (business decision #7, 2026-10-01):** branch cash reaches
  HQ **only** when SA/admin receive it in "To'lovlar → Qabul qilinishi kerak"
  (choose the branch → `POST /finance/cashbox/payment/branch-to-main`).
  Managers do **not** push to HQ: the manager's own "HQga o'tkazish" screen is
  deliberately left as it was before fix3 and is not a supported flow. (The
  gateway route still lists MANAGER in `@Roles`; removing it is an open lead
  decision, §9.)

### 5.3 Branch transfer batches
Orders move between branches in QR-coded batches (forward + return),
`BranchTransferBatchStatus` (`PENDING→SENT→RECEIVED/CANCELLED`). Orchestrated by
branch-service, persisted by order-service (`branch_transfer_batch*`). Lifecycle:
create from a branch by `order_ids` → `send` (vehicle info) → `receive` /
`receive_orders` (partial) → `cancel`; `return_batches.create` groups by origin;
`post.dispatch` pushes an HQ post to a destination branch.

**fix3 (2026-10-01):**
- **`post.dispatch`** (`POST /branches/posts/:postId/dispatch`): `order_ids` is
  required; any id not in the post → 409 naming the ids, nothing moves. Only
  RECEIVED orders are dispatchable (NEW removed — CODE-11) → 400 naming the
  ids; a selection with orders that don't belong to the source (HQ) → 400
  "…Ularni tanlovdan olib tashlang…". The destination needs an **active**
  manager (identity check, 503 fail-closed). **LC-09:** a destination branch
  whose `region_id` differs from the source post's region → 400 (nothing
  moves); the destination SENT post is keyed by the **source post's region**
  (fallback: the order's region); no region at all → 400 naming the ids
  (LC-13). The source post is deleted only if a re-query shows it empty
  (LC-02).
- **`order.transfer_batch.receive_one_by_scan`** (a branch courier scans an
  order of a SENT batch addressed to his branch): when the batch has a
  `target_region_id` and the order's region differs (incl. NULL), custody
  moves to the branch but the status becomes **`new`** (transit — tracking
  `branch_batch_requeued`), mirroring the whole-batch receive; reply
  `received:false, reason:'transit', status:'new'`. logistics then answers the
  courier with a clear 400 and does **not** assign the order. Local orders
  still become RECEIVED.
- Gateway route order: `GET /branches/new-orders` is declared before
  `GET /branches/:id` (it was shadowed — the superadmin new-orders branch list
  was always empty/erroring; CODE-21).

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
- **Rate limiting:** `ThrottlerModule` global (~60/min/IP); auth endpoints have
  their own per-IP counters: login 30/min (`AUTH_THROTTLE_*`), refresh 60/min
  (`AUTH_REFRESH_THROTTLE_*`) — fix3 RBAC-11.
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
- **fix3 env (2026-10-01):** `AUTH_THROTTLE_LIMIT` default 30 (if
  `.env.production` still pins `AUTH_THROTTLE_LIMIT=10`, login stays at 10/min —
  remove or raise it; refresh no longer uses it); new
  `AUTH_REFRESH_THROTTLE_LIMIT` (60) and `AUTH_REFRESH_THROTTLE_TTL_MS` (60000),
  both in `.env.example` (recreate api-gateway to apply). integration-service
  now also reads `RABBITMQ_LOGISTICS_QUEUE` (present in the shared
  `.env.production`; not in `integrationValidationSchema`). Telegram:
  `TELEGRAM_BOT_TOKEN` (notification bot; empty = listener off) is still a
  placeholder on prod and `ORDER_BOT_TOKEN` is unset — neither bot works until
  ops sets real tokens.
- **fix3 deploy order:** backend first (all services — `libs/common` changed),
  then the frontend. Ship together: api-gateway + order-service (PATCH →
  `order.update_from_api`; a gateway alone gets no handler → 504),
  api-gateway + logistics-service (`district.update` needs the forwarded
  requester), api-gateway + branch-service (raised timeouts),
  integration-service + order-service (prepaid amounts).
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
  branch-config, analytics-reports not yet wired; several stale paths). Since
  2026-10-01 shift open/close is wired for SUPERADMIN/ADMIN (MAIN cashbox).
- Active initiatives tracked in memory: settlement/compensation, branch system,
  PCS parity, order-flow money fixes, audit findings.
- **After the fix3 deploy (ops, 2026-10-01):** the code stops new cases but does
  not repair old data — the 140 000 phantom on courier 289's FOR_COURIER
  cashbox (a manager rollback before M1; correction or test-data wipe); order
  65 still attached to an HQ region NEW post (LC-03); money outbox events
  already `failed` before M8 (`outbox_events` in `order_schema` /
  `finance_schema` — review, then `requeueFailed`/README SQL; for a failed
  `order.settlement.advance` first check the FIFO was not applied);
  partly-sold orders from before fix3 with 0/stale `extra_cost`; external /
  partner orders with `region_id` NULL; couriers without a cashbox (CODE-26,
  grep logs for "Saga compensation").
- **fix3 residuals / open decisions:** decision #7 is enforced only by the FE
  (gateway `branch-to-main` still lists MANAGER); one refresh session per
  account (RBAC-10 — a new login logs the older device out at its next
  refresh); courier assignment is last-write-wins (CODE-25, needs a
  compare-and-set on `courier_id`); the per-order PAID sync after a market
  payout is an approximation and in-process (M9/M2 — should come from
  `hq_to_market` settled ids); a manager may still **cancel** a courier-held
  order (LC-04); a stale extra-cost approval can still be approved after a
  courier restore (M3); after an SA credit a PENDING row equal to the carry
  waits for the courier's next payment and `close_zero_courier_rows` needs
  carry 0 (M6); the plain PENDING rollback path takes no carry lock
  (pre-existing); COURIER keeps `GET region/stats/all` (aggregates only,
  RBAC-14); partner tariff ownership = username prefix `mp<partner_id>_`
  (RBAC-13); identity `sanitize()` still returns salary/commission to internal
  consumers (CODE-08); the market dashboard `topMarkets` leaderboard is shared
  (RBAC-02 decision); registrators no longer see MAIN cashbox history; no SA
  "detach order from NEW post" endpoint (FE hides the action, LC-15); no
  salary payout command (FE hides "Maosh to'lash"); `GET /export/shifts.xlsx`
  is not wired in the FE and finance shift errors are English; bound Telegram
  groups get no automatic order alerts; FE popups are capped at 100 rows
  (FE-PAY-13).
```
