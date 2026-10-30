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
| **identity-service** | `identity_schema` | `user`, `app_settings` | Users of every role, auth (login/refresh/logout/validate), profiles, markets (+telegram token), couriers/managers/registrators/admins/customers |
| **order-service** | `order_schema` | `order`, `order_item`, `order_tracking`, `order_settlement`, `order_custody_event`, `branch` (mirror), `branch_transfer_batch(+item,+history)`, `order_batch_inbox_message` | The core. Order lifecycle, sell/cancel/return/rollback, per-order FIFO settlement, transfer batches, order analytics source |
| **catalog-service** | `catalog_schema` | `product`, `warehouses`, `warehouse_stock`, `stock_movements`, `stock_reservations` | Market product catalog + **temporary warehouse module** (hY7uacJu: regional-branch stock, stock-in/inventory, order reserve/out/release/return RPCs) |
| **logistics-service** | `logistics_schema` | `region`, `district`, `post`, `delivery_tariff`, `delivery_pricing_settings` | Geo (regions/districts, SATO codes) + **posts** (courier delivery batches): create/send/receive/reassign/cancel/return-requests + **delivery pricing engine** (DAqXPeSy: versioned tariffs, formula settings, `logistics.delivery.quote`) |
| **finance-service** | `finance_schema` | `cashbox`, `cashbox_history`, `shift`, `user_salary`, `operator_earning`, `operator_payment`, `financial_balance_history`, `payment_corrections` (T6), `cashbox_receipts` (T3) | Cashboxes (main/courier/market/branch), payments, shifts, salaries, operator earnings, company P&L ledger |
| **branch-service** | `branch_schema` | `branch`, `branch_config`, `branch_user` | Branch tree (HQ→regional→pickup), per-branch config (ownership/compensation), branch staff, transfer-batch orchestration, branch analytics/dashboard |
| **investor-service** | `investor_schema` | `investor`, `investment`, `profit_share` | Investor capital, investments, profit-share calculation/payout |
| **integration-service** | `integration_schema` | `external_integration`, `provider_shipment`, `provider_receivable`, `provider_remittance`, `sync_queue`, `sync_history`, `provider_webhook_log` | External providers (cargo/marketplace): credentials (AES-encrypted), sync queue, dispatch shipments, COD receivables/remittances, inbound HMAC webhooks |
| **notification-service** | `notification_schema` | `telegram_market`, `notification` | Per-user in-app notification inbox (dispatch/list/read/unread) + realtime socket.io push + Telegram group notifications (configs, connect-by-token, send) |
| **analytics-service** | — (no DB; aggregator) | — | Dashboards, KPI, revenue, reports — **reads other services** (order/finance/branch/identity) via RMQ; stores nothing |
| **file-service** | `file_schema` (only the ownership registry; objects in MinIO) | `file_objects` | Upload/download (signed URLs), PDF & QR generation in MinIO, per-object ownership registry (dgvwZasd B) |
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
- **Contacts (T7 QPq2C1co, 2026-10-30, migration 1716000000185):**
  `admins.market_responsible_id` (MARKET only; NULL = default) + table
  `app_settings` (`key` UNIQUE, `value` jsonb, `updated_by`; keys
  `contacts.support_phones` 0–2, `contacts.default_market_responsible_id`).
  `contacts/contacts.service.ts` (`identity.contacts.*`, names in
  `libs/common/src/contacts/contacts.ts`): settings + responsible bulk/single
  (SA/admin only, codes `SUPPORT_PHONES_INVALID` / `RESPONSIBLE_ROLE_INVALID` /
  `RESPONSIBLE_INACTIVE` / `NOT_A_MARKET`), market responsible resolver
  (active assigned → active default → none; responsible roles SA/admin/
  registrator/logist), `identity.contacts.for_user` (`GET /users/me/contacts`)
  and `identity.contacts.problem` (order region → `regions.logist_id` active
  logist, else support phones; one logistics RPC + one IN query). Deleting a
  responsible or changing its role to a non-responsible one resets its markets
  and the default in the SAME transaction (`saveWithResponsibleRelease`).
  Gateway: `contacts-gateway.controller.ts`, `contacts/problem-contacts.service.ts`
  (`problem_contacts` on order responses before the role projection, 60 s
  cache) and `auth/order-contact-projection.ts` (market/operator phones hidden
  from MANAGER/BRANCH/COURIER unless SA/admin/registrator/logist; applied inside
  `projectOrderPayloadForRoles` + market lists). Printer «Muammo bo'lsa» —
  only `problem_contacts`, row omitted when empty.
- **Auth:** `identity.login` / `identity.refresh` / `identity.logout` /
  `identity.validate` / `identity.user.profile`. Issues access+refresh JWT
  (gateway sets refresh as httpOnly cookie).
- **Sessions (Elchi Pochta #3, 2026-10-21):** one `user_sessions` row per
  login — per DEVICE since 2026-10-23, see below (sha256 of the refresh JWT, device/IP from the gateway audit context,
  `created_at` / `last_seen_at` / `expires_at` / `revoked_at`). A new login
  does not log other devices out; `identity.logout` revokes only the session
  from the access token `sid` / refresh cookie; `identity.auth.sessions`
  (`GET /auth/sessions`) lists the caller's own active sessions. Password /
  phone / role change, blocking and deletion revoke ALL sessions atomically
  via `admins.session_epoch` (+ a password-hash fingerprint per session);
  since 2026-10-23 a SELF password change keeps the current session (see
  «Password change» below).
  Pre-deploy tokens (`admins.refresh_token`) get their row on first refresh;
  that column is still written on login for rollback only. Hourly cleanup:
  epoch-reset open rows (expired ones too) → `security_reset`, rows 90 days
  past expiry deleted (`SESSION_RETENTION_DAYS`, was 30).
  Tokens: access 1h, refresh 1d, refresh not rotated and not sliding.
  **One session per device (2026-10-23, migration 1716000000140):** a login
  carrying a valid `X-Device-Id` (16–128 `[A-Za-z0-9._:-]`, else stored as
  `null`) reuses the user's NOT-closed row for that device (`revoked_at IS
  NULL` and `epoch` current; expired and password-fingerprint-stale rows
  ARE reused): same `id`/`sid` and `created_at` (first login), new hash /
  `expires_at` / epoch / fingerprint / method / `last_login_at` /
  `last_seen_at` / device name / UA / IP. Closed rows (logout,
  `revoked_by_owner`, `security_reset`, `merged`) are never reused — so the
  gateway revoked-sid cache stays valid; an epoch-stale open row is first
  closed as `security_reset`, then a new row is inserted. No device id → a
  new row per login (old behaviour). Partial UNIQUE
  `UQ_USER_SESSIONS_USER_DEVICE_OPEN (user_id, device_id) WHERE revoked_at
  IS NULL AND device_id IS NOT NULL`; a concurrent same-device login hits
  23505 and retries into an UPDATE (≤3 attempts) → exactly one open row;
  `adoptLegacy` on 23505 returns the same-hash row, else the device's open
  row. The migration added `last_login_at` (NOT NULL, backfilled from
  `created_at`, no default) and closed duplicate open rows per device as
  `merged` (most recently seen kept) before building the index; a BEFORE
  INSERT trigger `TRG_USER_SESSIONS_LEGACY_INSERT` fires only for INSERTs
  without `last_login_at` (pre-140 code during the deploy build / rollback
  window): fills it from `created_at` and closes the device's previous open
  row as `merged` instead of failing with 23505 (droppable later).
  `identity.auth.sessions` returns open rows (epoch current, `expires_at`
  within 90 days) with `status` `active` (not expired AND fingerprint
  matches) / `expired`, `first_logged_in_at` (= `created_at`) and
  `logged_in_at` (= `last_login_at`); order current → active → expired (each
  by `last_seen_at` desc), ≤50; `active_count` counts ACTIVE only. Revoke
  one / revoke-others also close expired-but-open rows (unchanged SQL:
  `revoked_at IS NULL`). Gateway `normalizeDeviceName` cleans
  `X-Device-Name` (invisible/bidi removed, controls → space, ≤128) with the
  UA-derived fallback.
  **Owner revoke (2026-10-22):** `identity.auth.sessions.revoke`
  (`DELETE /auth/sessions/:id`) closes ONE of the caller's own open
  sessions (not the current one → 400; foreign/unknown/closed → 404);
  `identity.auth.sessions.revoke_others` (`POST /auth/sessions/revoke-others`)
  closes every own open session except the current `sid` (one
  `UPDATE … RETURNING`; no `sid` → 400). Reason `revoked_by_owner`; the
  legacy `admins.refresh_token` is cleared when it would resurrect a closed
  device. A closed session's token cannot revoke the owner's others (401).
  Immediate cut-off: the gateway `JwtStrategy` asks
  `identity.auth.session_state` (`{active}` = own row, `revoked_at IS NULL`,
  one PK lookup) for every token WITH `sid` through
  `SessionRevocationService` — in-memory cache (open 30 s, revoked
  ACCESS_TOKEN_TIME, ≤10k entries), 1.5 s timeout, FAIL OPEN on identity
  errors (warn once/min, 5 s). Revoke endpoints and logout mark the returned
  `session_ids` locally at once (another gateway instance: ≤30 s). Tokens
  without `sid` (Telegram Mini App, bot actor) are not checked; epoch /
  password-fingerprint / expiry stay refresh-time checks (the hourly
  cleanup stamps epoch-reset rows, after which they are cut off too).
  **Socket kick (2026-10-24):** the realtime gateway applies the same check.
  A socket whose token has a `sid` first joins `session:<sid>`, then asks
  `SessionRevocationService.isRevoked` (cache / `session_state`, fail open);
  closed → `error { message: 'Session revoked', code: 'SESSION_REVOKED' }` +
  `disconnect(true)` before it joins `user:`/`role:` (a kick that lands during
  the check reaches it through the session room; a stale `active` reply loses
  to a concurrent mark). `connected` carries `session_id`. Every place the
  gateway learns closed ids goes through ONE helper,
  `SessionRevocationService.kickSessions(ids, reason)`: marks them revoked
  (UUIDs only, lower-cased, deduped) and notifies listeners — `RealtimeGateway`
  emits `auth:session_revoked { session_id, reason }` to each `session:<sid>`
  room and `SESSION_KICK_DISCONNECT_DELAY_MS` (250 ms) later calls
  `in(rooms).disconnectSockets(true)` (event first, then the socket.io
  DISCONNECT packet → client reason `io server disconnect`, no auto-reconnect).
  Callers / reasons: revoke one + revoke-others → `revoked_by_owner`; logout →
  `logout` (the current session's other tabs); `PATCH /auth/my-profile` /
  `PATCH /users/:id` with a password (`applyRevokedSessionIds`) →
  `password_changed`; identity's `{cmd:'auth.sessions.kick'}` event on the
  gateway queue (`RealtimeController.sessionsKick`, ≤1000 ids, unknown reason →
  `security_reset`) → `security_reset`. Identity publishes that event
  (`SessionKickPublisher`, `GATEWAY` client, needs `RABBITMQ_GATEWAY_QUEUE`,
  fire-and-forget, 2 s timeout, chunks of 500) only for closures outside the
  gateway request path: hourly `cleanup` (`UPDATE … RETURNING s."id"`),
  refresh-time `revokeOwn(…, 'security_reset')` and the stale-epoch device row
  closed on re-login. An epoch bump alone (role/phone change, block, delete)
  still does not close rows — those sockets are kicked when the refresh or the
  hourly cleanup stamps them (HTTP keeps the same ≤1 h window).
  Multi-instance: the gateway queue is a competing-consumer queue and there is
  no socket.io adapter, so a kick only reaches sockets on the instance that
  handled it (today: one instance); other instances reject reconnects and cut
  HTTP within 30 s.
  **48-hour lock (2026-10-23):** revoke one / revoke-others load the
  caller's open session (`AuthSessionService.findOpen` → `created_at` = first
  login on that device, kept when the device re-logs in) and refuse with 403
  `{ statusCode, message, code: 'SESSION_TOO_NEW', available_at }` while
  `now < created_at + SESSION_REVOKE_LOCK_HOURS` (identity env, default 48,
  `0` = off; `sessionRevokeLock` in `session-security.ts`, boundary
  inclusive at exactly 48:00). Applies to every role and to older AND newer
  targets; an old session may close a new one; logout is not restricted. With
  the lock on, a sid-less token gets 400 on DELETE too. `identity.auth.sessions`
  adds `can_revoke_others` / `revoke_available_at` (from the current row's
  `first_logged_in_at`; no current row → false / null). The gateway error
  envelope passes `code` plus that code's fields only for codes listed in
  `libs/common/src/filters/public-error-fields.ts` (`PUBLIC_ERROR_CODES`).
  **Password change (2026-10-23):** `identity.user.update` with `password`
  (`PATCH /auth/my-profile`, `PATCH /users/:id`; gateway passes the JWT `sid`
  as `current_session_id`). Self change from a sid session with no other
  security event in the request → epoch NOT bumped, legacy `refresh_token`
  cleared, `AuthSessionService.afterPasswordChange` rebinds the current row's
  `password_fp` to the new hash (refresh keeps working) and revokes every
  other open row as `password_changed` (`revokeOwnExcept`). Otherwise (admin /
  manager reset, sid-less token, phone change in the same request, current row
  closed or epoch-stale) → `invalidateAllSessions` in the same save + every
  open row revoked as `password_changed` (`revokeAllOpen`, `UPDATE …
  RETURNING`). `identity.market.update` with a password → all. Not subject to
  the 48 h lock. Reply adds `sessions_revoked` and internal
  `revoked_session_ids`, which the gateway marks in `SessionRevocationService`
  and strips (`applyRevokedSessionIds`). Activity log: `logout`, entity
  `Auth`/user id, metadata `{ scope: 'password_change', by: 'self'|'admin',
  kept_current, sessions_revoked, session_ids }`. If revoking fails after the
  save the password stays changed (warn): stale rows are still refused at
  refresh by the fingerprint. No OTP / forgot-password reset exists (OTP
  purposes: `login`, `phone_verify`).
  **Temporary password + SMS (aidsxJ2H, 2026-10-30):** `POST /admins`,
  `/registrators`, `/logists`, `/couriers`, `/managers`, `/markets` take
  `password_mode: generate_sms (default) | manual` and
  `must_change_password` (`temp-password/create-password.ts`). No mode +
  `password` → `manual` (legacy form). `generate_sms`: 12-char
  `generateTempPassword` (`libs/common/src/security/temp-password.ts`), hash
  only, SMS after the create saga, `must_change_password` and
  `admins.password_change_forced` both true; reply adds `password_mode` and
  `password_sms` (`pending|sent|delivered|failed` + `failure_reason`,
  `failure_message`), never the password. SMS failure never fails creation.
  `TempPasswordService` keeps `user_password_sms` (no secret: who, when,
  status, `client_message_id`), sends via `notification.sms.send_temp_password`
  with no RMQ retry, and reads live status via `notification.sms.delivery_status`.
  In `sms_outbox` the password lives in `text` only until the provider accepts
  or the row is terminal, then `text` becomes `redacted_text` (added by
  migration 195); `last_error`, `last_response` and the scheduler log are
  scrubbed with `scrubSmsSecret`. Template `user.temp_password` (class
  `security`, OTP quota) needs provider approval.
  `POST /users/:id/password/resend-sms`: SA; admin except admin/SA; manager only
  own (`created_by`) courier; 60 s cooldown and 5/Tashkent day under a per-user
  advisory xact lock (429 `PASSWORD_SMS_COOLDOWN` / `PASSWORD_SMS_DAILY_LIMIT`).
  The hash is swapped and all sessions revoked only AFTER the SMS is queued; a
  queue failure leaves password and sessions untouched. `GET
  /users/:id/password/sms-status` is the live status. `pwd_forced` JWT claim
  (from `password_change_forced`) makes `PasswordChangeGuard` return 403
  `PASSWORD_CHANGE_REQUIRED` regardless of `PASSWORD_CHANGE_GATE` (which still
  governs NDmZMzCP's weak-password `pwd_change`). Self password change:
  `old_password`, when sent, is always verified (400 `OLD_PASSWORD_INVALID`);
  when absent, `PASSWORD_CHANGE_REQUIRE_OLD=on` gives 400
  `OLD_PASSWORD_REQUIRED`, default off keeps the current FE working. A
  must-change user cannot reuse the current password; a self change clears both
  flags.
- **Per-role create/list:** `identity.{courier,manager,registrator,market,customer}.*`,
  generic `identity.user.{create,find_all,find_by_id,update,delete,status}`.
  YEThmZBn (2026-10-23): `find_by_id` with `include_branch: true` (only the
  gateway's `GET /users/:id` sends it) attaches `branch: { id, name } | null`
  via `branch.user.find_by_user` (self requester) for courier / manager /
  registrator / branch; internal callers (finance, order, branch…) get the old
  shape and no branch call. `identity.user.update` accepts `district_id`
  (null clears; else `logistics.district.find_by_id` must find it and its
  `region_id` must equal the user's, if the user has one; 404 → 400, other
  errors → 503); region is not changed there. `GET /users` (gateway only)
  adds the same `branch` to every row with ONE `branch.user.find_by_user_ids`
  call per page (`{ user_ids, requester }` → `[{ user_id, branch: { id, name }
  | null }]` for every requested id; one SQL: `DISTINCT ON (user_id)` latest
  active `branch_users` row LEFT JOIN live `branches`, `user_id = ANY(...)`;
  superadmin / admin / manager only, ≤500 ids). Branch-service down / 3 s
  timeout → `branch: null`, list still 200; `identity.user.find_all` itself is
  unchanged.
- **Market specifics:** telegram token (`market.find_by_tg_token`, `rotate_tg_token`),
  `expense_proof_conditions`. Creating a user also creates its cashbox
  (`finance.cashbox.create`) and may assign to a branch (`branch.user.assign`),
  and indexes to search.
- **fix3 (2026-10-01):** `market_tg_token` (format `group_token-<32 hex>`) is
  returned only by `identity.user.find_by_id` with `include_tg_token` (the
  gateway sets it for SUPERADMIN/ADMIN only) and only on market rows — the
  admin hands it to the market for the Telegram group bind. `rotate_tg_token`
  now has **no caller** (a group bind no longer rotates). Refresh: a validly
  signed but unknown token → 401 without touching other sessions (since
  Elchi Pochta #3 every login has its own session, see above); a password or
  login-phone change revokes all of the account's sessions (a self password
  change from a sid session keeps that one — 2026-10-23, see above).
  Admins may edit their own name/phone/password (`PATCH /auth/my-profile`).
  Deleting a manager/registrator also removes the active `branch_users` row
  (`branch.user.remove`, best-effort, warn log). User-create saga: a failed
  branch assign / cashbox create compensates (unassign + soft-delete) instead
  of leaving an orphan user.
- **Market operators (`identity.market_operator.*`, MARKET only, own operator
  else 404):** `create`, `find_by_market`, `delete`, `update_commission`,
  `update_warehouse_access`, `set_status` (mFkrqvMi, `PATCH
  /market-operators/:id/status {status: active|inactive}`): `inactive` →
  `invalidateAllSessions` (same save), `active` → the market itself must be
  ACTIVE (else 403); orders / commission / earnings untouched; activity log
  `status_change` (actor = market, `metadata.reason =
  market_operator_status`); unchanged status → 200 without a log. `create`
  takes an optional `commission_type` + `commission_value` (B3ZtzCCx; both
  or neither, same bounds as `update_commission` via shared
  `parseMarketOperatorCommission` / `assertMarketOperatorCommissionBounds`),
  saved in the same INSERT.

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
  - **Sm3LZ6EN (2026-10-30) — incoming bags:** `order.external.find_all` adds
    `meta.batches` (`lookup/external-batch-counts.ts`): one `GROUP BY
    external_batch_token` over whole bags seen on the page — not cut by
    page/status/date, same market + branch scope as the list.
    `received_count` = past `created`/`new`, except `cancelled` with no post
    (partner cancelled before intake); `pending_count` = `new`; arrived =
    received + pending vs. the partner's `external_batch_size`. The same counts
    answer `order.receive_by_scan` (`batch`/`batches`, after intake, failure
    swallowed — parcels are already received) and
    `order.find_batch_by_external_token` (`batch`; `market_id` also limits
    `members`, so a market gets 404 on a foreign bag).
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
  - **T6 (2026-10-30):** `order.settlement.retreat` `{level: courier_to_branch |
    hq_to_market, match_value, amount, request_id}` (finance outbox, persistent,
    `runIdempotent` + `reclaimFailed`, applied marker
    `order.settlement.retreat.applied:<sha256>`): takes min(carry, X), then
    reopens the newest rows not yet past the next hop of the ORIGINAL
    receiver (`receiver_cashbox_type`/`receiver_branch_id`: branch →
    COURIER_SETTLED of that branch, main → BRANCH_SETTLED with NULL branch →
    PENDING; MARKET_SETTLED → BRANCH_SETTLED; click_to_market enqueues
    `hq_to_market` first). Rows are locked FOR UPDATE in createdAt order and
    `runFifoSettlement` now locks its candidates too (no lost update),
    excess → carry, shortfall → NEGATIVE carry. `runFifoSettlement` no longer
    clamps a negative carry (the next payment closes it first); summaries and
    `courier_scope.carry_amount` are signed. `order.payment_reversal.apply`
    `{order_id, paid_amount, status}` uses `ORDER_PAYMENT_REVERSAL_EXTRA_
    TRANSITIONS` (PAID → PARTLY_PAID|SOLD, PARTLY_PAID → SOLD) — only there.
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
- **Warehouse fulfillment (6kHnNH9j, 2026-10-25, migration `1716000000153`)** —
  `src/warehouse/order-warehouse.service.ts` (`OrderWarehouseService`); the
  lifecycle only has call sites. `orders.fulfillment_source` varchar(16)
  `HQ | WAREHOUSE` (default `HQ`, CHECK) + `warehouse_id` bigint (CHECK
  `WAREHOUSE ⇔ warehouse_id`, partial index); old orders HQ.
  - Create: `order.create` `dto.fulfillment` (`auto | hq`; ABSENT → HQ, so
    bot / partner / import / partly-sell children stay HQ; the gateway sends
    `auto` by default for `POST /orders` and ai-confirm, `hq` for the bot).
    `planCreate`: `auto` + creator SA/ADMIN/REGISTRATOR/MARKET/MARKET_OPERATOR
    + every item a catalog `product_id` + district (else region) + no explicit
    placement (courier/post/batch/non-NEW status/external/parent) →
    `catalog.warehouse.resolve_source` (3 s; error → HQ). WAREHOUSE plan →
    `create()` → `createOnce(plan)`: order inserted `RECEIVED`,
    `branch_id = home_branch_id = holder_branch_id = warehouse branch`
    (holder BRANCH, no post, no HQ intake), then — inside the same tx —
    `reserveForNewOrder`: a separately committed GUARD outbox event
    (`catalog.warehouse.release`, scheduled +10 min, note
    `order_create_guard`) → `catalog.warehouse.reserve` (order id = key) →
    guard deleted in the order tx. Reserve fails (4xx: guard marked
    published; timeout/5xx: guard kept) → `WarehouseReserveFallback` → tx
    rolled back → `createOnce(null)` = the WHOLE order at HQ (new id). The
    guard frees an orphan reservation after a lost reply / commit failure /
    crash (release without reservation is a no-op).
  - Transitions (`updateFull` → `writeOrderChanges` → `onOrderWritten`, same
    tx, transactional outbox, target CATALOG): custody → COURIER (first time
    or again) → `catalog.warehouse.out` (`lenient`; parent orders only);
    `cancelled (sent)` → `cancelled` with holder BRANCH = `home_branch_id`
    (the courier's canceled post received at the warehouse branch) →
    `catalog.warehouse.return` (partly-sell child: parent's order id, the
    child's items, key `child-order-<id>`) and the order is CLOSED in the same
    tx: `returned_to_market`, holder MARKET, tracking action
    `warehouse_returned` + custody event (no HQ return flow, no market
    handover). A cancelled parcel received by another branch / HQ → no return
    (stock stays OUT). `remove()` (SA, RECEIVED) → `catalog.warehouse.release`
    (`lenient`). Partly-sell children inherit `fulfillment_source` /
    `warehouse_id`. Outbox option `persistentPatterns` += `catalog.warehouse.*`
    (never poisoned); catalog `out`/`release` with `lenient: true` answer
    no-op instead of 409 (out after release / release after out), so a
    reordered retry (return delivered before out) converges to the same stock.
  - Reads: `findAll` filter `fulfillment_source` (HQ | WAREHOUSE, else 400);
    `enrichOrders` adds `warehouse: { id, name, branch_id } | null`
    (`catalog.warehouse.find_by_ids`; catalog down → `{ id, name: null,
    branch_id: null }`).
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
- **Delivery pricing engine (DAqXPeSy, 2026-10-24, migration 142)** —
  `src/delivery-pricing/` (own controller + service; NOT in the 7k-line
  service). Math is the pure `computeDeliveryQuote` in
  `libs/common/src/pricing/delivery-pricing.ts` (landing `lib/pricing.ts`
  formula 1:1, 13 golden vectors; integer grams / cm³ / tiyin). Data:
  `delivery_tariffs` (versioned by `valid_from`, current = `is_active` and
  `valid_from <= now()`, newest; new price = new row, old rows kept),
  `delivery_pricing_settings` (one active row, PATCH = new version under
  `pg_advisory_xact_lock`), `regions.is_city_zone` (only Toshkent SHAHRI,
  SOATO 1726). Tariff choice: both ends city zone → `city`, else
  `where_deliver`; a district counts by its GEOGRAPHIC `region_id`, not
  `assigned_region`. RPCs: `logistics.delivery.quote` (read-only;
  `items[]` = `product_id` → dims via `catalog.product.find_by_ids`, MARKET
  only own products, or raw dims), `logistics.delivery.tariffs.find_all` /
  `.create`, `logistics.delivery.settings.get` / `.update` (audit verbs
  `logistics.delivery_tariff_created`,
  `logistics.delivery_pricing_settings_updated`). No cache. Pickup fee is
  returned separately and never part of `total`. **Sale wiring (KmWO9gTA)**:
  `logistics.delivery.sale_quote` (internal: order-service and the partner
  tariff; optional `from` = market region, unknown → not city; `product_id`
  items, unknown → unmeasured; returns `extra`, table bases, `min_delivery_price`,
  `extra_cost_limit_amount` — migration `1716000000183`). order-service
  `pricing/sale-pricing.ts` + `domain/order-money.ts`
  `resolveOrderTariffDetailed`: snapshot first; with
  `SALE_PRICING_ENGINE=on` (default `off` = old behaviour byte-for-byte),
  optional canary `SALE_PRICING_ENGINE_MARKET_IDS` and market
  `weight_volume_pricing` (identity, migration `1716000000182`, default
  true) the MARKET leg = standard price (`tariff_home`/`tariff_center`, else
  table base) + weight/volume surcharge, floored at courier + branch share /
  `min_delivery_price`; sell extra-cost limit from table
  `address.base − center.base` / `extra_cost_limit_amount`. Courier tariff
  and rollback (snapshot) untouched. `orders.quoted_market_tariff`
  (migration `1716000000184`) = open-time quote; drift →
  `order.delivery_price_changed` activity log.
  **Partner tariff (6tGZzupr)**: `GET /partner/tariff` (gateway) no longer has
  its own center/home ternary — `market_tariff` comes from
  `resolveOrderTariffDetailed`, moved with `readSalePricingConfig` /
  `isSalePricingEngineActive` to `libs/common/src/pricing/sale-tariff.ts`
  (order-service re-exports them, behaviour unchanged). Same switches as the
  sale: engine off → profile tariff, on → standard + surcharge, floored at
  `min_delivery_price` only (seller share unknown before the sale). The gateway
  calls `logistics.delivery.sale_quote` (not `quote`: `from` must stay optional
  like in the sale) only when measures/`express`/`pickup` are given, the engine
  is active or the profile tariff is NULL/0; `sale_quote` gained raw measure
  items and `express` / `pickup_count` (sale payload unchanged). Response adds
  `estimated`, `tariff_source`, `quote`; a NULL profile → table base, never a
  silent 0 (no quote → 503); an explicit 0 stays 0 (contract, sale charges 0).
  Engine failure → profile tariff, `estimated: true`, `quote: null`.
  External import `delivery_price` is the shop's own price: it only joins
  `total_price`, never `market_tariff` (guard spec).
  Volumetric threshold (AQ9lkgVB, migration `1716000000154`):
  `delivery_pricing_settings.volumetric_from_kg` numeric(10,3) DEFAULT 0 —
  shipment volumetric weight below it is ignored (billable = actual weight),
  ≥ applies as before; quote returns `volumetricFromKg` / `volumetricApplied`.
  catalog-service warehouse «Hisob vazni» (`warehouseChargeableWeight`) stays
  threshold-free on purpose — the threshold is shipment-level (Σ × quantity),
  a per-unit view cannot reflect it.

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
- **Realtime (rWdLuoP3, 2026-10-25):** `FinanceRealtimeService` writes
  `{cmd:'realtime.notify'}` to the outbox (target `GATEWAY`, fire-and-forget)
  INSIDE the business transaction: `finance.shift.closed` /
  `finance.shift.auto_closed` (shift close; MAIN → roles superadmin/admin/
  registrator, BRANCH → `manager` of that branch only, + opener/closer user
  rooms), `finance.shift.account_checked` (kiZgTybn: emitted by
  `ShiftAccountCheckService.applyAiResult` when a card-balance screenshot AI
  result lands; payload `shift_id`, `card_id`, `ai_status`, `checked_at`),
  `finance.cashbox.card_changed` (card create/rename/update/status/
  make-default/transfer/convert → superadmin/admin; Zv3MLn0a: a BRANCH cashbox
  card also → `manager` of that branch, payload `cashbox_type: 'branch'` +
  `branch_id`). Skipped when `RABBITMQ_GATEWAY_QUEUE` is unset. Payloads
  carry ids + times only (no amounts).
- **Cashbox cards / accounts (3PE0B03q base, Zv3MLn0a 2026-10-26):**
  `finance_schema.cashbox_cards` (migr 105 + 161) lives in MAIN **and BRANCH**
  cashboxes; invariant per cashbox `Σ(cards) == cashbox.balance_card` (the
  default «Asosiy karta» balance is derived `balance_card − Σ named`, stored 0).
  Details (migr 161, additive): `kind` (virtual_card|plastic_card|bank_account,
  NULL = legacy), `bank_name`, `card_network`, `last4` (ONLY last 4 digits,
  DB CHECK `^[0-9]{4}$` — full PAN/account numbers are never stored),
  `holder_name`, `note`, `require_photo_on_shift_close`, `ai_check_enabled`
  (CHECK: AI only with photo; writable by SUPERADMIN only — gateway 403 for
  ADMIN + service `allow_shift_settings` flag). `cashbox-card.service.ts`:
  every mutation locks the cashbox row FOR UPDATE first (id-based ops take the
  cashbox from the card), then cards; `applyCashboxCardSelection` binds a
  CLICK leg to a card of the SAME cashbox (MAIN/BRANCH; other cashbox → 403,
  cash/click_to_market → 400, no `card_id` → default card). `card_id` is
  accepted by `fill`/`spend` (manager → own branch cashbox), `payment_courier`
  (receiver leg, MAIN or manager's branch), `payment_market` (MAIN),
  `payment_branch_main` (`card_id` = MAIN leg, `branch_card_id` = branch leg).
  `make_default` swaps the default card under the cashbox lock (no money
  moves; old default keeps its derived balance as stored balance; its
  card-less CLICK history rows are stamped with its id so both ledgers stay
  exact). Shift close adds card↔cash conversions of the shift's own cashbox
  (MAIN or BRANCH). Gateway `/finance/cashbox/cards*`: list / movements /
  `:id/ledger` / `:id/ledger/export` (xlsx) — SA/ADMIN (+ optional
  `branch_id`) and MANAGER (always own branch; other branch → 403); create /
  PATCH `:id` (details, also on the default card — only its name is locked) /
  `:id/status` / `:id/make-default` / transfer / convert — SA/ADMIN.
- **Shift close — per-card balance confirmation (kiZgTybn, 2026-10-26):**
  `finance_schema.shift_account_checks` (migr 166; UNIQUE shift_id +
  cashbox_card_id) + `finance_schema.finance_settings` (key/value, SA only).
  Global keys: `shift.account_check.enabled` (default false → `accounts[]`
  required for EVERY active card of the shift's cashbox), `shift.photo.required`
  (default true, master switch AND card `require_photo_on_shift_close`),
  `shift.ai_check.enabled` (default false, master switch AND card
  `ai_check_enabled`). Flow: gateway `POST /finance/shift/account-photo`
  (jpeg/png/webp ≤5 MB, magic bytes, `stripImageMetadata` removes EXIF/XMP/
  IPTC/text chunks, file-service folder `shift-check`, private, signed URL
  300 s) → `finance.shift.account_check.attach_photo` (draft row, expected
  balance snapshot, `ai_status` pending/disabled, new `ai_request_id`) → if AI
  on, gateway background task → ai-service `ai.finance.balance_screenshot`
  (feature `finance_balance_screenshot`, area `internal`, counts in
  `AI_DAILY_USD_CAP`, returns only last4) → `finance.shift.account_check.
  ai_result` (stale `ai_request_id` ignored; `ai_status` match = |read −
  system| ≤ 1 so'm AND last4 equal, else mismatch / unreadable / error;
  `ai_entered_ok` = entered vs read) + realtime. `closeShift` waits ≤30 s
  (`SHIFT_CLOSE_AI_WAIT_MS`) for fresh pending rows OUTSIDE the lock, then in
  the shift transaction `confirmAtClose` re-snapshots expected per card
  (named = balance, default = derived), validates (photo required → 400;
  difference ≠ 0 / AI mismatch / entered ≠ read → comment required → 400) and
  finalizes rows. NO money moves (balances only read). `finance.shift.report`
  (`GET /finance/shift/:id/report`): cash + card aggregates, `accounts[]`,
  `accounts_summary`, operations (type × method: count, sum) for the shift
  window; manager → own branch, registrator → MAIN (else 404); gateway signs
  photo URLs, `ai_raw` only for SUPERADMIN. Settings: `finance.shift.settings.
  {get,update}` (`GET|PATCH /finance/shift/settings`; PATCH SUPERADMIN only).
  Activity-log: `finance.shift_settings_updated`,
  `finance.shift_account_photo_uploaded`, `finance.shift_account_ai_checked`,
  shift close metadata `accounts`.
- **Shift auto-close + shift report delivery (y8Tqm9Ap + gWI4gYkw,
  2026-10-26):** migr 167 adds `shifts.close_reason` (manual|auto, NULL =
  open / legacy → API `manual`), `closed_by_system`, `report_status`
  (pending|processing|sent|skipped|failed), `report_claimed_at`,
  `report_round`, `report_file_key`, `report_file_format`; tables
  `shift_schedule_claims` (PK `key` = `auto_close:<shift>:<slot>` /
  `warn:<shift>:<slot>`) and `shift_report_deliveries` (UNIQUE shift, round,
  recipient, channel; status queued|sent|failed|skipped + `failed_reason`).
  Settings in `finance_settings` (SA only, `PATCH /finance/shift/settings`
  `auto_close{enabled,times[],scope,warn_before_min}` + `report{recipients:
  {superadmin|couriers|markets: {telegram,in_app}}, format pdf|xlsx}`).
  Defaults: auto-close OFF and report delivery OFF (every recipient × channel
  `false`, release 9) — until SA enables `report.recipients`, `deliver` sends
  nothing and sets `report_status = skipped`.
  `ShiftAutoCloseScheduler` (`ScheduleModule`, CronJob every minute,
  Asia/Tashkent; `FINANCE_SHIFT_SCHEDULER=off` kills it): session
  `pg_try_advisory_lock(716000000167)` per tick (skip if busy) → warn window
  (`warn:` claim + `finance.shift_auto_close_warning` outbox in ONE tx, to
  `opened_by`) → due slots (slot ≤ now < slot+10 min) → `autoCloseShift`
  for open shifts in scope (`main` = cashbox '0'/NULL, `main+branches` = all)
  opened BEFORE the slot: shift row FOR UPDATE + status open + `auto_close:`
  claim (ON CONFLICT DO NOTHING) → same totals as manual close
  (`fillShiftCloseTotals`), counted = NULL → `discrepancy_* = NULL`,
  `closed_by = NULL`, `closed_by_system = true`; card rows via
  `recordAtAutoClose` (all active cards if account check is on, else only
  drafts; `entered_balance/difference = NULL`, `ai_status = not_required`,
  unconfirmed); realtime `finance.shift.auto_closed`; activity-log
  `finance.shift_auto_closed`. Next shift is NOT opened. Report:
  `ShiftReportService` — close tx sets `report_status = pending`, after
  commit `deliverSoon` (+ scheduler `processPending` for pending > 30 s /
  stale processing > 10 min) → atomic claim (UPDATE … RETURNING) → snapshot
  (shift money blocks, card rows, courier slices = INCOME courier_payment
  rows of the shift cashbox grouped by `source_user_id` + FOR_COURIER
  balance, market slices = EXPENSE market_payment rows + FOR_MARKET balance)
  → superadmins (`identity.user.active_ids_by_role`, explicit ids) get full
  text + PDF/XLSX in file-service folder `shift-report` (private,
  `data.telegram_media`); couriers/markets only their own slice (no ops → no
  message); markets' Telegram = group relay (`telegram.market_id`, text +
  link); Telegram link pre-check `identity.telegram.resolve_many` → unlinked
  = `failed` «Telegram ulanmagan», in-app only. ONE tx: delivery rows +
  `notification.dispatch` outbox (`client_request_id` = UUIDv5
  `shift-report:<shift>:<round>:<recipient>`) + `report_status = sent`.
  Types `finance.shift_closed` / `finance.shift_auto_closed` (group key
  `finance:shift:{{shift_id}}:report:{{round}}`). `queued` rows are synced on
  read by the GATEWAY (SA report view): notification-service
  `notification.delivery.by_dispatch` → `finance.shift.report.deliveries.sync`
  (finance itself never injects the NOTIFICATION client — outbox only).
  `POST /finance/shift/:id/report/resend` (SA) → new round. Report response
  adds `close_reason`, `closed_by_system`, `auto_close{closed_at,label}`,
  `report{status,round,file_format,has_file,file_url(SA)}`, `deliveries[]`
  (SA only). NO money moves anywhere in this flow.
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
- **Payment correction (T6, 2026-10-30, migr `1716000000186`):** SUPERADMIN
  only reverses or re-amounts a courier receipt (`courier_payment`, MAIN/BRANCH,
  cash/click/click_to_market) or an HQ market payment (`market_payment`).
  Every payment leg now carries `cashbox_history.transfer_id` (uuid; written
  by `applyCourierPaymentInTx` / `applyMarketPaymentInTx` — the tx-scoped money
  parts of `paymentsFromCourier` / `paymentsToMarket`; migration backfilled 365
  days of unambiguous pairs, ambiguous → NULL = `LEGACY_UNLINKED`).
  `PaymentCorrectionService` (`payment-correction/`): locks courier → MAIN/
  BRANCH → market, writes one `payment_reversal` row per original leg
  (`reverses_history_id` UNIQUE partial, `source_id` = leg id, `dedup_epoch`
  `pc:<id>`, comment = reason; originals untouched), edit = reversal +
  replacement payment in ONE tx (`dedup_epoch pc:<id>`, no
  `finance.payment_received` / PAYMENT audit). Journal
  `finance_schema.payment_corrections` (`original_transfer_id` and
  `idempotency_key` UNIQUE, chain `root_transfer_id` / `root_created_at`).
  Window `finance_settings` `payment_correction.window_days` (1…365, none → 30)
  from the chain root. Same tx outbox: `order.settlement.retreat` (persistent
  pattern; courier → `courier_to_branch`, market leg → `hq_to_market`), then
  (edit) `order.settlement.advance`, `finance.payment_corrected` per recipient
  (recipient language via `identity.audience.resolve`), realtime
  `finance.payment.corrected`. After commit: audit
  `finance.payment_reversed` / `finance.payment_amount_corrected`
  (`partner_notified: false`) and, for market legs, background
  `revertPaymentFromOrders` (newest PAID/PARTLY_PAID → `order.payment_
  reversal.apply`) then `applyPaymentToOrders(new)`. Coded errors in
  `libs/common/src/finance/payment-correction.ts` (+ `PUBLIC_ERROR_CODES`).
  History responses carry `transfer_id`, `reverses_history_id`, `correction`;
  `/history/:id` gives SA `correctable`. Courier ack on a corrected payment →
  409 `PAYMENT_CORRECTED`. Gateway (via `finance.payment_correction.context`:
  receiver, courier, `replay`) refuses a courier payment whose courier no
  longer sits at the original receiver (409 `COURIER_MOVED`) and, for
  correct-amount, applies C3/C4; a same-key replay skips both. Retreat maps
  an HQ-branch BRANCH receiver to MAIN and only spends carry tagged for the
  same receiver. RMQ: `finance.payment_correction.{reverse,
  correct_amount,context,settings.get,settings.update}`.
- **Expense categories (Elchi Pochta №1):** `cashbox_expense_categories`
  (superadmin CRUD, soft delete); a manual `spend` stores the category id +
  name snapshot on its history row. Since 2026-10-22 the HTTP
  `PATCH /finance/cashbox/spend` DTO REQUIRES `expense_category_id` (400
  «Xarajat kategoriyasini tanlang»), `comment` is optional; the
  `finance.cashbox.spend` RMQ handler still accepts no category (internal
  spends such as the investor profit payout).
- **Cashbox receipts (T3, 2026-10-30, migr `1716000000188`):** photo + AI
  check for manual expenses (`manual_expense`) and click courier → HQ /
  branch → HQ transfers (`courier_to_hq` / `branch_to_hq`).
  `cashbox-receipt/`: `CashboxReceiptService` (settings in `finance_settings`
  `receipt.{manual_expense,hq_transfer}.{photo_required,ai_enabled}`, SA-only
  update; draft upload; `linkInTx` inside the payment tx — `spendMoney`,
  `paymentsFromCourier`, `paymentFromBranchToMain` pass `receipt_policy` /
  `receipt_id`, injected via the `CASHBOX_RECEIPTS` token; `applyAiResult`,
  `requestReanalyze`, `summary`), hourly draft cleanup (24 h, advisory lock;
  linked receipts and files are never deleted), `receipt.rules.ts` (outcome
  + flags, pure), `cashbox-receipt.views.ts` (`RECEIPT_EXPECTED_SQL` — the
  single «no receipt» predicate shared by the history filter and the summary).
  Gateway uploads the photo to file-service (`cashbox-receipt-` key, signed
  300 s links), runs `ai.finance.receipt_extract` in the background and posts
  `finance.receipt.ai_result`; `ReceiptProjectionInterceptor` hides receipts
  from non SA/admin/manager roles. Realtime `finance.receipt.checked` (outbox).
  Coded errors in `libs/common/src/finance/cashbox-receipt.ts`
  (+ `PUBLIC_ERROR_CODES`). AI assistant tool `get_receipt_checks`. RMQ:
  `finance.receipt.{settings.get,settings.update,upload_check,create_draft,
  ai_result,reanalyze,get}`, `finance.receipt_checks.summary`.
  History `receipt` blocks are FAIL CLOSED: finance attaches them only when
  the gateway passes `include_receipts` (SA/admin/manager routes; never for
  courier/market cashboxes or `my-cashbox`). T6 `correctAmount` moves the
  receipt to the replacement legs in the same tx
  (`carryOverForCorrection`); reversed legs (`notReversedSql`) are out of
  «no receipt» and the summary. The gateway downsizes the photo (1568 px)
  before `ai.finance.receipt_extract`.

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
- **6tGZzupr (2026-10-30):** partner `items[]` accept `weight_kg`, `length_cm`,
  `width_cm`, `height_cm` (optional, `ShipmentItemDto`, L/W/H together).
  `resolvePartnerOrderItems`: with `external_product_id` the measures go to the
  auto-created product (`createCatalogProduct`, `system` requester) or, for an
  existing ref / same-name product, to `catalog.product.fill_missing_measure`
  (NULL fields only). Without measures the shipment is still accepted, the
  product stays `needs_measurement` and a warning is logged (price falls to the
  base tariff at sale). Measures without `external_product_id` are not stored
  (logged). Marketplace repo is separate: its `ElchiTariffInput` and checkout
  still send no measures — tracked outside this repo.

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
    (identity-service also emits `{cmd:'auth.sessions.kick'}` to the same queue
    since 2026-10-24 — see Sessions › Socket kick. finance-service since
    2026-10-25 via outbox, with `targets` `[{user_id}|{role}|{role,branch_id}]`
    → one socket.io emit to `user:` / `role:` / `branch:<id>:role:<role>` rooms;
    the gateway consumer runs with `noAck: false` — handlers ack manually.)
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
- **MH-3 (9fHyFp3y) + hY7uacJu (2026-10-24, migration `1716000000141`):**
  `products` gained `weight_kg numeric(10,3)`, `length_cm/width_cm/height_cm
  int`, `volumetric_enabled bool NOT NULL DEFAULT true`, `barcode
  varchar(512)` and `sku_code varchar(32)` — a STORED generated column
  `'ELC-P-' || lpad(id, GREATEST(6, len), '0')` (never written by the app;
  `UQ_products_sku_code`). All measure columns are NULLABLE (old / partner
  products); CHECKs: weight and each dimension `> 0`, L/W/H all-or-none,
  barcode not blank. `UQ_products_barcode_user_id (barcode, user_id) WHERE
  is_deleted = false AND barcode IS NOT NULL` — one code per market, reusable
  after soft delete, the same EAN allowed in different markets. Barcode rules
  live in `libs/common/src/catalog/product-code.ts`: EAN/UPC/GTIN check digit
  is enforced and GTINs are stored **canonical** (`canonicalGtin`: UPC-A 12 /
  GTIN-14 → 13-digit EAN form, GTIN-8 → 8, indicator GTIN-14 as is; GS1
  DataMatrix/QR → extracted GTIN); an 8-digit scan is EAN-8 or UPC-E
  (`0…` → UPC-E first, `1…` → GTIN-8 first; UPC-E is stored as its expanded
  UPC-A, `04963406` → `0049000006346`), and the UPC-E/EAN-8 ambiguity is
  covered by `productBarcodeEquivalents` in lookups and the duplicate
  check; free QR text kept verbatim; `ELC-P-…` rejected. Measure limits: `libs/common/src/catalog/product-measure.ts`
  (0.001..1000 kg, 1..1000 cm — owner not yet confirmed).
  - HTTP `POST /product`: the 4 measures are **required** (MH-S1, DTO
    `IsDefined`), multipart strings → numbers; `volumetric_enabled` /
    `barcode` optional. `PATCH /product/:id`: all optional, `null` / `''`
    measure → 400 (measures are only replaced). `PATCH /product/my/:id` was
    removed (Pc4CAFdB): product create/delete/update is staff-only
    (superadmin/admin/registrator/manager), market/market_operator read only.
    Service level (`catalog.product.create`) keeps measures optional —
    the `integration-service` partner path may create `{ name, user_id }`.
  - **6tGZzupr (2026-10-30, no migration):** `catalog.product.create` takes
    `{ dto, requester? }` (`remove` pattern). Gateway sends the HTTP user; the
    partner path sends `PRODUCT_SYSTEM_REQUESTER` (`{ id: 'system', roles:
    ['system'], via: 'partner:<id>' }`), so auto-created products are visible
    in `activity_log` (`user_role = 'system'`, `metadata.source`, `via`,
    `needs_measurement`). `market`/`market_operator` requester → 403; no
    requester still works (rolling deploy, `source: 'unknown'`).
    `needs_measurement` is **derived, not stored**
    (`productNeedsMeasurement`, same rule as the engine's `estimated`: no
    weight, or volumetric on and L/W/H missing) — returned on product rows and
    filterable: `GET /product?needs_measurement=true|false`
    (`catalog.product.find_all`); a registrator PATCH clears it. Legacy
    products without measures are included. New RMQ
    `catalog.product.fill_missing_measure { id, dto: { user_id, …measures },
    requester }` fills only NULL measures (a staff value is never replaced;
    other market → 403).
  - `update` and `update_own` use the same field whitelist (name, image_url,
    price, measures, barcode); `update_own` only adds the ownership check.
  - New RMQ `catalog.product.find_by_code {code, user_id?}` → `{data, total,
    matched_by: 'sku_code'|'barcode'|null}` (limit 50; not found → empty, not
    404). Gateway `GET /product/by-code/:code` (declared before `:id`,
    PRODUCT_DETAIL_ROLES): MARKET → own `sub` (other `market_id` → 403),
    MARKET_OPERATOR → assigned market (unassigned → 400), staff/BRANCH →
    optional `market_id`.
  - Search index: `tags` stay `['product']`; codes and measures go to
    `metadata` only (search-service does not scope catalog docs by market for
    unprivileged roles). `findAll` `search` also matches exact `sku_code` /
    canonical barcode.

- **Warehouse module (hY7uacJu, 2026-10-24, migration `1716000000143`)** —
  `apps/catalog-service/src/warehouse/` (registered inside
  `CatalogServiceModule`, not a separate Nest module — a second
  `ActivityLogModule.forService` would double the retention cron). Temporary
  until the marketplace: stock in pieces only, no cost/price.
  - Tables: `warehouses` (one per branch — partial UNIQUE `branch_id WHERE
    NOT is_deleted`; only an ACTIVE REGIONAL/HYBRID branch or the HQ —
    «Markaziy ombor» since Pa1KaXmj: no manager (`manager_user_id` → 400,
    default `null`), default name «Markaziy ombor»; views carry
    `kind: REGIONAL|HQ` derived from the branch, no column; `ACTIVE|PAUSED`,
    CHECK `paused_at` set iff PAUSED; `low_stock_default` 5),
    `warehouse_stock` (UNIQUE `(warehouse_id, product_id)`, `market_id` =
    products.user_id copy, CHECK `on_hand >= 0`, `0 <= reserved <= on_hand`,
    optional `low_stock_threshold`), `stock_movements` (APPEND-ONLY — BEFORE
    UPDATE/DELETE trigger raises 55000; `idempotency_key` UNIQUE; `qty` sign
    CHECK per type: IN/RETURN/MOVE_IN/RESERVE > 0, OUT/MOVE_OUT/RELEASE < 0,
    ADJUST ≠ 0; `on_hand_after`/`reserved_after` snapshot; `ref_type`
    stock_in|inventory|order|move), `stock_reservations` (order bandi:
    RESERVED → RELEASED | OUT → RETURNED, `returned_qty` for partial returns;
    partial UNIQUE `(order_id, product_id) WHERE status IN (RESERVED, OUT)`).
    identity: `admins.can_order_from_warehouse` (default false). The migration
    takes schema names in its constructor (defaults) so the pg spec runs in
    its own schema.
  - Locking (every write is one transaction): order ops take
    `pg_advisory_xact_lock(hashtextextended('catalog.warehouse.order:<id>'))`
    → warehouse row `FOR NO KEY UPDATE` (serialises with pause and other
    writes of that warehouse) → stock rows `FOR UPDATE` in `product_id`
    order → stock delta + movement row. Available = `on_hand − reserved`;
    level `out` (≤0) / `low` (≤ threshold ?? low_stock_default) / `ok`.
  - Admin/read RPCs (`@app/common` `WAREHOUSE_RPC`): `catalog.warehouse.
    {create, update, pause, resume, find_all, find_by_id, find_by_ids, stock,
    movements, lookup, stock_in, inventory, set_threshold, market_stock,
    availability}`. `scope: {branch_id}` (gateway, branch staff — see
    «Access» below) limits to the own branch (foreign → 404; empty/invalid
    scope → 403). Stock-in and
    inventory need an `idempotency_key` (gateway `Idempotency-Key`): same key
    + same lines → previous result `replayed: true`; same key + other lines →
    409 `WAREHOUSE_IDEMPOTENCY_CONFLICT`. Lines by `product_id` or scanner
    `code` (`ELC-P-…` sku_code / canonical barcode, same helpers as
    `catalog.product.find_by_code`); any unresolved/ambiguous/deleted/
    foreign-market line → 400, nothing written. Inventory `counted` is
    absolute, reason required, `counted < reserved` → 409. Binding a factory
    barcode stays `PATCH /product/:id { barcode }`.
  - Order RPCs (wired by order-service `OrderWarehouseService` since
    6kHnNH9j — see order-service «Warehouse fulfillment»; `out` / `release`
    also take `lenient: true` = no-op instead of 409, used by the outbox):
    `catalog.warehouse.resolve_source {region_id|district_id, items,
    market_id?, requester?}` → `{source: WAREHOUSE|HQ, reason, warehouse,
    items, shortages}` (read-only; district → `assigned_region ?? region_id`;
    first ACTIVE warehouse of a regional branch (REGIONAL/HYBRID — the HQ
    «Markaziy ombor» is never a candidate, even with a matching
    `region_id`) in that region with ALL items
    available; else HQ — reasons NO_ITEMS / NO_REGION / NO_WAREHOUSE /
    WAREHOUSE_PAUSED / INSUFFICIENT_STOCK / MARKET_NOT_ALLOWED (market or
    market operator creator and the market switch is off — fail-closed) /
    PRODUCT_INVALID); `reserve {order_id, warehouse_id, items, market_id?,
    actor?}` (all-or-nothing; 409 `WAREHOUSE_STOCK_INSUFFICIENT` +
    `shortages`, `WAREHOUSE_PAUSED`, `WAREHOUSE_ORDER_ALREADY_RESERVED`;
    same warehouse + same items again → `already: true`); `release
    {order_id}` (RESERVED → RELEASED; no reservation → `status: NONE`; OUT →
    409 `WAREHOUSE_ORDER_ALREADY_OUT`); `out {order_id}` (on_hand−, reserved−;
    RELEASED → 409 `WAREHOUSE_ORDER_RELEASED`); `return {order_id, items?,
    idempotency_key?}` (OUT → on_hand+ into the SAME warehouse; RESERVED rows
    are released; partial via `items`; repeat → `skipped`; several partial
    returns need distinct keys); `order_state {order_id}`. Repeats never
    change stock twice (state machine + unique movement keys; pg spec
    proves parallel reserves never oversell).
  - Activity log: `Warehouse` created/updated/status_change,
    `warehouse.stock_in`, `warehouse.inventory`, `WarehouseStock` updated
    (threshold). Order-driven movements are only in `stock_movements`.
  - New env (catalog): `RABBITMQ_BRANCH_QUEUE` (default `branch_queue`),
    `RABBITMQ_LOGISTICS_QUEUE` (default `logistics_queue`) — branch/region
    lookups (30 s in-memory branch cache; HQ id via `branch.find_hq` — found
    id cached for the process lifetime (HQ type is locked, single HQ),
    404/error → 30 s backoff, one shared in-flight request, warmed on
    module init; read paths incl. `find_by_ids` wait at most 500 ms).
  - Gateway `WarehouseGatewayController` — see FRONTEND_CHANGELOG
    2026-10-24 «Ombor moduli» for the HTTP list and roles.
  - **Access (XtcEyQjb, 2026-10-24, migration `1716000000152`):** read
    routes (`GET /warehouses`, `/:id`, `/:id/stock`, `/:id/movements`,
    `/:id/export`) — SUPERADMIN/ADMIN/REGISTRATOR unscoped
    (`WAREHOUSE_GLOBAL_READ_ROLES`); MANAGER/BRANCH/OPERATOR/LOGIST scoped to
    their branch (`branch.user.find_by_user`, fallback JWT `branch_id`, none
    → 403); COURIER/MARKET/MARKET_OPERATOR/CUSTOMER/INVESTOR → 403. Writes
    unchanged (SA/ADMIN). `stock_in` on a PAUSED warehouse → 409
    `WAREHOUSE_PAUSED` (checked under the warehouse row lock, after the
    idempotent replay check; inventory still allowed). Manager not given on
    create, or `manager_user_id: null` on update → first ACTIVE branch
    MANAGER by user id (`WarehouseDirectoryService.
    getFirstActiveBranchManagerId`: `branch_users` MANAGER rows whose
    identity user `status = active`), none → null; branch-service down → 503.
    identity: `admins.can_view_warehouse_stock` (default false) — the market
    toggles it per operator via `identity.market_operator.
    update_warehouse_access` (`PATCH /market-operators/:id/warehouse-access`,
    MARKET only, own operator else 404; activity log
    `identity.market_operator_warehouse_access_changed`); returned in the
    operator view (`GET /market-operators`) and in `identity.user.profile`
    for MARKET_OPERATOR. `GET /market/warehouse-stock` for MARKET_OPERATOR
    requires it (read from `identity.user.find_by_id`), else 403
    `WAREHOUSE_STOCK_FORBIDDEN`. Both codes are in `PUBLIC_ERROR_CODES`.

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

### file-service (MinIO + `file_schema`)
- `file.{upload,get_url,delete,exists,read,find_owner,generate_pdf,generate_qr}`.
  Signed URLs; size/TTL from env.
- **Ownership registry (dgvwZasd B, migr 193):** `file_schema.file_objects`
  (`key` PK, `folder`, `owner_id` varchar — user id or `system`, `owner_role`,
  `owner_branch_id`, `mime_type`, `size_bytes`, `created_at`). Written by
  `file.upload` only when the payload has `owner` (gateway JWT: `POST
  files/upload`, order sell/cancel proof, shift photo, cashbox receipt;
  `system`: shift report); catalog images and generated QR/PDF stay out.
  Row is removed by `file.delete`. A failed registry write never fails the
  upload (no row = legacy rule); `file.find_owner` DB error is an error, not
  "not found". Internal `file.read`/`file.exists` callers (Telegram DM, AI
  receipt/balance check, order proof check) are not gated by the registry.
- **Read rule** (`FileGatewayController.assertCanAccessPrivateKey`, `GET
  files/:key`, `GET files/:key/content`; gateway env
  `FILE_OWNERSHIP_ENFORCE`, default `off` = registry is write-only). With `on`
  a private-prefix key that has a row: SA/admin; the uploader; market/courier
  who is on the order (`order.proof_files`); branch staff (manager,
  registrator, branch, operator) when the order's `branch_id` /
  `holder_branch_id` / `home_branch_id` or the uploader's branch is theirs,
  or they are in the HQ branch. Registry lookup failure → 503, never the
  legacy rule. Key WITHOUT a row (files uploaded before migr 193) → legacy
  rule in both modes (role gate + order owner for market/courier). `GET
  files/signed/:token` is a bearer link and does not consult the registry;
  `shift-check-` / `shift-report-` / `cashbox-receipt-` via `GET files/:key`
  stay SA/admin only.

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
  (+ `order.settlement.retreat`, T6)
  retry forever at the 60 s backoff cap (other events still poison after
  `maxAttempts`, default 10). New `OutboxOptions`: `maxAttempts`,
  `persistentPatterns` (`[]` = old behaviour), `stuckAlertAttempts` (pending
  events with ≥10 attempts → error log every check, Sentry when the count
  changes). `OutboxService.requeueFailed({ids?, patterns?})` + inspect/replay
  SQL in `libs/common/src/outbox/README.md`.
- **`src/soft-delete`** — soft-delete base (deleted rows kept for audit).
- **`src/security`** — SSRF guard for outbound URLs from operator-supplied
  integration config (`INTEGRATION_ALLOW_PRIVATE_HOSTS` toggles private hosts).
  `assertPublicUrl` is the early check (config time + before each call);
  `fetchPinned` is the only outbound path: `redirect: 'error'` plus a shared
  undici `Agent` whose connect-time lookup (`createPinnedLookup`) validates
  every answer and hands exactly those IPs to the socket, so a DNS rebind
  between check and connect cannot reach an internal host (dgvwZasd B). URL is
  not rewritten: Host header, SNI and certificate check use the hostname.
  `undici` stays on the major bundled with Node (22 → 6.x): global `fetch` gets
  the `Agent` as `dispatcher`.
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

**Warehouse orders (6kHnNH9j):** `fulfillment_source = WAREHOUSE` orders skip
HQ intake and posts — created `received` at the regional warehouse branch
(stock reserved in catalog), assigned to a courier there (→ stock OUT), and a
cancelled parcel received back at that branch goes straight back into stock
and ends `returned_to_market` (holder MARKET) instead of the HQ return flow.
Money (settlement, cashboxes) and tariffs are unchanged. Details: order-service
«Warehouse fulfillment» above.

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
- **Special categories (T8, 2026-10-30, migr `1716000000187`):**
  `orders.special_categories varchar(32)[] NOT NULL DEFAULT '{}'` with a CHECK
  limited to `fragile, religious_book, liquid, perishable, battery, heavy,
  documents` (`OrderSpecialCategory` / `ORDER_SPECIAL_CATEGORIES` /
  `normalizeSpecialCategories` in `libs/common/enums`; canonical order, unknown
  or duplicate code → 400 «Noma'lum maxsus belgi: <kod>»). Set at create
  (`POST /orders`, `/orders/external`, ai-confirm per order; `create()` also
  validates bot/partner payloads, missing → `[]`); a partly-sold cancelled
  child inherits the parent's set, a replacement order does not. PATCH DTOs
  do not carry the field (400) and `update_full` ignores it. Changes go only
  through `PUT /orders/:id/special-categories` → `order.special_categories.set`
  (`OrderLifecycleService.setSpecialCategories`): same roles as POST /orders;
  scope in the gateway (market own, market_operator its market — none → 403,
  REGISTRATOR/MANAGER/BRANCH own branch triple), market ownership re-checked
  under FOR UPDATE; lock (`libs/common/src/order/order-special-categories.ts`):
  market side `created`/`new`, staff also `received`, `on the road`,
  `waiting`, `waiting_customer`, `cancelled`, `cancelled (sent)`; terminal
  statuses → 409 `SPECIAL_CATEGORIES_LOCKED`. Unchanged set → `changed:false`
  with no tracking/journal; otherwise `order_tracking` `action:
  special_categories_changed` (from = to = current status, old/new
  `{special_categories}`) + activity verb `order.special_categories_changed`.
  The column is in the scan light view (`ORDER_SCAN_LIGHT_SELECT`), the scan
  summaries (`order.summary_by_ids` → `ScanOrderSummaryRef`: post `POST-` and
  batch `BTB-`/`BTR-` scans) and `POST /orders/scan-assign` `data.order`.
  `updateFull` never writes it (dropped before `save()`, so a stale PATCH read
  cannot overwrite a concurrent PUT); a partly-sold child takes the set from the
  row locked by `lockWaitingOrder`. Analytics cancel counts
  (`historicallyCancelledTrackingQuery`, courier report `canceled`) skip
  tracking rows with `from_status = to_status` (status-less edits on a
  cancelled order). Migration: CHECK `NOT VALID`, `lock_timeout` 5 s inside
  the block.
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
  - target `cancelled` / `cancelled_sent` from SOLD/PAID/PARTLY_PAID/CLOSED
    (y2RarzlT, 2026-10-23): these edges live only in
    `ORDER_ROLLBACK_EXTRA_TRANSITIONS` (`isValidRollbackStatusTransition`,
    used when `rollbackOrderToWaiting` calls `updateFull(..., { rollback:
    true })`); the general machine still forbids sold → cancelled for PATCH /
    finance / sell paths. Money is unwound exactly like the `waiting` target;
    `enqueueFinanceOnStatusChange` treats sold-state → CANCELLED as leaving the
    sale (operator earning removed, sell profit reversed). An invalid
    transition now answers 400 «Buyurtma holatini o'zgartirib bo'lmaydi: a -> b».

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
  Managers do **not** push to HQ (owner re-confirmed 2026-10-25, IjqTYQks): the
  gateway route is `@Roles(SUPERADMIN, ADMIN)` and the handler rejects any
  non-HQ caller with 403 `BRANCH_TO_MAIN_HQ_ONLY_MESSAGE`; the FE removed the
  manager's "HQ'ga o'tkazish" button/form (read-only HQ cashbox page).

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
  was always empty/erroring; CODE-21). `GET /branches/hq` (Pa1KaXmj,
  SUPERADMIN/ADMIN) is also before `:id`: `branch.find_hq` projected to
  `{id, name, code, type, status, address, region_id, region}` (no money
  fields; region via `branch.find_by_id`, best-effort) — the «Markaziy ombor»
  option of the warehouse-create dialog. An older gateway without this route
  answers 400 (`:id` + `ParseBigintIdPipe`), so FE treats 400/404 as «no HQ».

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
  (`AUTH_REFRESH_THROTTLE_*`) — fix3 RBAC-11. `POST /csp-report` — 30/min/IP
  (KwodkKWY, `CSP_REPORT_THROTTLE`).
- **Idempotency / outbox / activity-log / soft-delete:** available in
  `libs/common` — use for money ops and audit-sensitive writes.
- **Validation:** gateway `ValidationPipe` is `whitelist + forbidNonWhitelisted`
  → unknown body fields are rejected (400).

---

## 7. Infra, config & ops

- **docker-compose.prod.yml** services: `rabbitmq`, `postgres`, `minio`,
  `migration-runner`, `api-gateway`, `cloudflared`, + all 13 other services.
  Volumes: `rabbitmq_data`, `postgres_data`, `minio_data`.
- **Konteyner qotirish (qUEE0Bgd):** servis image'lari `USER node` (fayllar
  root'niki, `/app` ga yozilmaydi — ilova diskka yozmasligi kerak, kerak bo'lsa
  faqat `/tmp`). Compose: `x-hardening` (`no-new-privileges`, `cap_drop: ALL`) app
  servislari, cloudflared va ops sidecar'lariga; `x-backup-hardening`
  (+ `DAC_OVERRIDE`, `DAC_READ_SEARCH`) `db-backup` / `backup-offsite` ga — ular
  root qoladi, chunki `backups/` dagi dump'lar 0600 va turli egalarniki.
  postgres/rabbitmq/minio ta'rifiga hardening qo'shilmagan (entrypoint root'da
  ishlaydi; ta'rif o'zgarsa deploy qayta yaratadi).
- **Ops sidecar'lari (qUEE0Bgd):** `migration-runner`, `db-reconcile`,
  `activity-log-prune` — `Dockerfile.ops` (kod + dev deps image ichida, repo
  bind-mount va ishga tushishdagi `npm ci` yo'q). Kod image'da bo'lgani uchun
  `deploy.yml` ishlayotgan sidecar'larni har deploy'da yangilaydi; ularni o'zi
  yoqmaydi.
- **Image'lar (qUEE0Bgd):** rabbitmq va cloudflared — tag + digest. rabbitmq
  deploy'da `--no-recreate`: qayta yaratilsa broker foydalanuvchilari yo'qoladi
  (`docs/ops/secret-rotation.md` §3). minio — `pull_policy: never`
  (`minio/minio` Docker Hub'da 404, digest'ga o'tish uchun serverdagi image
  tekshirilishi kerak), postgres — `pull_policy: missing`.
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
| CSP violation reports (`POST /csp-report`, @Public, log-only `event: csp_violation`) | `apps/api-gateway/src/csp-report/` |
| All enums / state machines | `libs/common/enums/index.ts` |
| Env contracts (Joi) | `libs/common/src/config/index.ts` |
| Delivery price formula (pure) / tariffs | `libs/common/src/pricing/delivery-pricing.ts` / `apps/logistics-service/src/delivery-pricing/` |
| Warehouse (stock, reservations, RPCs) | `libs/common/src/catalog/warehouse.ts` / `apps/catalog-service/src/warehouse/` / `apps/api-gateway/src/warehouse-gateway.controller.ts` |
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
- **analytics-service** has **no database** (aggregator). **file-service** keeps
  objects in MinIO; its only table is the ownership registry (`file_schema`).
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
- **fix3 residuals / open decisions:** ~~decision #7 is enforced only by the FE~~
  — enforced by the gateway since 2026-10-25 (IjqTYQks); ~~one refresh session per
  account (RBAC-10)~~ — resolved by Elchi Pochta #3 (per-login sessions,
  2026-10-21); courier assignment is last-write-wins (CODE-25, needs a
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
