# Frontend ↔ Backend API Coverage Report

Backend: `docs/frontend/openapi.json` · Frontend: `/home/shodiyor/Desktop/Elchi-Frontend`

## Summary

- Backend operations (method+path): **228**
- Backend ops whose path the frontend references (path-level): **227**
- ❌ Backend ops with NO frontend reference at all: **1**
- ⚠️ Path wired but specific method missing (review): **132**
- 🔴 Frontend paths matching no backend route (stale/wrong): **4**
- Registry entries parsed: 192 · resolved call sites: 112 · unresolved dynamic calls: 0

Legend: `:p` = a dynamic path segment (id/token/etc).

## ❌ A. Missing in frontend (backend endpoints never referenced)

These backend capabilities have no matching path anywhere in the frontend. **This is the "qolib ketgan funksiyalar" list — add these.**

### Identity (1)
- `GET /` — Gateway health check via identity service

## ⚠️ B. Method gaps (path is used, but this method is not wired)

The frontend knows the path but the specific HTTP method below was not found at any resolved call site. Could be: not implemented yet, or wired via an unresolved/dynamic call. Verify each.

### Analytics
- `GET /analytics/kpi` — KPI stats report
- `GET /analytics/reports/couriers` — Courier report
- `GET /analytics/reports/finance` — Finance report
- `GET /analytics/reports/orders` — Order report

### Auth
- `POST /auth/login` — Login with phone number and password
- `POST /auth/logout` — Logout current user
- `POST /auth/refresh` — Refresh access token
- `GET /auth/validate` — Validate current JWT token

### Branch
- `GET /branches/{id}/analytics/markets` — Branch market analytics (orders, delivered, total price)
- `GET /branches/{id}/config/{key}` — Get single branch config by key
- `GET /branches/{id}/descendants` — Get all descendants of a branch (flat list)
- `POST /branches/{id}/return-batches` — Create return batches grouped by original branch (direction=RETURN, QR=BTR-*)
- `GET /branches/new-orders` — Branches that currently have NEW orders
- `POST /branches/posts/{postId}/dispatch` — Dispatch HQ post to destination branch
- `GET /branches/tree` — Get full branch tree (nested)
- `POST /transfer-batches/{id}/cancel` — Cancel transfer batch and unassign its orders

### Excel Export
- `GET /export/cashbox-history.xlsx` — Kassa tarixini Excel (.xlsx) ga eksport qilish
- `GET /export/orders.xlsx` — Buyurtmalarni Excel (.xlsx) ga eksport qilish
- `GET /export/shifts.xlsx` — Smenalarni Excel (.xlsx) ga eksport qilish

### File
- `GET /files/{key}` — Get signed URL for file key
- `DELETE /files/{key}` — Delete file by key
- `POST /files/pdf` — Generate PDF and upload to MinIO
- `POST /files/qr` — Generate QR and upload to MinIO
- `POST /files/upload` — Upload file to MinIO (multipart/form-data)

### Finance
- `POST /finance/cashbox` — Create cashbox
- `GET /finance/cashbox/all-info` — Get all cashboxes total info
- `PATCH /finance/cashbox/balance` — Update cashbox balance and create history
- `GET /finance/cashbox/manager/payable-to-hq` — Managerdan HQga berilishi kerak summa
- `GET /finance/cashbox/manager/settlement` — Manager cashbox settlement (HQ bilan hisob-kitob)
- `GET /finance/cashbox/user/{id}/main` — Get cashbox by user ID with date filters
- `GET /finance/cashbox/user/{user_id}` — Find cashbox(es) by user
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

### Health
- `GET /health` — Liveness check — fast, gateway-only
- `GET /health/readiness` — Readiness check — pings every downstream service

### Identity
- `GET /admins` — List admins with filtering and pagination
- `GET /couriers/region/{id}` — List couriers by region id
- `GET /managers` — List managers with filtering and pagination
- `PATCH /markets/{id}/add-order` — Update market add_order (true/false)
- `PATCH /markets/{id}/expense-proof` — Set the situations in which this market requires file proof for sell/cancel
- `GET /registrators` — List registrators with filtering and pagination

### Integrations
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

### Investor
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

### Logistics
- `GET /district` — Get all districts
- `POST /district` — Create district
- `GET /district/{id}` — Get district by id
- `DELETE /district/{id}` — Delete district
- `PATCH /district/name/{id}` — Update district name
- `POST /district/sato-match/apply` — Apply matched district sato_codes
- `GET /district/sato-match/preview` — Preview district sato_code matching
- `PATCH /district/sato/{id}` — Update district sato_code
- `GET /district/sato/{satoCode}` — Get district by sato_code
- `GET /post` — List all posts (with pagination)
- `GET /post/{id}` — Get post by id
- `DELETE /post/{id}` — Delete post by id (superadmin only)
- `POST /post/check/{id}` — Check post order exists by qr token
- `POST /post/check/cancel/{id}` — Check canceled post order exists by qr token
- `POST /post/courier/{id}` — Get couriers by post id
- `GET /post/courier/old-posts` — Courier old posts
- `PATCH /post/reassign/{id}` — Reassign sent post to another courier
- `PATCH /post/receive/order/{id}` — Receive order (courier)
- `PATCH /post/receive/scan/{id}` — Receive post with scanner (courier)
- `POST /post/return-requests/approve` — Approve return requests
- `GET /post/return-requests/list` — List return requests grouped by courier
- `POST /post/return-requests/reject` — Reject return requests
- `GET /post/scan/{id}` — Get post by scanner
- `POST /region` — Create region
- `PATCH /region/{id}` — Update region
- `DELETE /region/{id}` — Delete region

### Notification
- `POST /notifications/connect-by-token` — Connect telegram group by group token
- `GET /notifications/health` — Notification service health check
- `POST /notifications/send` — Send notification to telegram group(s)

### Orders
- `PATCH /orders/{id}` — Update order (full fields, including items)
- `POST /orders/{id}/could-not-deliver` — Mark order as couldn't deliver (courier)
- `POST /orders/{id}/initiate-return` — Initiate order return (HQ)
- `POST /orders/{id}/mark-returned-to-market` — Mark order as returned to market (branch)
- `GET /orders/{id}/settlement` — Get the per-order settlement state
- `GET /orders/{id}/tracking` — Get order tracking history by ID
- `POST /orders/external` — Create external order
- `POST /orders/external/receive` — Receive orders from external integration payload
- `GET /orders/market/{marketId}` — List orders by market ID with pagination
- `GET /orders/markets/{marketId}/new` — NEW orders by market id
- `GET /orders/qr-code/{token}` — Get order by QR code (Post Control style)
- `POST /orders/receive` — Receive new orders
- `POST /orders/scan-assign` — Scan QR and assign order to current courier
- `POST /orders/settlement/branch-to-hq` — Settle a branch lump-sum remittance to HQ (FIFO per order)
- `POST /orders/settlement/courier-to-branch` — Settle a courier lump-sum payment to the branch (FIFO per order)
- `POST /orders/settlement/hq-to-market` — Settle an HQ lump-sum payment to a market (FIFO per order)
- `POST /orders/telegram/bot/create` — Create order by telegram bot

### Printer
- `POST /printer/receipt` — A4 chek (12 ta/varaq), brauzerda avto-print
- `POST /printer/thermal-pdf` — Termal etiketka PDF (100×60mm, Gainscha GS-2408D)

### Products
- `GET /product/health` — Catalog service health check
- `PATCH /product/my/{id}` — Update own product (market)

### Scan
- `GET /scan/{token}` — Resolve scanned QR token to order/batch/post

### Search
- `GET /search/health` — Search service health check

### Webhooks
- `POST /webhooks/{slug}` — Inbound provider webhook (HMAC-verified downstream, no JWT)

## 🔴 C. Stale / wrong frontend paths (no backend match)

These paths exist in the frontend (registry or inline calls) but match **no** backend route. Likely renamed, removed, or wrong — fix or delete.

- `finance/cashbox-type`  ←  registry: API_ENDPOINTS.FINANCE.CASHBOX_TYPE
- `finance/operation-type`  ←  registry: API_ENDPOINTS.FINANCE.OPERATION_TYPE
- `finance/source-type`  ←  registry: API_ENDPOINTS.FINANCE.SOURCE_TYPE
- `operators`  ←  registry: API_ENDPOINTS.OPERATORS.BASE

## D. Unresolved dynamic calls (could not determine path)

Call sites where the path is a variable/expression the audit could not statically resolve. Review manually if coverage looks off.

_None._