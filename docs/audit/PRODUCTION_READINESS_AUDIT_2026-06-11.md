# Production-Readiness Audit — Elchi Backend + Frontend

> **Sana:** 2026-06-11 · **Usul:** 11 ta mutaxassis agent (backend 9 + frontend 2) parallel audit, har bir P0/P1 topilma adversarial verifier bilan tasdiqlangan. 43 agent, ~2.4M token.
> **Manba:** ko'p-agentli `elchi-fullstack-audit` workflow. Coverage: `docs/frontend/COVERAGE_REPORT.md` (241 endpoint).

## Yakuniy verdict

- **Tayyorlik bahosi:** **48/100**
- **Go / No-Go:** **NO-GO**

> NOT production-ready as-is for a real-money COD business. The system is architecturally strong and the order-driven money model is well-designed, but there are multiple verified, independent P0 defects spanning money-integrity (non-atomic rollback, no order-row locking, non-idempotent manual cashbox transfers), security (mass PII/financial leak via unscoped global search, IDOR on order-by-id, webhook HMAC secret leaked in plaintext via admin API, no JWT secret-strength validation), and operations (no database backups, single-host SPOF). Each is a concrete, source-verified ship-blocker. Once the listed P0s and the feature-blocking P1s are fixed, this is a go-with-conditions.

### Executive summary

Elchi's backend is more mature than typical for its stage: amounts are exact numeric, the 3-leg COD model is internally consistent between sell and rollback, tariffs/shares are snapshotted at sale time, the transactional outbox + idempotent cashbox consumer (UNIQUE dedup index) are correct, DLQ topology with smart-nack exists, RBAC is enforced per-route on money endpoints, JWT refresh-rotation with reuse-detection is solid, and the SSRF guard + inbound webhook HMAC verification are genuinely well-built. TypeScript is strict and the test suite is green (253/253).

However, deploying today WILL cause business problems. Eleven specialist audits plus adversarial verification surfaced a cluster of CONFIRMED P0s that each independently corrupt money or breach data: (1) order rollback is the one money op that is NOT transactional and re-uses a fresh dedup epoch, so a mid-rollback crash or operator retry double-reverses cashboxes or leaves an order SOLD with money already reversed; (2) no order row is ever locked, so concurrent sell/cancel/rollback double-applies cashbox legs (each attempt mints its own epoch, defeating dedup); (3) the three manual cashbox transfer handlers (courier/branch/market payments) write history rows with NO source_id/dedup_epoch, so an RMQ redelivery or operator double-submit moves real cash twice; (4) GET /search has zero tenant/role scoping over an index containing staff phone numbers, customer addresses and per-order prices — any logged-in account (even a customer) can harvest it; (5) GET /orders/:id is IDOR-open with sequential bigint ids; (6) the webhook HMAC secret is stored in plaintext AND leaked verbatim in admin GET responses; (7) JWT/superadmin secrets have no strength validation and .env.example ships guessable defaults; (8) there is no database backup or HA — a bad migration or disk loss is unrecoverable.

On the question "are all backend functions wired and usable from the frontend": path coverage is high and the core money flows are wired correctly, but three real gaps exist — the COD settlement screen reads response fields the backend never returns (operators always see "Qoldiq: 0", hiding un-applied cash), the shared dashboard fires admin-only analytics for 4 non-admin roles (broken landing page on every login), and the entire in-app notification inbox + activity-log audit viewer are unwired (the built backend engines are invisible to users).

Net: the foundations are good and the fixes are well-scoped, but the confirmed P0s are exactly the failure modes that lose cash and leak customer data, so this is a no-go until they are closed.

---

## 🔴 P0 — Ishga tushirishni bloklovchi (deploydan oldin SHART)

### P0-1. rollbackOrderToWaiting is not transactional and uses a fresh per-call dedup epoch
**Soha:** order-core / money

**Biznes ta'siri:** A mid-rollback crash or transient DB error leaves cashboxes reversed while the order stays SOLD (permanent split state), or an operator/RMQ retry re-applies all reversals with a new epoch that finance does not dedupe — double money reversal across courier/market/branch/MAIN cashboxes. Direct, hard-to-detect cash corruption on every rollback that hits an error.

**Yechim:** Wrap the whole rollback in one queryRunner transaction exactly like sell/cancel: pass tx into pay()/updateCashboxBalance (as the outbox manager), into resetSettlementOnRollback, and into every updateFull. Derive a single stable dedup_epoch from request_id (not Date.now()) so retries reuse the same epoch and dedupe. Move activity-log/external-sync to after commit.

### P0-2. No row locking on orders — concurrent money ops double-apply cashbox movements
**Soha:** order-core / money

**Biznes ta'siri:** Two concurrent sells (double-tap, or courier+manager acting together), or a sell racing a cancel/rollback, both pass the status==WAITING TOCTOU check and both post cashbox legs. Each attempt mints its own saleEpoch, so the dedup index does NOT collapse them — market/courier/branch/MAIN balances are credited/adjusted twice. Recurring cash discrepancies in a courier app where double-taps are common.

**Yechim:** Load the order with pessimistic_write (SELECT ... FOR UPDATE) at the start of each money op's transaction and re-assert status==WAITING inside the transaction before posting any cashbox movement. Apply to sell, cancel, partly-sell, rollback and settlement. Alternatively add an @VersionColumn and retry on mismatch.

### P0-3. Manual cashbox transfers (courier/branch/market payments) are non-idempotent
**Soha:** finance-money

**Biznes ta'siri:** paymentsFromCourier / paymentFromBranchToMain / paymentsToMarket write CashboxHistory rows with no source_id and no dedup_epoch, so they fall outside the partial-unique idempotency index and have no pre-check. An RMQ redelivery (worker crash/ack timeout/requeue-once on transient error) or an operator double-submit runs the entire transfer twice — courier debited twice, HQ main credited twice, or a market paid twice. These are the lump-sum reconciliation transfers for physically-collected COD cash.

**Yechim:** Give these the same idempotency contract as updateBalance: accept a client-supplied source_id (payment UUID) + dedup_epoch, write them on every history row, and inside the FOR UPDATE-locked transaction short-circuit if a matching row exists. Or route each leg through updateBalance. Move syncMarketPaymentsSafely/activity-log after ack or make them idempotent.

### P0-4. Global GET /search leaks cross-tenant PII and order financials to any authenticated user
**Soha:** misc-services / search

**Biznes ta'siri:** GET /search is guarded only by JwtAuthGuard (no role or tenant scoping) over an index containing every user's phone_number/username, every customer's delivery address, customer_id, market_id and per-order total_price. Any low-privilege account — courier, market, registrator, even a customer — can issue e.g. ?source=identity or ?source=order and harvest all staff phones and all customer addresses/prices company-wide. Mass PII/regulatory breach plus competitive-data leak.

**Yechim:** Pass requester {id, roles} into search.query; restrict source=identity/order to SUPERADMIN/ADMIN; force metadata.market_id==requester for markets and metadata.courier_id==requester for couriers; strip content/metadata from the public projection (return only id/title/type/sourceId), never phone/address/price.

### P0-5. IDOR: any authenticated user can read any order by sequential id (financials + customer PII)
**Soha:** auth-rbac / gateway

**Biznes ta'siri:** GET /orders/:id (and /orders/:id/tracking, /orders/market/:marketId, /orders/markets/:marketId/new) is guarded only by JwtAuthGuard with no @Roles and forwards only {id} with no requester scoping. Order ids are sequential bigints, so any market/courier/customer can enumerate and read every order's total_price/tariffs/shares and customer name/phone/address. Customer PII + competitor pricing breach.

**Yechim:** Add RolesGuard + @Roles, forward requester {id, roles, branch_id}, and enforce object-level scoping in the service: market sees only own orders, courier only assigned orders, branch/manager only their branch, admin/superadmin unrestricted; 403/404 otherwise. Mirror the existing GET /orders list-scoping.

### P0-6. Webhook HMAC secret stored in plaintext and leaked verbatim via admin read API
**Soha:** integration-webhooks

**Biznes ta'siri:** sanitizeIntegrationRow strips api_key/api_secret/password but NOT webhook_secret/webhook_secret_previous, so GET /integrations(/:id) returns the plaintext HMAC secret to any SUPERADMIN/ADMIN (and into any captured API response). The secret is never encrypted on write despite the entity's 'AES-encrypted at rest' contract. Since POST /webhooks/:slug is JWT-unauthenticated and HMAC is its only auth, the leaked secret lets an attacker forge signed webhooks that force arbitrary orders to SOLD/CANCELLED/CLOSED (feeding P&L/settlement reconciliation).

**Yechim:** In sanitizeIntegrationRow add delete safe.webhook_secret and delete safe.webhook_secret_previous; encrypt webhook_secret/_previous via encryptCredential on every create/update; add a test asserting the secret is absent from sanitized output. Migrate any existing plaintext rows.

### P0-7. JWT/superadmin signing secrets have no strength validation; placeholder defaults boot in production
**Soha:** infra-ops

**Biznes ta'siri:** The weak-secret validator + min(32) is applied ONLY to INTEGRATION_CREDENTIAL_SECRET. ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, SUPERADMIN_PASSWORD and MINIO_SECRET_KEY are plain required() with no entropy check, and .env.example ships change_me_access / change_me_refresh / superadmin123. A weak ACCESS_TOKEN_KEY lets an attacker forge a JWT for any role including superadmin (the strategy trusts {sub, roles} with no DB re-check) — full takeover of orders/cashboxes/ledger; superadmin123 surviving to prod is immediate account takeover.

**Yechim:** Apply rejectWeakSecret + min(32) to ACCESS_TOKEN_KEY and REFRESH_TOKEN_KEY in both gateway and identity schemas; add a length/entropy check to SUPERADMIN_PASSWORD and MINIO_SECRET_KEY; replace .env.example placeholders with clearly-invalid sentinels so boot fails fast on a weak auth key.

### P0-8. No automated database backup; single Postgres + single RabbitMQ are SPOFs with no recovery point
**Soha:** infra-ops

**Biznes ta'siri:** Nothing in the repo runs pg_dump/WAL archiving/replication; the only 'backup' copies the .env file. All 11 schemas (orders, cashboxes, ledger) live on one container volume and the deploy runs migrations against the live volume with no pre-migration dump and no rollback. A bad migration, disk failure, accidental volume removal or corruption means total, unrecoverable loss of all money data — the single highest data-loss risk.

**Yechim:** Add automated logical dumps (or pgBackRest/WAL-G with PITR) pushed off-box (MinIO/S3 with versioning), add a pre-migration pg_dump step in the deploy workflow, and document+test restore. Move Postgres/RabbitMQ off the app host and add streaming replication before scaling money volume.

---

## 🟠 P1 — Jiddiy risklar (tezda tuzatilishi kerak)

### P1-1. Frontend settlement screen reads non-existent response fields — shows wrong money data
**Soha:** fe-coverage

**Ta'sir:** The COD settlement page reads result.allocations and result.remaining, but the backend returns an envelope {data:{settled_order_ids, allocated, leftover}}. Both are always undefined, so after a real lump-sum settlement the panel always shows 'Qoldiq: 0 so'm · 0 ta buyurtmaga taqsimlandi' and the allocation table never renders — operators get false confirmation that nothing remains un-applied, on a screen that moves real cash. A unit test masks this with a fabricated response.

**Yechim:** Unwrap the envelope (read res.data.data) and map real fields: render settled_order_ids.length and leftover; add per-order amounts to the backend payload if the table needs them. Add a shared envelope-unwrap helper. Fix the misleading test.

### P1-2. Shared DashboardPage fires admin-only /analytics/kpi and /analytics/revenue for non-admin roles → 403
**Soha:** fe-coverage

**Ta'sir:** After the analytics admin-only hardening, registrator/courier/branch/investor fall through to the shared DashboardPage which unconditionally calls KPI and revenue (now @Roles SUPERADMIN/ADMIN). They get 403 and the stats + financial blocks render error/retry panels on every login — the primary landing page is broken for four real roles.

**Yechim:** Gate KPI/revenue/report queries with enabled: widgets.stats && isAdmin (role superadmin/admin), or route non-admin roles to a role-appropriate dashboard. analytics.dashboard itself is role-aware and works, so only the admin-only calls need gating.

### P1-3. Frontend order money mutations never invalidate cashbox/finance caches — stale balances after a sale
**Soha:** fe-quality

**Ta'sir:** Sell/cancel/rollback/partly-sell only invalidate ['orders']; the cashbox/finance cache is a separate key space with 30s staleTime and refetchOnWindowFocus:false. A courier who records a sale then opens their cashbox sees the OLD balance for up to 30s (and vice-versa for payments vs order status). In a COD cash business this drives double-handling and disputed settlements.

**Yechim:** Cross-invalidate: after order money mutations also invalidate ['cashbox'], 'finance-cov', 'markets', 'couriers', 'branches' (reuse payments' refreshCashboxQueries); have payment mutations invalidate ['orders'].

### P1-4. Courier assignment race — same order assignable to two couriers (no lock / optimistic version)
**Soha:** branch-logistics

**Ta'sir:** Both scan-assign and bulk-assign read the order, check courier_id is empty, then update via a non-atomic findById→save with no version column or conditional WHERE. Two couriers scanning the same parcel, or a bulk-assign racing a scan, both pass the guard and last-write-wins. Two couriers can hold the same COD order; settlement/earnings/cashbox get attributed to the wrong courier.

**Yechim:** Add an atomic order.assign_courier doing UPDATE ... WHERE id=:id AND (courier_id IS NULL OR courier_id=:c) AND status IN (...) and treat 0 rows as 409, or add @VersionColumn and retry on mismatch.

### P1-5. PARTNER branch ownership / per_order_share can never be set — partner settlement computes wrong money
**Soha:** branch-logistics

**Ta'sir:** resolveBranchShare returns 0 unless branch.ownership==PARTNER, but neither createBranch nor updateBranch ever writes ownership or per_order_share, and there is no route/pattern to set them. Every branch is permanently OWNED with share 0, so onboarding a franchise/partner branch silently forces 100% COD remittance to HQ and never withholds the partner's agreed share — a growing money discrepancy.

**Yechim:** Add ownership (enum) and per_order_share (numeric>=0) to create/update branch DTOs and gateway swagger, validate them, and persist them. Add a test that a PARTNER branch with per_order_share>0 yields branchShare>0.

### P1-6. Auth endpoints have no RMQ timeout — a slow/down identity-service hangs the gateway
**Soha:** gateway

**Ta'sir:** login/refresh/logout/validate/myProfile call identity over RMQ with no .pipe(timeout()) and there is no global timeout interceptor. If identity is down or a reply is lost, these requests never resolve and hold sockets until Cloudflare 524 kills them. Login is the highest-traffic unauthenticated path, so a hiccup can exhaust connections and degrade the whole shared gateway.

**Yechim:** Wrap every identity call in .pipe(timeout(8000)) mapping TimeoutError→GatewayTimeoutException (the pattern already used elsewhere), or route all gateway→RMQ calls through the shared rmqSend helper so timeout+retry can't be forgotten.

### P1-7. Public GET /files/view/:key serves every bucket object, including private proof media
**Soha:** gateway / misc-services

**Ta'sir:** The endpoint is intentionally public (for browser <img> product images) but reads ANY MinIO key with no folder/ownership restriction. COD expense-proof photos/videos and order-evidence keys (returned in authenticated order responses) are served to anyone holding a leaked key, with no audit and no revocation short of deleting the object.

**Yechim:** Restrict the public route to a safe public prefix (products-/qr-/pdf-) and reject other keys, or serve product images from a dedicated public bucket while keeping proof media behind the authenticated signed-URL flow. Validate the key prefix before calling file.read; add the missing timeout.

### P1-8. Analytics leaks courier earnings and company profit to roles outside the admin-only fix
**Soha:** misc-services / analytics

**Ta'sir:** GET /analytics/reports/couriers (JwtAuthGuard only) returns every courier's totalAmount/salaryEstimate/profit + ranking to any role including markets/customers; GET /analytics/dashboard returns company-wide gross-margin profit and top markets/couriers to BRANCH and MANAGER roles (only REGISTRATOR is stripped). HR/financial data leak and a partial regression of the prior analytics-leak fix.

**Yechim:** Lock /reports/couriers to SUPERADMIN/ADMIN (+COURIER self-only) and call assertFinancialAccess for non-courier callers; strip profit and company-wide rankings for all non-(SUPERADMIN/ADMIN) roles in getDashboard, returning only branch-scoped data to branch/manager.

### P1-9. Two gateway endpoints are 100% broken — DTOs have no validation decorators
**Soha:** gateway

**Ta'sir:** ReceiveExternalOrdersDto (POST /orders/external/receive) and PrintOrdersDto (POST /printer/thermal-pdf, /receipt) have zero class-validator decorators; under whitelist+forbidNonWhitelisted the ValidationPipe 400s every request before the handler runs. External provider order ingestion and all label/receipt printing are non-functional — the features appear wired but never work.

**Yechim:** Add proper decorators (@IsString/@IsArray/@ArrayNotEmpty/@IsString({each:true})) to both DTOs and add e2e smoke tests asserting a valid body returns 2xx.

### P1-10. Investor calculateProfit creates duplicate profit-share rows — no period dedup
**Soha:** finance-money / investor

**Ta'sir:** calculateProfit blind-inserts a profit-share per active investor every call with no uniqueness on (investor_id, period_start, period_end) and no existing-period check. A double-click/retry/re-run produces a full second set of obligations; findAllProfits totals inflate and an operator can pay an investor twice for one period — real money out to capital partners.

**Yechim:** Add a partial unique constraint on (investor_id, period_start, period_end) WHERE not deleted and make calculateProfit upsert/skip-existing or refuse when a non-deleted share overlaps the period; return a clear 'already calculated' response.

### P1-11. Outbound provider fetches have no request timeout; sync worker can wedge while holding the advisory lock
**Soha:** integration-webhooks

**Ta'sir:** executeExternalRequest and loginAndGetToken call fetch with no AbortSignal (the accepted timeout_ms is never applied). A slow/malicious provider stalls the call while processPendingSyncQueue holds the session advisory lock, blocking ALL sync-queue processing across the deployment until restart; enqueueSync runs inline so it can also stall the enqueue RPC.

**Yechim:** Apply signal: AbortSignal.timeout(timeout_ms ?? sane-default) to both fetches; honor the queue processor's timeout_ms; stop running processPendingSyncQueue inline inside enqueueSync.

### P1-12. No DLQ/outbox-poison monitoring; failed money messages park silently
**Soha:** libs-common / infra-ops

**Ta'sir:** DLQs are created but never consumed/monitored, and outbox events that exhaust ~6 min of retries flip to status='failed' with no alert. During a finance-service incident >~6 min, sales commit as SOLD but the cashbox credit is never applied and nobody is paged. Sentry is off by default (no SENTRY_DSN). Discovery happens only when a courier/market complains.

**Yechim:** Require SENTRY_DSN in prod and capture on markFailed and on every DLQ send; add a DLQ-depth monitor/alert (>0 on finance/order queues is P1) and a replay path; add a reconciliation that flags committed SOLD orders whose FINANCE outbox event isn't 'published'; raise outbox maxAttempts/backoff so transient outages don't poison.

---

## 📡 Frontend ↔ Backend coverage (funksiyalar to'liq ulanganmi?)

Things the business CANNOT do or does INCORRECTLY from the frontend: (1) COD settlement confirmation is wrong — the settlement screen reads result.allocations/result.remaining which the backend never returns, so operators always see 'Qoldiq: 0, 0 orders allocated' and the allocation table never renders, hiding un-applied cash on a real-cash reconciliation tool. (2) Four non-admin roles (registrator, courier, branch, investor) get a broken dashboard on every login because the shared DashboardPage fires admin-only /analytics/kpi and /analytics/revenue (403 → error panels). (3) Setting a branch as a PARTNER with a per-order revenue share is impossible from any UI/API — the columns are never written, so partner-branch settlement silently computes wrong money. (4) The entire in-app notification inbox + realtime push subsystem is unwired (all 7 inbox endpoints have zero frontend references; no socket.io-client; the 'notifications' page is Telegram-config only) — users never receive in-app/realtime business alerts. (5) The activity-log audit viewer is unwired (4 admin endpoints, ~96 audited ops, no API entry or UI; the '/logs' page is a refresh-token test stub) — admins cannot review who sold/cancelled/settled an order or moved cashbox money without direct DB access. (6) External provider order ingestion (POST /orders/external/receive) and all label/receipt printing (POST /printer/thermal-pdf, /receipt) 400 on every request due to decorator-less DTOs, so those features are wired but non-functional. (7) Order money actions don't invalidate cashbox/finance caches, so balances/statuses shown right after a sale are stale for up to 30s. Aside from these, path-level coverage is high and the core sell/cancel/partly-sell, finance payment, and transfer-batch flows are wired correctly with matching shapes and RBAC.

---

## ✅ Eng yuqori-ta'sirli yaxshilanishlar (tartib bo'yicha)

1. Make order rollback transactional with a stable request-derived dedup epoch, and add pessimistic FOR UPDATE row locks (with in-transaction WAITING re-check) to all order money ops and FIFO settlement candidate selection — closes the two confirmed money-corruption P0s.
2. Give the three manual cashbox transfer handlers the same idempotency contract as updateBalance (client source_id + dedup_epoch, in-lock pre-check) so RMQ redelivery/double-submit cannot move cash twice.
3. Lock down read-side data exposure: scope GET /search by requester role/tenant and strip PII/financials from its projection; add RolesGuard + requester scoping to GET /orders/:id and siblings; lock /analytics/reports/couriers and strip profit from branch/manager dashboards.
4. Fix credential hygiene: strip and encrypt webhook_secret, and apply min(32)+rejectWeakSecret to ACCESS_TOKEN_KEY/REFRESH_TOKEN_KEY/SUPERADMIN_PASSWORD/MINIO_SECRET_KEY with failing .env.example sentinels so weak/default secrets cannot boot.
5. Add automated off-box Postgres backups + a pre-migration dump in the deploy pipeline, and split Postgres/RabbitMQ off the app host — removing the single largest unrecoverable-data-loss risk.
6. Wire production observability: require SENTRY_DSN, add DLQ-depth and outbox-poison alerting plus a reconciliation for committed-SOLD-but-unpublished finance events, and add a prune/retention cron for idempotency_keys/outbox_events/activity_logs.
7. Fix the frontend ship-blockers: correct the settlement envelope/field mapping, gate admin-only analytics in the shared dashboard, cross-invalidate cashbox/finance caches on order money mutations, and add validation decorators to the two broken DTOs.
8. Add request timeouts everywhere they're missing (gateway auth RMQ sends, outbound provider fetches) to prevent hung-connection/sync-pipeline outages.
9. Make the build/deploy gate the full money/auth/settlement/webhook/RBAC test suite (currently green but non-blocking) and add missing hot-path indexes on orders.status and orders.qr_code_token.

---

## 💪 Kuchli tomonlari (yaxshi qurilgan)

1. Order-driven money model is genuinely well-designed: exact numeric(14,2), an internally-consistent 3-leg COD model between sell and rollback, tariffs/shares snapshotted at sale time, and sell/cancel/partly-sell wrapping all cashbox enqueues + status flip in a single DB transaction with per-attempt dedup epochs.
2. Cashbox update_balance is hardened correctly: FOR UPDATE row lock + a partial-unique idempotency index (cashbox+source_type+source_id+operation_type+dedup_epoch), so outbox double-delivery cannot double-credit; SELL_PROFIT uses a pg advisory lock and dedupes on (source_type, order_id); operator earnings dedupe on UNIQUE(order_id).
3. Reliability backbone is production-grade at the primitive level: every service sets up DLQ topology at startup, executeAndAck uses a smart nack (RpcException→DLQ, transient→requeue-once-then-DLQ) rather than blind drop, and the transactional outbox is correctly enrolled in the caller's DB transaction.
4. Auth primitives are strong: JWT secrets required via getOrThrow, bcrypt(10), refresh-token rotation with SHA-256 storage and reuse-detection that invalidates the session, httpOnly/secure/sameSite cookies, per-IP login throttling, failed-login audit, and lowercase role normalization on both strategy and guard.
5. Security building blocks are well-built where present: the SSRF guard resolves DNS and blocks private/loopback/link-local/metadata/CGNAT/IPv4-mapped ranges and fails closed; inbound webhook HMAC verification is constant-time, length-checked, raw-body-based, with DB-backed replay protection and key-rotation support.
6. file-service and the notification inbox are well-hardened (magic-byte MIME validation, per-type size caps, signed-URL TTL bounds, OOM guards, strictly server-side recipient scoping).
7. Frontend auth layer is solid: refresh-on-401 is single-flighted, login/refresh excluded from retry to avoid loops, clean logout-on-refresh-fail, a logout/refresh race guard, TypeScript strict mode on with a clean tsc and a green 253-test suite.
8. Engineering maturity signals: structured pino logging with trace correlation, a thorough money-migration safety harness (cashbox-invariant snapshot/compare), reasonably complete foreign-key indexing, and a detailed maintained BACKEND_MAP as a single source of truth.

---

## 🛠️ REMEDIATION — 2026-06-11 (shu kungi tuzatishlar)

Audit topilmalari bo'yicha quyidagilar **kod-tomondan tuzatildi va testdan o'tkazildi** (backend **257/257** jest yashil, frontend **89/89** vitest yashil, ikkala repo prod-typecheck toza).

### P0 — barchasi yopildi (8/8)
| # | Tuzatish | Fayl(lar) |
|---|---|---|
| P0-1 | Rollback endi bitta tranzaksiyada (cashbox reversal + settlement reset + status flip atomik) | `order-service.service.ts rollbackOrderToWaiting` |
| P0-2 | Sell/cancel/partly/rollback'da `FOR UPDATE` row-lock + tx-ichida status qayta-tekshirish (concurrent race + RMQ redelivery yopildi) | `order-service.service.ts lockWaitingOrder` |
| P0-3 | Manual cashbox transferlar idempotent (gateway per-request `dedup_epoch` token + finance pre-check) | `finance-service.service.ts`, `finance-gateway.controller.ts` |
| P0-4 | `GET /search` role/tenant scoping + non-privileged uchun PII/metadata strip | `search-service.service.ts`, `search-gateway.controller.ts` |
| P0-5 | `GET /orders/:id` + tracking + market routelarida object-level authorization (IDOR yopildi) | `order-gateway.controller.ts assertCanViewOrder` |
| P0-6 | `webhook_secret`/`_previous` sanitize javoblaridan strip qilindi (faqat `has_webhook_secret` qaytadi) | `integration-service.service.ts` |
| P0-7 | ACCESS/REFRESH_TOKEN_KEY/SUPERADMIN_PASSWORD/MINIO_SECRET_KEY kuchlilik validatsiyasi + `.env.example` fail-fast sentinellar | `libs/common/src/config/index.ts`, `.env.example` |
| P0-8 | `scripts/backup-db.sh` + `scripts/pre-migration-backup.sh` + `npm run db:backup` / `migration:run:safe` | `scripts/` |

### P1 — tuzatilganlar
- **P1-1** Settlement ekrani to'g'ri envelope o'qiydi (`settled_order_ids`/`allocated`/`leftover`) — "Qoldiq: 0" bug yo'q.
- **P1-2** DashboardPage KPI/revenue'ni faqat admin uchun chaqiradi (4 non-admin rolда 403 yo'q).
- **P1-3** Order money mutationlari `finance-cov`/`cashbox`/`dashboard` cache'ini ham invalidate qiladi.
- **P1-6** Auth gateway RMQ chaqiruvlariga 8s timeout (identity down → 504, hang yo'q).
- **P1-7** `GET /files/view/:key` allowlist (`products-`,`branch-transfer-batches-`) — proof/evidence media public emas.
- **P1-8** `GET /analytics/reports/couriers` staff-only (`@Roles`) — market/customer/investor leak yopildi.
- **P1-9** `ReceiveExternalOrdersDto` + `PrintOrdersDto` validatsiya decoratorlari (external receive + printer endpointlari endi ishlaydi).
- **P1-10** Investor `calculateProfit` period dedup (double-payout yo'q) + test.
- **P1-11** Integration outbound `fetch`larga timeout (sync worker wedge yo'q).

### ⏳ Qolgan ishlar (deploydan oldin/keyin alohida)
- **P0-8 (infra qismi):** off-box backup cron + S3/MinIO target + Postgres/RabbitMQ HA — server-side sozlash kerak (script tayyor).
- **P1-4:** kuryer double-assignment race (ikki servis bo'ylab murakkab oqim — alohida ehtiyotkor ish).
- **P1-5:** PARTNER filial ownership/`per_order_share` UI/API — **latent** (hozir barcha filiallar OWNED, pul xatosi yo'q; partner-onboarding uchun mahsulot qarori kerak).
- **P1-12:** DLQ-depth + outbox-poison alerting + `SENTRY_DSN` yoqish — observability infra.
- **Frontend:** in-app notification inbox (7 endpoint) + activity-log viewer (4 endpoint) ulanishi — kattaroq feature ishi.
