# Frontend ↔ Backend API Coverage Report

Backend: `docs/frontend/openapi.json` · Frontend: `/home/shodiyor/Desktop/Elchi-Frontend`

## Summary

- Backend operations (method+path): **228**
- Backend ops whose path the frontend references (path-level): **119**
- ❌ Backend ops with NO frontend reference at all: **109**
- ⚠️ Path wired but specific method missing (review): **31**
- 🔴 Frontend paths matching no backend route (stale/wrong): **31**
- Registry entries parsed: 115 · resolved call sites: 116 · unresolved dynamic calls: 0

Legend: `:p` = a dynamic path segment (id/token/etc).

## ❌ A. Missing in frontend (backend endpoints never referenced)

These backend capabilities have no matching path anywhere in the frontend. **This is the "qolib ketgan funksiyalar" list — add these.**

### Analytics (4)
- `GET /analytics/kpi` — KPI stats report
- `GET /analytics/reports/couriers` — Courier report
- `GET /analytics/reports/finance` — Finance report
- `GET /analytics/reports/orders` — Order report

### Auth (1)
- `GET /auth/validate` — Validate current JWT token

### Branch (10)
- `GET /branches/{id}/analytics/markets` — Branch market analytics (orders, delivered, total price)
- `GET /branches/{id}/config` — Get branch config list
- `POST /branches/{id}/config` — Set branch config
- `GET /branches/{id}/config/{key}` — Get single branch config by key
- `PATCH /branches/{id}/config/{key}` — Update branch config by key
- `DELETE /branches/{id}/config/{key}` — Delete branch config by key (soft delete)
- `GET /branches/{id}/descendants` — Get all descendants of a branch (flat list)
- `GET /branches/new-orders` — Branches that currently have NEW orders
- `GET /branches/tree` — Get full branch tree (nested)
- `POST /transfer-batches/{id}/cancel` — Cancel transfer batch and unassign its orders

### Excel Export (3)
- `GET /export/cashbox-history.xlsx` — Kassa tarixini Excel (.xlsx) ga eksport qilish
- `GET /export/orders.xlsx` — Buyurtmalarni Excel (.xlsx) ga eksport qilish
- `GET /export/shifts.xlsx` — Smenalarni Excel (.xlsx) ga eksport qilish

### File (5)
- `GET /files/{key}` — Get signed URL for file key
- `DELETE /files/{key}` — Delete file by key
- `POST /files/pdf` — Generate PDF and upload to MinIO
- `POST /files/qr` — Generate QR and upload to MinIO
- `POST /files/upload` — Upload file to MinIO (multipart/form-data)

### Finance (18)
- `POST /finance/cashbox` — Create cashbox
- `PATCH /finance/cashbox/balance` — Update cashbox balance and create history
- `GET /finance/cashbox/manager/payable-to-hq` — Managerdan HQga berilishi kerak summa
- `GET /finance/cashbox/manager/settlement` — Manager cashbox settlement (HQ bilan hisob-kitob)
- `GET /finance/cashbox/user/{id}/main` — Get cashbox by user ID with date filters
- `POST /finance/financial-balance/entries` — Record a manual financial ledger entry (income/expense/bills/salary/correction)
- `GET /finance/financial-balance/history` — List financial balance ledger entries + current balance
- `GET /finance/health` — Finance service health check
- `POST /finance/operator-payments` — Record a payout to an operator
- `GET /finance/operators/{operator_id}/balance` — Operator earned/paid/balance summary
- `GET /finance/operators/{operator_id}/earnings` — List an operator earnings
- `GET /finance/operators/{operator_id}/payments` — List an operator payouts
- `POST /finance/salary` — Create salary row for user
- `PATCH /finance/salary` — Update salary row for user
- `GET /finance/salary/{user_id}` — Find salary by user id
- `GET /finance/shift` — Find shifts with filters
- `POST /finance/shift/close` — Close shift
- `POST /finance/shift/open` — Open shift

### Health (2)
- `GET /health` — Liveness check — fast, gateway-only
- `GET /health/readiness` — Readiness check — pings every downstream service

### Identity (2)
- `GET /` — Gateway health check via identity service
- `PATCH /markets/{id}/expense-proof` — Set the situations in which this market requires file proof for sell/cancel

### Integrations (14)
- `POST /integrations/{id}/healthcheck` — Integration connection test (ping/healthcheck)
- `GET /integrations/{id}/receivable-balance` — Provider's outstanding COD balance
- `POST /integrations/{id}/remittances` — Record a provider remittance and settle receivables
- `POST /integrations/{id}/retry` — Retry failed sync jobs for integration
- `POST /integrations/{id}/sync` — Start sync processing for integration
- `GET /integrations/{id}/sync-history` — Sync history by integration id
- `POST /integrations/{id}/sync/queue` — Create sync queue item
- `POST /integrations/{id}/test` — Integration connection test alias endpoint
- `POST /integrations/{slug}/dispatch` — Dispatch an order to this provider (create a shipment)
- `POST /integrations/{slug}/request` — Universal external request (any endpoint/method)
- `POST /integrations/{slug}/search-by-qr` — Universal QR search via integration config
- `GET /integrations/receivables` — List provider COD receivables
- `GET /integrations/shipments/{order_id}` — Get the provider shipment for an order
- `GET /integrations/sync/history` — Sync history list (pagination/filter/success rate)

### Investor (16)
- `POST /investments` — Create investment
- `GET /investments` — List investments
- `GET /investments/{id}` — Find investment by id
- `PATCH /investments/{id}` — Update investment
- `DELETE /investments/{id}` — Delete investment (soft delete)
- `POST /investors` — Create investor
- `GET /investors` — List investors (pagination + search + status)
- `GET /investors/{id}` — Find investor by id (with investments/profits)
- `PATCH /investors/{id}` — Update investor
- `DELETE /investors/{id}` — Delete investor (soft delete)
- `GET /investors/{investor_id}/investments` — List investments by investor
- `GET /investors/{investor_id}/profits` — List profit shares by investor
- `POST /profits` — Create profit share manually
- `GET /profits` — List profit shares
- `PATCH /profits/{id}/mark-paid` — Mark profit share as paid
- `POST /profits/calculate` — Calculate profit share by period and percentage

### Logistics (13)
- `POST /district/sato-match/apply` — Apply matched district sato_codes
- `GET /district/sato-match/preview` — Preview district sato_code matching
- `PATCH /district/sato/{id}` — Update district sato_code
- `GET /district/sato/{satoCode}` — Get district by sato_code
- `POST /post/check/{id}` — Check post order exists by qr token
- `POST /post/check/cancel/{id}` — Check canceled post order exists by qr token
- `POST /post/courier/{id}` — Get couriers by post id
- `PATCH /post/reassign/{id}` — Reassign sent post to another courier
- `PATCH /post/receive/order/{id}` — Receive order (courier)
- `PATCH /post/receive/scan/{id}` — Receive post with scanner (courier)
- `POST /post/return-requests/approve` — Approve return requests
- `POST /post/return-requests/reject` — Reject return requests
- `GET /post/scan/{id}` — Get post by scanner

### Notification (3)
- `POST /notifications/connect-by-token` — Connect telegram group by group token
- `GET /notifications/health` — Notification service health check
- `POST /notifications/send` — Send notification to telegram group(s)

### Orders (11)
- `POST /orders/{id}/could-not-deliver` — Mark order as couldn't deliver (courier)
- `POST /orders/{id}/initiate-return` — Initiate order return (HQ)
- `GET /orders/{id}/settlement` — Get the per-order settlement state
- `GET /orders/{id}/tracking` — Get order tracking history by ID
- `POST /orders/external/receive` — Receive orders from external integration payload
- `GET /orders/market/{marketId}` — List orders by market ID with pagination
- `POST /orders/scan-assign` — Scan QR and assign order to current courier
- `POST /orders/settlement/branch-to-hq` — Settle a branch lump-sum remittance to HQ (FIFO per order)
- `POST /orders/settlement/courier-to-branch` — Settle a courier lump-sum payment to the branch (FIFO per order)
- `POST /orders/settlement/hq-to-market` — Settle an HQ lump-sum payment to a market (FIFO per order)
- `POST /orders/telegram/bot/create` — Create order by telegram bot

### Printer (2)
- `POST /printer/receipt` — A4 chek (12 ta/varaq), brauzerda avto-print
- `POST /printer/thermal-pdf` — Termal etiketka PDF (100×60mm, Gainscha GS-2408D)

### Products (2)
- `GET /product/health` — Catalog service health check
- `PATCH /product/my/{id}` — Update own product (market)

### Scan (1)
- `GET /scan/{token}` — Resolve scanned QR token to order/batch/post

### Search (1)
- `GET /search/health` — Search service health check

### Webhooks (1)
- `POST /webhooks/{slug}` — Inbound provider webhook (HMAC-verified downstream, no JWT)

## ⚠️ B. Method gaps (path is used, but this method is not wired)

The frontend knows the path but the specific HTTP method below was not found at any resolved call site. Could be: not implemented yet, or wired via an unresolved/dynamic call. Verify each.

### Auth
- `POST /auth/login` — Login with phone number and password
- `POST /auth/logout` — Logout current user
- `POST /auth/refresh` — Refresh access token

### Branch
- `POST /branches/{id}/return-batches` — Create return batches grouped by original branch (direction=RETURN, QR=BTR-*)
- `POST /branches/posts/{postId}/dispatch` — Dispatch HQ post to destination branch

### Finance
- `GET /finance/cashbox/all-info` — Get all cashboxes total info
- `GET /finance/cashbox/user/{user_id}` — Find cashbox(es) by user

### Identity
- `GET /admins` — List admins with filtering and pagination
- `GET /couriers/region/{id}` — List couriers by region id
- `GET /managers` — List managers with filtering and pagination
- `PATCH /markets/{id}/add-order` — Update market add_order (true/false)
- `GET /registrators` — List registrators with filtering and pagination

### Logistics
- `GET /district` — Get all districts
- `POST /district` — Create district
- `GET /district/{id}` — Get district by id
- `DELETE /district/{id}` — Delete district
- `PATCH /district/name/{id}` — Update district name
- `GET /post` — List all posts (with pagination)
- `GET /post/{id}` — Get post by id
- `DELETE /post/{id}` — Delete post by id (superadmin only)
- `GET /post/courier/old-posts` — Courier old posts
- `GET /post/return-requests/list` — List return requests grouped by courier
- `POST /region` — Create region
- `PATCH /region/{id}` — Update region
- `DELETE /region/{id}` — Delete region

### Orders
- `PATCH /orders/{id}` — Update order (full fields, including items)
- `POST /orders/{id}/mark-returned-to-market` — Mark order as returned to market (branch)
- `POST /orders/external` — Create external order
- `GET /orders/markets/{marketId}/new` — NEW orders by market id
- `GET /orders/qr-code/{token}` — Get order by QR code (Post Control style)
- `POST /orders/receive` — Receive new orders

## 🔴 C. Stale / wrong frontend paths (no backend match)

These paths exist in the frontend (registry or inline calls) but match **no** backend route. Likely renamed, removed, or wrong — fix or delete.

- `branches/:p/employees`  ←  registry: API_ENDPOINTS.BRANCHES.EMPLOYEES
- `branches/:p/settings`  ←  registry: API_ENDPOINTS.BRANCHES.SETTINGS
- `branches/:p/settings/:p`  ←  registry: API_ENDPOINTS.BRANCHES.SETTING_BY_ID
- `cashbox-history/:p`  ←  registry: API_ENDPOINTS.CASHBOX_HISTORY.BY_ID
- `cashbox/main`  ←  registry: API_ENDPOINTS.CASHBOX.MAIN
- `cashbox/shift/close`  ←  registry: API_ENDPOINTS.CASHBOX.SHIFT_CLOSE
- `cashbox/shift/current`  ←  registry: API_ENDPOINTS.CASHBOX.SHIFT_CURRENT
- `cashbox/shift/history`  ←  registry: API_ENDPOINTS.CASHBOX.SHIFT_HISTORY
- `cashbox/shift/open`  ←  registry: API_ENDPOINTS.CASHBOX.SHIFT_OPEN
- `cashbox/user/:p`  ←  registry: API_ENDPOINTS.CASHBOX.USER_BY_ID
- `finance/cashbox-type`  ←  registry: API_ENDPOINTS.FINANCE.CASHBOX_TYPE
- `finance/operation-type`  ←  registry: API_ENDPOINTS.FINANCE.OPERATION_TYPE
- `finance/source-type`  ←  registry: API_ENDPOINTS.FINANCE.SOURCE_TYPE
- `identity/users`  ←  registry: API_ENDPOINTS.IDENTITY.USERS
- `integrations/external-orders`  ←  registry: API_ENDPOINTS.INTEGRATIONS.EXTERNAL_ORDERS
- `markets/:p`  ←  registry: API_ENDPOINTS.MARKETS.BY_ID
- `operators`  ←  registry: API_ENDPOINTS.OPERATORS.BASE
- `orders/external-orders`  ←  registry: API_ENDPOINTS.ORDERS.EXTERNAL_ORDERS
- `orders/external_orders`  ←  registry: API_ENDPOINTS.ORDERS.EXTERNAL_ORDERS_ALT
- `orders/mark-returned-to-market/:p`  ←  registry: API_ENDPOINTS.ORDERS.MARK_RETURNED_TO_MARKET
- `orders/returns`  ←  registry: API_ENDPOINTS.ORDERS.RETURNS_PENDING_MARKET_ALT
- `orders/returns/pending-market`  ←  registry: API_ENDPOINTS.ORDERS.RETURNS_PENDING_MARKET
- `packages/qr-code/:p`  ←  registry: API_ENDPOINTS.PACKAGES.QR_CODE
- `packages/receive/:p`  ←  registry: API_ENDPOINTS.PACKAGES.RECEIVE
- `post/qr-code/:p`  ←  registry: API_ENDPOINTS.POSTS.QR_CODE
- `region/name/:p`  ←  registry: API_ENDPOINTS.REGIONS.UPDATE_NAME
- `returns`  ←  registry: API_ENDPOINTS.RETURNS.BASE
- `returns/:p/mark-returned-to-market`  ←  registry: API_ENDPOINTS.RETURNS.MARK_RETURNED_TO_MARKET
- `user/:p`  ←  call: src/entities/user/api/userApi.ts
- `user/:p/:p`  ←  call: src/entities/user/api/userApi.ts
- `user/except-market`  ←  call: src/entities/user/api/userApi.ts

## D. Unresolved dynamic calls (could not determine path)

Call sites where the path is a variable/expression the audit could not statically resolve. Review manually if coverage looks off.

_None._