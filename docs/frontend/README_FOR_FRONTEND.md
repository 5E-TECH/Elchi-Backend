# README — Build the Elchi frontend against this backend

> **You (the AI agent) are given three files in `docs/frontend/`:**
> 1. `README_FOR_FRONTEND.md` — this file (the build order & rules).
> 2. `FRONTEND_INTEGRATION_GUIDE.md` — the full business + API contract.
> 3. `openapi.json` — the machine-readable schema (183 routes, 86 DTOs).
>
> Your job: make the frontend cover **every** backend capability and work
> end-to-end against this API. Do not invent endpoints — everything you need is
> in `openapi.json` + the guide. If a shape is unclear, the schema wins.

## What this backend is
Elchi is a courier/logistics + cash-on-delivery (COD) settlement platform.
Markets create orders → couriers deliver → cash settles back up the chain
(courier → branch → HQ → market), reconciled per order. Multiple roles, each a
distinct app surface. Read §1 and §6–§8 of the guide before writing UI.

## Hard rules
1. **One backend surface: the API Gateway.** Base URL `https://api.elchipochta.uz`
   (prod) / `http://localhost:3004` (dev). Never call services directly.
2. **Auth:** `Authorization: Bearer <accessToken>` on every authed request.
   Access token comes from `POST /auth/login` body. Refresh token is an
   **httpOnly cookie** — call `POST /auth/refresh` with `credentials: 'include'`.
   Implement **401 → refresh once → retry → else login**.
3. **Response envelope:** unwrap `{ statusCode, message, data }` → use `data`.
   Some endpoints return binary (exports, files, printer) — don't JSON-parse those.
4. **Strict bodies:** the gateway rejects unknown fields (`400`). Send only
   fields defined in `openapi.json` for that operation.
5. **Roles drive the UI.** Decode the JWT (`roles`, `branch_id`) for menus, but
   the server enforces access — client gating is UX only. Use the role→endpoint
   matrix in §11 of the guide to build each role's navigation.
6. **Enums are contracts.** Put every enum from §5 of the guide in one shared
   module and drive badges/filters/state-machines from them.

## Recommended build order
1. **API layer first.** Generate types from the schema, then build a typed client:
   ```bash
   npx openapi-typescript docs/frontend/openapi.json -o src/api/schema.d.ts
   ```
   Wrap fetch with: base URL, bearer injection, envelope unwrap, 401-refresh-retry,
   error normalization (handle 400/401/403/404/409/429/504).
2. **Auth & session.** Login, validate-on-load (`GET /auth/validate`), profile,
   logout, role-based routing/guards.
3. **Shared UI primitives.** Enum constants, status badges, paginated table,
   filter bar (`page/limit/search/status/from/to`), QR scanner screen
   (`GET /scan/{token}` dispatch), file upload helper (`POST /files/upload` →
   key → signed URL via `GET /files/{key}`).
4. **Per-domain features**, following the build checklist in §13 of the guide:
   Orders → Settlement → Finance → Branches/Transfer batches → Logistics/Posts →
   Products → Investors → Integrations → Notifications → Analytics → Search/Export/
   Printer.
5. **Realtime.** Connect Socket.IO `/realtime` with the JWT; live-update lists
   already loaded via REST. Handle dynamic `event` names; also wire chat/presence
   if the product needs it. (Guide §9.)
6. **Per-role app shells.** Assemble menus/dashboards per role from the matrix
   (§11) and `GET /analytics/dashboard` (role-aware).

## Coverage targets (don't skip these — they're easy to miss)
- All **order create paths** (manual, telegram bot, external/provider, operator bulk).
- Courier **sell/cancel with mandatory proof media** when the market's
  expense-proof conditions match (guide §5).
- **Settlement** screens for all three legs + per-order settlement status.
- **Transfer batch** full lifecycle (create/send/receive/partial-receive/cancel/return).
- **Finance**: cashboxes per role, shifts, salaries, financial ledger, operator payouts.
- **Exports** (`.xlsx`), **printer** (thermal label + A4 receipt), **files** (PDF/QR gen).
- **Integrations**: provider sync, receivables/remittances, dispatch.

## Keeping in sync
When the backend changes, regenerate the schema:
```bash
npm run openapi:generate   # → docs/frontend/openapi.json
```
Then re-run your type generation. The guide's business sections (flows, money
model, role matrix) change rarely; the schema is the fast-moving contract.

## Auditing an EXISTING frontend (gap analysis)

If a frontend already exists and you want to find what's missing or wrong instead
of building from scratch, use the coverage audit:

```bash
# from the backend repo
npm run openapi:generate                 # refresh the contract
npm run audit:frontend [path/to/frontend]  # default: ../Elchi-Frontend
```
This writes **`docs/frontend/COVERAGE_REPORT.md`**, which classifies every
backend operation against the frontend's actual API calls:

- **❌ A. Missing in frontend** — backend endpoints the frontend never calls.
  *This is your "what to add" list.* Work through it by domain.
- **⚠️ B. Method gaps** — the path is used but a specific HTTP method (e.g. the
  `PATCH`/`DELETE` variant) isn't wired, or it's wired through a call the audit
  couldn't statically resolve. Verify each.
- **🔴 C. Stale / wrong frontend paths** — frontend calls that match **no**
  backend route (renamed/removed/typo'd, e.g. `cashbox/main` should be
  `finance/cashbox/main`, `user/{id}` should be `users/{id}`). Fix or delete.
- **D. Unresolved dynamic calls** — paths built from variables the audit can't
  resolve; review manually.

How the audit reads the frontend: it parses the central
`src/shared/api/endpoints.ts` registry **and** scans inline
`api.<method>('...')` call sites. So the cleanest fix workflow is:
1. Fix Section C first (correct the wrong paths in `endpoints.ts`).
2. Then add Section A endpoints to `endpoints.ts` + their hooks/screens, grouped
   by domain, using `openapi.json` for exact request/response shapes and the
   guide §11 for which role each belongs to.
3. Re-run `npm run audit:frontend` until A and C are empty (or intentionally
   waived). B should be reviewed item-by-item.

`:p` in the report means "a dynamic path segment" (id/token/etc).

## If something is ambiguous
Order of truth: **`openapi.json` (shapes)** → **the guide (meaning/roles/flows)**
→ ask the backend owner. Never guess an endpoint that isn't in the schema.
```
