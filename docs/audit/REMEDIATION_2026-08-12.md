# Audit Remediation — branch `fix/sprint0-audit-remediation`

**Date:** 2026-08-12 · **Base:** `dev` · **Commits:** 36

This branch remediates the findings from the production-readiness audit
(`PRODUCTION_READINESS_AUDIT_2026-06-11.md`, verdict NO-GO 48/100) and a
follow-up multi-agent unbounded-I/O sweep, and completes the decomposition of
the order-service god object.

## Verification (CI-equivalent, run locally)

| Gate | Status |
|---|---|
| TypeScript check — all 14 services | ✅ pass |
| Full unit suite (`npm run test:ci`) | ✅ 435/435 |
| Partner API tests | ✅ 33/33 |
| Build smoke (gateway / integration / order) | ✅ pass |
| Lint (`eslint --max-warnings 0`) | soft-fail in CI (`continue-on-error`); pre-existing `no-unsafe-enum-comparison` style warnings only — no new hard errors |
| gitleaks secret scan | job added in CI |

## Security

- **`a0c5769`** — Sprint 0: file IDOR closed (signed-URL private-key prefixes
  require staff roles; `DELETE` gated), CI gitleaks secret-scan job, deploy
  pre-migration backup + `trap ERR` rollback, `db-backup` sidecar, secret
  hardening + rotation runbook.
- **`e4f9c88`** — default-deny authentication: global `JwtAuthGuard` (`APP_GUARD`)
  + `@Public()` decorator; ~11 genuinely-public routes enumerated and marked.
- **`d34662f`** — server-side idempotency for manual transfers / spend / fill
  (deterministic dedup token, not client UUID) + partner `order.create` keyed
  per-partner (cross-partner collision fix).
- **`0d9bc06`** — block non-superadmin rollback of a `PARTLY_PAID` order
  (double-credit guard).

## Money integrity

- **`912e1aa`** — extract the pure status-machine + COD money math into
  `domain/` modules; the money-conservation test now imports the REAL
  `computeSaleLegs`.
- **`06ec86f`** — settlement amount DTOs reject negative / NaN / >2dp amounts.
- **`0101fdc`** — poison-outbox alerting + scheduled cashbox reconciliation
  (`db-reconcile` sidecar).

## Resilience

- **`a903214`** — **bound every downstream RPC with a timeout (159 sends).**
  Whether awaited or returned as an observable, an unbounded `client.send()`
  hangs the HTTP request forever when a downstream wedges. Tiered: 8s internal /
  60s file-blob / 65s provider-fetch. Lint-style guard spec prevents regressions.
- **`7d90e0c`** — raise the tier for batch (transfer-batch/post-dispatch, 120s)
  and partner-shipment (65s) RPCs — an 8s cap there premature-fails a
  legitimately-slow path and risks a duplicate side-effect (caught by the
  sweep's adversarial verify).
- **`324a37e`** — bound all 5 outbound Telegram fetches + the realtime emit
  (`AbortSignal.timeout` / `pipe(timeout)`), so a stalled third party can't
  wedge an RMQ consumer or the bot poll loops.
- **`231550a`** — process-level `unhandledRejection` / `uncaughtException`
  safety net.

## Performance

- **`6e11e71`** — hot-path partial indexes on the orders table.
- **`3599003`** — `allCashboxesTotal` sums balances in SQL (`SUM`) instead of
  loading every cashbox row into JS.
- **`d3c83af`** — `financialBalance` sums market cashboxes in SQL and stops
  returning the full (unbounded) list the frontend never used.
- **`e73f06f`** — cap the analytics date span so a pathological range can't load
  the whole orders table into memory.

## Observability

- **`bf5ae85`** — structured 5xx logs + `trace_id` envelope, Pino redaction of
  secrets/PII, bounded json-file log rotation.
- **`20952e6`** — validate `SENTRY_DSN`/`LOG_LEVEL`; warn when Sentry is off in prod.
- **`35ddc20`** — map a downstream RPC `TimeoutError` to **504 Gateway Timeout**
  (observably distinct from a 500).
- **`28d67ea`** — Prometheus `/metrics` on the gateway (prom-client): process/GC
  defaults + request-duration histogram + in-flight gauge (route-pattern labels).

## DevOps

- **`90d5633`** — the full (now-green) test suite is a blocking CI gate instead
  of swallowing failures.
- **`6742dd2`** — resource ceilings (mem/pids) on all 14 services + a real
  gateway healthcheck (generous ceilings: leak/fork guards, not a tight budget).
- **`0a9892c`** — guard against NEW migration-timestamp collisions (3 existing,
  benign, grandfathered).
- **`41aa488`** — scheduled activity-log retention prune (`db:prune-activity-logs`
  + `activity-log-prune` sidecar) for the previously-unbounded `activity_logs`.
- **`0e66550`** — worker liveness `/health` route (shared `registerLiveness`) +
  per-worker docker healthchecks, so Docker restarts a wedged worker (the
  gateway got its healthcheck earlier).
- **`a14b7a0`** — real project README (replacing NestJS boilerplate).

## Architecture — god-object decomposition

`apps/order-service/src/order-service.service.ts`: **9394 → 1704 lines**. The
former god object is now the read/query surface; write/money paths are focused,
independently-testable services. Each extraction is a behaviour-preserving move
verified by tsc + `nest build` (DI resolves) + the full suite.

| Commit | Service | Notes |
|---|---|---|
| `e3a2808` | `OrderAnalyticsService` | read-only reporting |
| `f27c102` | `BranchTransferBatchService` | self-contained (own queryRunners) |
| `4884c80` | `OrderSettlementService` | transaction-owning advance + reads; the transaction-*participant* writers deliberately stay with lifecycle |
| `4a65434` | `OrderLookupService` | shared side-effect-free resolvers + one warmed HQ cache |
| `0ba4f1e` | `OrderLifecycleService` | the mutation core (sell/cancel/rollback/return/update/...) + its settlement writers; boundary derived by transitive-closure analysis |
| `1b4542c` | consolidation | analytics resolvers routed onto `OrderLookupService` (dedup) |
| `ba83428` | `OrderCustodyService` | tracking/custody writers + renderers deduped out of query/lifecycle/transfer-batch (~550 lines) |

## Deferred (deliberate — reasons)

- **Secret rotation + git-history purge** — a destructive, outward-facing USER
  action; commands are ready in `SECRET_ROTATION_RUNBOOK.md`.
- **API versioning / response-envelope consistency** — breaks frontend contracts;
  needs coordination.
- **Analytics JS→SQL push-down (revenue/market/courier)** — money-report
  correctness change; needs a DB-backed equivalence test. The date-span cap
  bounds the memory risk in the meantime.
- **Finance sweep #4 (cashbox-IDs subquery)** — the money-history query is built
  from a `FindOptionsWhere`; a subquery/JOIN fix means rewriting it to a
  QueryBuilder — a real restructure risk for an IDs-only (light) load. Low
  urgency; left as-is.
