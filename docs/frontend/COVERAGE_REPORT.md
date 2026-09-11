# Frontend ↔ Backend API Coverage Report

Backend: `docs/frontend/openapi.json` · Frontend: `/home/shodiyor/Desktop/Elchi-Frontend`

## Summary

- Backend operations (method+path): **268**
- Backend ops whose path the frontend references (path-level): **254**
- ❌ Backend ops with NO frontend reference at all: **14**
- ⚠️ Path wired but specific method missing (review): **13**
- 🔴 Frontend paths matching no backend route (stale/wrong): **0**
- Registry entries parsed: 213 · resolved call sites: 269 · unresolved dynamic calls: 0

Legend: `:p` = a dynamic path segment (id/token/etc).

## ❌ A. Missing in frontend (backend endpoints never referenced)

These backend capabilities have no matching path anywhere in the frontend. **This is the "qolib ketgan funksiyalar" list — add these.**

### File (1)
- `GET /files/view/{key}` — Public view for whitelisted (catalog/batch) images

### Identity (1)
- `GET /` — Gateway health check via identity service

### Orders (4)
- `GET /orders/branch/orders` — Branch tomonidan qabul qilingan va hali HQga yuborilmagan canceled orderlar
- `GET /orders/extra-cost-approvals` — List extra cost approval requests
- `POST /orders/extra-cost-approvals/{id}/approve` — Approve extra cost request
- `POST /orders/extra-cost-approvals/{id}/reject` — Reject extra cost request

### Partner (8)
- `GET /partner/districts` — Elchi tumanlari (region_id bo‘yicha)
- `POST /partner/markets` — Sotuvchi uchun Elchi market ochish (idempotent)
- `GET /partner/ping` — Partner API kalitini tekshirish (ping)
- `GET /partner/regions` — Elchi viloyatlari ro‘yxati
- `POST /partner/shipments` — Shipment yaratish (order.create), idempotent
- `GET /partner/shipments/{id}` — Shipment holati (status/tracking/cod)
- `POST /partner/shipments/{id}/cancel` — Shipment bekor qilish (yetkazilgan → 409)
- `GET /partner/tariff` — Yetkazish tarifi (market bo‘yicha, narx preview)

## ⚠️ B. Method gaps (path is used, but this method is not wired)

The frontend knows the path but the specific HTTP method below was not found at any resolved call site. Could be: not implemented yet, or wired via an unresolved/dynamic call. Verify each.

### Analytics
- `GET /analytics/dashboard` — Dashboard statistics by requester role
- `GET /analytics/revenue` — Revenue stats by period

### Identity
- `PATCH /markets/{id}/cancelled-handover-qr` — Update whether market cancelled-order handover requires market QR scan

### Notification
- `POST /notifications/dispatch` — Manually dispatch a notification (admin/testing)

### Orders
- `POST /orders/markets/{marketId}/cancelled/handover` — Selected CANCELLED orderlarni QR ruxsati bilan marketga topshirish

### Partners (admin)
- `POST /admin/partners` — Hamkor yaratish (API kalit BIR MARTA qaytadi)
- `GET /admin/partners` — Hamkorlar ro‘yxati (sirlarsiz)
- `PATCH /admin/partners/{id}` — Hamkor sozlamalari: webhook manzili/sekreti, IP ro'yxati, nom. API kalit BU YERDA o‘zgarmaydi — buning uchun rotate-key bor.
- `POST /admin/partners/{id}/rotate-key` — API kalitni yangilash (eski darhol ishlamaydi)
- `POST /admin/partners/{id}/status` — Hamkorni faollashtirish/o‘chirish
- `GET /admin/partners/webhooks` — Hamkor webhook outbox jurnali (yetkazilgan/kutilayotgan/xato)
- `POST /admin/partners/webhooks/{webhookId}/retry` — Muvaffaqiyatsiz webhookni qayta navbatga qo'yish va darhol urinib ko'rish

### Webhooks
- `POST /webhooks/{slug}` — Inbound provider webhook (HMAC-verified downstream, no JWT)

## 🔴 C. Stale / wrong frontend paths (no backend match)

These paths exist in the frontend (registry or inline calls) but match **no** backend route. Likely renamed, removed, or wrong — fix or delete.

_None._
## D. Unresolved dynamic calls (could not determine path)

Call sites where the path is a variable/expression the audit could not statically resolve. Review manually if coverage looks off.

_None._