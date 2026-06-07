# Elchi Backend — Frontend Integration Guide

> **Purpose of this document.** This is the master contract between the Elchi
> backend and any frontend that consumes it. It is written to be handed to an AI
> coding agent (e.g. Claude) so it can build/adapt a frontend that covers **every**
> backend capability with no guesswork. Pair it with [`openapi.json`](./openapi.json)
> (the machine-readable schema for exact request/response shapes) and
> [`README_FOR_FRONTEND.md`](./README_FOR_FRONTEND.md) (the step-by-step build order).

**One sentence:** Elchi is a courier/logistics + COD (cash-on-delivery) settlement
platform. Markets create orders → couriers deliver them → cash flows back up the
chain (courier → branch → HQ → market) and is reconciled per-order. There are
multiple roles, each with a distinct app surface.

---

## 1. Architecture the frontend needs to know

- The backend is a **NestJS microservice system** (14 services). **The frontend
  only ever talks to the API Gateway** over HTTP REST. All inter-service
  communication (RabbitMQ) is invisible to the client.
- **Base URL (prod):** `https://api.elchipochta.uz`
- **Base URL (local dev):** `http://localhost:3004`
- **Swagger UI:** `GET /api` &nbsp;·&nbsp; **Raw OpenAPI:** `GET /api-json`
  (both HTTP Basic-Auth protected in production).
- **Realtime:** Socket.IO at namespace `/realtime` on the same host (see §9).
- **API surface size:** 183 routes / 228 operations across 18 domains. Full
  shapes are in `openapi.json`; this guide gives the business meaning.

### Domains (OpenAPI tags)
| Tag | Prefix(es) | What it covers |
|---|---|---|
| Auth | `/auth` | login, refresh, logout, my-profile, token validation |
| Identity | `/users`, `/admins`, `/couriers`, `/managers`, `/markets`, `/registrators` | user CRUD per role |
| Orders | `/orders` | order lifecycle, sell/cancel/return, settlement, scan-assign |
| Products | `/product` | market product catalog |
| Logistics | `/post`, `/region`, `/district` | posts (courier delivery batches), geo |
| Branch | `/branches`, `/transfer-batches` | branch tree, inter-branch transfer batches |
| Finance | `/finance` | cashboxes, payments, shifts, salaries, financial ledger |
| Investor | `/investors`, `/investments`, `/profits` | investor capital & profit shares |
| Integrations | `/integrations`, `/webhooks` | external provider (cargo/marketplace) sync |
| Notification | `/notifications` | telegram notification configs & sending |
| Analytics | `/analytics` | dashboards, KPIs, reports |
| File | `/files` | upload/download (MinIO), PDF & QR generation |
| Scan | `/scan` | resolve a scanned QR token to its entity |
| Search | `/search` | global search |
| Excel Export | `/export` | xlsx exports |
| Printer | `/printer` | thermal label PDF & A4 receipt |
| Health | `/health` | liveness / readiness |
| Webhooks | `/webhooks` | inbound provider callbacks (no JWT) |

---

## 2. Authentication & session

### Login
`POST /auth/login`
```json
// request
{ "phone_number": "+998900000000", "password": "0990" }
// response (201)
{ "accessToken": "eyJhbG..." }
```
- The **access token** is returned in the JSON body — store it in memory
  (or where your app keeps it) and send it as `Authorization: Bearer <token>`
  on every authenticated request.
- The **refresh token** is set as an **httpOnly cookie** named `refreshToken`
  (path `/auth`, `SameSite=None; Secure` in production). The browser sends it
  automatically; JS cannot read it. **You must call refresh with
  `credentials: 'include'`.**
- Access token lifetime ≈ `15m` (configurable). Refresh ≈ `7d`.

### Refresh
`POST /auth/refresh` (send `credentials: 'include'`; body optional fallback
`{ "refreshToken": "..." }` if cookies are unavailable, e.g. mobile webview)
→ returns a fresh `{ "accessToken": "..." }`.

**Recommended client behavior:** on any `401`, call `/auth/refresh` once; if it
succeeds, retry the original request with the new token; if it fails, route to login.

### Other auth endpoints
- `GET /auth/validate` → `{ statusCode, message, user: { id, username, name, phone_number, role, status } }`. Use to bootstrap the session on app load.
- `GET /auth/my-profile` / `PATCH /auth/my-profile` → current user's profile.
- `POST /auth/logout` → clears the refresh cookie.

### The JWT payload (what you can trust client-side)
The access token decodes to:
```ts
{ sub: string;           // user id
  username: string;
  roles: string[];       // e.g. ["courier"] — lowercase
  branch_id?: string|null // set for branch-scoped staff
}
```
Use `roles` to drive navigation/feature gating in the UI, but remember the
backend re-checks on every call — the client gate is UX only.

---

## 3. Roles (RBAC)

Canonical role values (always **lowercase** on the wire):

| Role | Meaning / typical app |
|---|---|
| `superadmin` | full system owner |
| `admin` | back-office administrator |
| `manager` | branch manager (branch-scoped, cash settlement with HQ) |
| `branch` | branch account (branch-scoped read/operations) |
| `registrator` | registration/back-office operator (order intake, posts) |
| `courier` | delivery courier (mobile app) |
| `market` | seller/merchant (creates products & orders, gets paid) |
| `market_operator` | operator that ingests orders on behalf of markets |
| `operator` | operator with commission earnings |
| `investor` | capital investor (read-only portfolio) |
| `customer` | end customer (minimal) |

The full **role → endpoint matrix** is in §11. Use it to build each role's menu.

---

## 4. Global conventions (apply to every endpoint)

### Response envelope
Most JSON endpoints return:
```json
{ "statusCode": 200, "message": "success", "data": <payload> }
```
`data` is the real payload (object, array, or paginated wrapper). A few endpoints
(file downloads, exports, printer, webhooks) return binary/redirects instead —
noted where relevant.

### Errors
Standard Nest/HTTP errors. Shape:
```json
{ "statusCode": 400, "message": "human readable or array of messages", "data": null }
```
- `400` validation (the gateway uses a strict `ValidationPipe`:
  `whitelist + forbidNonWhitelisted` → **unknown body fields are rejected**, so
  send only documented fields).
- `401` missing/expired token → try refresh. `403` role not allowed.
- `404` not found. `409` conflict (e.g. invariant violation). `429` rate limited.
- `504` `GatewayTimeoutException` — a downstream service didn't answer in time;
  safe to show "try again".

### Pagination
List endpoints accept `?page=&limit=` (and usually `?search=`, `?status=`, plus
date filters `from`/`to` where relevant). Check each operation in `openapi.json`
for its exact query params. Paginated payloads typically include the rows plus
`total`/`count` metadata — render from the actual shape returned.

### Tracing
The gateway echoes/accepts `x-request-id`. Send a UUID per request if you want
end-to-end trace correlation in logs; otherwise one is minted for you.

### Rate limiting
Global ~60 req/min per IP; auth endpoints (`login`/`refresh`) stricter (~10/min).
Handle `429` gracefully.

### IDs & money
- IDs are strings. Treat all IDs as opaque strings.
- Money/amounts are numbers in the smallest practical unit used by the API
  (UZS). Do not assume cents; mirror what the API returns. Always format on display.

---

## 5. Enums & state machines (drive your UI from these)

These come from `libs/common/enums`. Hard-code them in a shared `constants` file
on the frontend (or generate from `openapi.json`).

### Order status — `Order_status`
```
created · new · received · on the road · waiting · waiting_customer ·
sold · cancelled · returned_to_market · paid · partly_paid ·
cancelled (sent) · closed
```
Typical happy path: `new → received → on the road → sold`.
Failure/return paths branch to `cancelled`, `returned_to_market`, etc. Use
`GET /orders/{id}/tracking` to render the actual history timeline.

### Settlement status (per order) — `SettlementStatus`
```
pending → courier_settled → branch_settled → market_settled
```
Tracks how far COD cash has flowed back up the chain for that order. See §7.

### Post status — `Post_status`
`new · sent · received · canceled · canceled_received`

### Branch transfer batch status — `BranchTransferBatchStatus`
`PENDING · SENT · RECEIVED · CANCELLED` (direction `FORWARD` | `RETURN`).

### Cashbox type — `Cashbox_type`
`main · couriers · markets · branch`

### Payment method — `PaymentMethod`
`cash · click · click_to_market`

### Where deliver — `Where_deliver`
`center` (pickup point) · `address` (door delivery)

### Branch type / ownership / courier compensation
- `BranchType`: `HQ · PICKUP · REGIONAL · HYBRID`
- `BranchOwnership`: `owned` (HQ branch, remits full COD) · `partner` (keeps its share)
- `CourierCompensationMode`: `salary_only · per_order · salary_plus_per_order`

### Financial ledger source — `FinancialSource_type`
`sell_profit · manual_income · manual_expense · salary · correction · bills`

### Expense-proof conditions — `ExpenseProofCondition`
A market can require photo/video proof for sell/cancel under conditions:
`sell_any · sell_extra_cost · sell_zero_total · cancel_any · cancel_extra_cost · cancel_zero_total`
(set via `PATCH /markets/{id}/expense-proof`). When a condition matches, the
courier sell/cancel call **must** include file proof or it is rejected — the UI
must capture media in those cases.

---

## 6. Core business flow: the order lifecycle

This is the spine of the product. Build the order screens around it.

1. **Create** — a market (or registrator/market_operator, or telegram bot, or
   external integration) creates an order.
   - `POST /orders` (manual), `POST /orders/telegram/bot/create`,
     `POST /orders/external` + `POST /orders/external/receive` (provider feed),
     `POST /orders/receive` (market_operator bulk intake).
2. **Intake / routing** — orders get grouped and routed through branches via
   **transfer batches** (§8) and assigned to couriers.
   - Manager bulk-assign: `POST /orders/assign-to-courier`.
   - Courier self-assign by scanning QR: `POST /orders/scan-assign`.
3. **Delivery (post)** — couriers carry orders as **posts** (delivery batches).
   See Logistics (§ posts) for send/receive/reassign/cancel.
4. **Outcome (courier records it):**
   - **Sell:** `POST /orders/sell/{id}` — delivered & paid. May require expense
     proof (see §5). Records COD + creates per-order settlement (§7).
   - **Partly sell:** `POST /orders/partly-sell/{id}`.
   - **Cancel:** `POST /orders/cancel/{id}`.
   - **Could not deliver:** `POST /orders/{id}/could-not-deliver`.
5. **Return path:**
   - `POST /orders/{id}/initiate-return` (HQ/courier/manager) →
   - `POST /orders/{id}/mark-returned-to-market` (registrator/admin).
6. **Rollback / correction:** `POST /orders/rollback/{id}` reverses a
   sold/cancelled order back to a prior state (settlement-aware — it unwinds the
   money too).
7. **Read/track:** `GET /orders`, `GET /orders/{id}`, `GET /orders/{id}/tracking`,
   `GET /orders/qr-code/{token}`, market/branch-scoped list endpoints.

**Settlement view:** `GET /orders/{id}/settlement` returns where that order's
cash currently sits in the chain.

---

## 7. Core business flow: COD settlement & money model

Cash collected on delivery flows **courier → branch → HQ → market**, reconciled
**per order, FIFO** as lump-sum payments are recorded:

- `POST /orders/settlement/courier-to-branch` — courier hands cash to branch.
- `POST /orders/settlement/branch-to-hq` — branch remits to HQ.
- `POST /orders/settlement/hq-to-market` — HQ pays the market.

Each payment is a lump sum; the backend allocates it across that party's
outstanding orders oldest-first and advances each order's `SettlementStatus`.

**Who keeps what** is config-driven:
- A **courier's** share per order depends on `CourierCompensationMode`
  (`salary_only` keeps 0 and owes full COD up; `per_order` keeps the tariff; etc.).
- A **branch's** share depends on `BranchOwnership` (`owned` remits everything;
  `partner` keeps `per_order_share`).

**Finance side (cashboxes & ledger):**
- Cashboxes are per-entity wallets (`main`, per-courier, per-market, per-branch).
  Read: `GET /finance/cashbox/*` (my-cashbox, main, all-info, by user, manager
  settlement, payable-to-hq, financial balance).
- Record payments: `POST /finance/cashbox/payment/courier`,
  `.../payment/market`, `.../payment/branch-to-main`.
- Adjust main cashbox: `PATCH /finance/cashbox/fill` / `.../spend` / `.../balance`.
- **Financial ledger** (company P&L): `GET /finance/financial-balance/history`,
  `POST /finance/financial-balance/entries` (manual income/expense/bills/salary/correction).
- **Shifts:** `POST /finance/shift/open` / `.../close`, `GET /finance/shift`.
- **Salaries:** `POST|PATCH /finance/salary`, `GET /finance/salary/{user_id}`.
- **Operator earnings:** `GET /finance/operators/{id}/earnings|payments|balance`,
  `POST /finance/operator-payments`.

> The cashbox system has a money **invariant** the backend enforces; the UI just
> records operations and reads balances — never tries to "fix" balances directly
> except via the documented fill/spend/balance endpoints.

---

## 8. Core business flow: branches & transfer batches

Branches form a **tree** (HQ → regional → pickup, etc.). Orders move between
branches in **transfer batches** (QR-coded), forward and return.

- **Branch tree/CRUD:** `GET /branches`, `/branches/tree`,
  `/branches/{id}` (+ descendants, users, config, analytics),
  `POST|PATCH|DELETE /branches/...`.
- **Branch config** (key/value per branch): `GET|POST|PATCH|DELETE /branches/{id}/config[/{key}]`.
  This is where ownership/compensation/per-order-share settings live.
- **Branch users:** `GET|POST|DELETE /branches/{id}/users[/{userId}]`
  (roles: `MANAGER`, `REGISTRATOR`, `COURIER`).
- **Transfer batches:**
  - Create from requester's branch: `POST /branches/transfer-batches` (by `order_ids`).
  - Return batches grouped by origin: `POST /branches/{id}/return-batches`.
  - Dispatch an HQ post to a branch: `POST /branches/posts/{postId}/dispatch`.
  - Lifecycle: `PATCH /transfer-batches/{id}/send` (vehicle info) →
    `POST /transfer-batches/{id}/receive` or `/receive-orders` (partial) →
    `POST /transfer-batches/{id}/cancel`.
  - Read: `GET /transfer-batches`, `/{id}`, `/{id}/remaining`,
    `GET /branches/with-sent-batches`, `GET /branches/new-orders`.

---

## 9. Realtime (Socket.IO)

Connect to namespace **`/realtime`** with the JWT:
```js
import { io } from 'socket.io-client';
const socket = io(`${BASE_URL}/realtime`, {
  auth: { token: accessToken },           // or Authorization: Bearer header
  withCredentials: true,
});
```
- On connect the server emits `connected` `{ user_id, roles }`. Unauthorized
  sockets receive `error` and are disconnected.
- The socket auto-joins rooms `user:<id>` and `role:<role>`.

**Events you receive (server → client push):** event names are dynamic — any
backend service can push `{ event, payload }` to a user, a role, or broadcast.
Treat the event name as a string key and handle the ones your UI cares about
(order updates, new orders, notifications). Listen broadly and route by event name.

**Client → client (built-in):**
- `chat:send` `{ to_user_id, text }` → recipient (and your other tabs) get
  `chat:message` `{ from_user_id, to_user_id, text, ts }`.
- `presence:list` → `{ online_user_ids: [...] }`.

Realtime is **best-effort** (offline recipient = no-op). Always also fetch state
over REST on screen load; use sockets to live-update.

---

## 10. Special flows & non-JSON endpoints

### File upload / download (MinIO)
- `POST /files/upload` — `multipart/form-data`, field `file`. Returns a key.
- `GET /files/{key}` — returns a **signed URL** (time-limited) for the object.
- `DELETE /files/{key}`.
- `POST /files/pdf`, `POST /files/qr` — generate a PDF / QR and store it.
- Max size and signed-URL TTL are server-configured (default 10 MB / 3600 s).
- For courier **proof media** on sell/cancel (see §5), upload first then pass the
  resulting key(s) in the sell/cancel request body.

### Excel export (binary `.xlsx`)
`GET /export/orders.xlsx`, `/export/cashbox-history.xlsx`, `/export/shifts.xlsx`
(with the same filter query params as their list endpoints). Trigger as a file
download; don't try to JSON-parse the response.

### Printer
- `POST /printer/thermal-pdf` — 100×60 mm thermal label PDF (Gainscha GS-2408D).
- `POST /printer/receipt` — A4 sheet, 12 receipts/page, auto-print in browser.
Returns printable PDF/HTML; open in a print view.

### Scan / QR
`GET /scan/{token}` resolves any scanned QR to its entity (order / post /
transfer-batch) so a single scanner screen can dispatch to the right detail view.
Order-specific: `GET /orders/qr-code/{token}`. Post check: `POST /post/check/{id}`.

### Search
`GET /search?...` — global search across entities. Use for the top search bar.

### Integrations & inbound webhooks
- Manage providers: `GET|POST|PATCH|DELETE /integrations[...]`, healthcheck/test,
  sync (`POST /integrations/{id}/sync`, `/retry`, `/sync/queue`, history),
  receivables & remittances (`/receivables`, `/{id}/receivable-balance`,
  `/{id}/remittances`).
- Dispatch an order to a provider: `POST /integrations/{slug}/dispatch`;
  universal calls: `/{slug}/request`, `/{slug}/search-by-qr`.
- **Inbound webhooks** `POST /webhooks/{slug}` are **provider→backend only**
  (HMAC-verified downstream, no JWT). The frontend does not call these.

### Notifications (Telegram)
`GET|POST|PATCH|DELETE /notifications`, connect a group by token
(`POST /notifications/connect-by-token`), send (`POST /notifications/send`).

### Analytics
`GET /analytics/dashboard` (role-aware), `/kpi`, `/revenue`,
`/reports/orders|couriers|finance`. Use for dashboards per role.

---

## 11. Role → endpoint matrix

`(any-auth)` = any authenticated user (no role restriction at the gateway, or the
handler decides by requester role internally). `(public)` = no auth (webhooks,
login, health). Roles listed are those allowed by the gateway's `@Roles` guard.
**This is the source of truth for building each role's menu.** For exact
request/response shapes of any line, look up the path in `openapi.json`.

### superadmin / admin (back-office — the widest surface)
Everything in Identity (`/admins`, `/couriers`, `/managers`, `/markets`,
`/registrators`, `/users`, status), Branch (full CRUD + config + users + transfer
batches), Finance (cashboxes, payments, salary, shifts, ledger, operators),
Investor (investors/investments/profits), Integrations (full), Notification
(full), Logistics admin ops (regions/districts, post reassign/receive, return
requests approve/reject), Orders (read/update/return/settlement hq-to-market),
Analytics, Excel, Products (list/update/delete). `superadmin` additionally:
`POST /registrators`, `DELETE /district/{id}`, `PATCH /post/{id}` (send post),
`POST /district/sato-match/apply`.

### manager (branch-scoped)
- Finance: `GET /finance/cashbox/manager/settlement`, `.../manager/payable-to-hq`,
  `.../financial-balanse`, `.../my-cashbox`, `.../user/{id}/main`, `GET /finance/history`,
  `PATCH /finance/cashbox/fill`, `POST /finance/cashbox/payment/market`,
  operator earnings/payments.
- Orders: `POST /orders/settlement/hq-to-market`, cancel/partly-sell/rollback,
  initiate-return; `GET /orders/{id}/tracking`.
- Identity: list `/markets`, `/registrators`, `GET/PATCH/DELETE /users[...]`,
  `POST /managers`.
- Branch: read branch/tree-scoped + transfer batch send/receive/cancel/return,
  dispatch.
- Finance payment from courier (`POST /finance/cashbox/payment/courier`).

### branch
- Branch read (`GET /branches/{id}`, `/new-orders`), transfer batches
  (read + send/receive/cancel/return/dispatch), posts on-the-road/rejected,
  `GET /orders/{id}/tracking`.

### registrator
- Orders: `GET /orders`, `/external`, update (`PATCH /orders/{id}`),
  return mark, external receive, post orders.
- Logistics: `GET /region`, post receive/reassign, return-requests approve/reject,
  cancel-receive check.
- Finance: shifts (`GET /finance/shift`, open/close), salary create.
- Integrations: receivables, shipments, dispatch, request.
- Notification send. Branch transfer batches (shared branch-staff set).
- Products: update own (`PATCH /product/my/{id}`).

### courier (mobile)
- Posts: `GET /post/{id}`, `/courier/old-posts`, `/courier/rejected`,
  `/on-the-road`; receive order/post (`PATCH /post/receive/order/{id}`,
  `/receive/scan/{id}`, `/receive/{id}`), cancel post (`POST /post/cancel`,
  `/cancel/receive/{id}`), check posts.
- Orders: `POST /orders/scan-assign`, `/assign-to-courier`, sell, partly-sell,
  cancel, could-not-deliver, rollback, initiate-return.
- Settlement: `POST /orders/settlement/courier-to-branch`,
  `POST /finance/cashbox/payment/courier`.

### market (merchant)
- Products: `GET /product`, `/my-products`, `/product/{id}`,
  `PATCH /product/my/{id}`, `POST /product`.
- Orders: create (`POST /orders/external` allowed for market too), list by market,
  markets/new, `GET /orders`.
- Finance: `POST /finance/cashbox/payment/courier` (as part of chain),
  `GET /finance/cashbox/my-cashbox`.

### market_operator
- `POST /orders/receive` (bulk intake on behalf of markets).

### operator
- Earns commission; surfaced via `/finance/operators/{id}/*` (read by admins).
  Operator-facing screens read their own earnings/balance.

### investor
- Read-only portfolio: investors/investments/profits are admin-managed; investor
  app reads its own investor record, investments, and profit shares.

> **Reading the full matrix programmatically:** the precise per-route role list
> was extracted from the gateway's `@Roles` decorators. If you need it as data,
> regenerate with the gateway controllers as the source of truth, or read each
> operation's `security`/description in `openapi.json` together with this section.

---

## 12. How to consume `openapi.json`

`openapi.json` is the authoritative schema: every path, method, parameter,
request body, and the 86 component schemas (DTOs). Recommended:

1. **Generate a typed client**: `openapi-typescript` (types) or
   `orval` / `openapi-generator` (types + hooks). Example:
   ```bash
   npx openapi-typescript docs/frontend/openapi.json -o src/api/schema.d.ts
   ```
2. Wrap fetch with: base URL, `Authorization` header injection, `401 → refresh →
   retry`, and envelope unwrapping (`res.data`).
3. Keep the enums from §5 in one module and reuse for badges, filters, and
   state-machine guards.
4. Regenerate the schema after backend changes: `npm run openapi:generate`
   (writes this file).

---

## 13. Build checklist (so nothing is missed)

- [ ] Auth: login, refresh-on-401, logout, profile, role-gated routing.
- [ ] Role-specific shells/menus per §11 (superadmin, admin, manager, branch,
      registrator, courier, market, market_operator, operator, investor).
- [ ] Orders: list+filters, detail, tracking timeline, create (all create paths),
      assign/scan-assign, sell/partly-sell/cancel/could-not-deliver (+proof media),
      return flow, rollback, settlement view.
- [ ] Settlement: courier→branch, branch→HQ, HQ→market screens + per-order status.
- [ ] Finance: cashboxes per role, payments, shifts, salaries, ledger, operators.
- [ ] Branches: tree, CRUD, config, users, transfer batches (full lifecycle), returns.
- [ ] Logistics: posts (send/receive/reassign/cancel), regions/districts, return requests.
- [ ] Products: market catalog + admin management.
- [ ] Investors / investments / profits.
- [ ] Integrations: providers, sync, receivables/remittances, dispatch.
- [ ] Notifications (Telegram), Analytics dashboards, Search, Excel exports, Printer, Files.
- [ ] Realtime socket wiring + live updates layered over REST.
- [ ] Global: envelope unwrap, error/429/504 handling, pagination, strict-body (no extra fields).
```
