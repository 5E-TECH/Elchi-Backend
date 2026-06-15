# Frontend ↔ Backend API Coverage Report

Backend: `docs/frontend/openapi.json` · Frontend: `/home/shodiyor/Desktop/Elchi-Frontend`

## Summary

- Backend operations (method+path): **241**
- Backend ops whose path the frontend references (path-level): **228**
- ❌ Backend ops with NO frontend reference at all: **13**
- ⚠️ Path wired but specific method missing (review): **3**
- 🔴 Frontend paths matching no backend route (stale/wrong): **0**
- Registry entries parsed: 189 · resolved call sites: 240 · unresolved dynamic calls: 0

Legend: `:p` = a dynamic path segment (id/token/etc).

## ❌ A. Missing in frontend (backend endpoints never referenced)

These backend capabilities have no matching path anywhere in the frontend. **This is the "qolib ketgan funksiyalar" list — add these.**

### Activity Log (4)
- `GET /activity-logs` — Audit-log feed (merged across services, enriched)
- `GET /activity-logs/actions` — Known audit action verbs (for filter dropdowns)
- `GET /activity-logs/entity/{entity_type}/{entity_id}` — Full history of one entity (merged across services)
- `GET /activity-logs/user/{user_id}` — Everything a user did (merged across services)

### File (1)
- `GET /files/view/{key}` — Public redirect to file URL for image/file viewing

### Identity (1)
- `GET /` — Gateway health check via identity service

### Notification (7)
- `POST /notifications/dispatch` — Manually dispatch a notification (admin/testing)
- `GET /notifications/inbox` — Current user's notification inbox
- `GET /notifications/inbox/{id}` — Get one of my notifications
- `DELETE /notifications/inbox/{id}` — Delete one of my notifications
- `PATCH /notifications/inbox/{id}/read` — Mark one of my notifications read (or unread)
- `PATCH /notifications/inbox/read-all` — Mark all my notifications read
- `GET /notifications/inbox/unread-count` — Current user unread notification count

## ⚠️ B. Method gaps (path is used, but this method is not wired)

The frontend knows the path but the specific HTTP method below was not found at any resolved call site. Could be: not implemented yet, or wired via an unresolved/dynamic call. Verify each.

### Analytics
- `GET /analytics/dashboard` — Dashboard statistics by requester role
- `GET /analytics/revenue` — Revenue stats by period

### Webhooks
- `POST /webhooks/{slug}` — Inbound provider webhook (HMAC-verified downstream, no JWT)

## 🔴 C. Stale / wrong frontend paths (no backend match)

These paths exist in the frontend (registry or inline calls) but match **no** backend route. Likely renamed, removed, or wrong — fix or delete.

_None._
## D. Unresolved dynamic calls (could not determine path)

Call sites where the path is a variable/expression the audit could not statically resolve. Review manually if coverage looks off.

_None._